require("dotenv").config();

const express = require("express");
const cors = require("cors");

// ====== MERCADO PAGO ASSINATURAS (RUBI) ======
const axios = require("axios");

// 1) Coloque seus PLAN IDs aqui (ou pegue de ENV do Render)
const PLANS = {
  essencial_mensal: process.env.MP_PLAN_ESSENCIAL_MENSAL || "COLE_AQUI_O_ID",
  // exemplo:
  // pro_mensal: process.env.MP_PLAN_PRO_MENSAL || "COLE_AQUI_O_ID",
};

// 2) Configs obrigatórias
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // APP_USR-...
const FRONTEND_URL = process.env.FRONTEND_URL || "https://rubidigital.base44.app"; // seu Base44
const BACKEND_URL = process.env.BACKEND_URL || "https://rubi-backend.onrender.com"; // seu Render

function assertEnv() {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN não configurado no Render.");
}

function mpHeaders() {
  return {
    Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function mpGet(url) {
  return axios.get(`https://api.mercadopago.com${url}`, { headers: mpHeaders() });
}

async function mpPost(url, data) {
  return axios.post(`https://api.mercadopago.com${url}`, data, { headers: mpHeaders() });
}

/**
 * Detecta automaticamente se o plano é:
 * - NOVO: /subscriptions/v1/plans/{id}  -> criar em /subscriptions/v1/subscriptions com { plan_id }
 * - ANTIGO: /preapproval_plan/{id}      -> criar em /preapproval com { preapproval_plan_id }
 */
async function detectPlanType(planId) {
  // tenta NOVO
  try {
    await mpGet(`/subscriptions/v1/plans/${planId}`);
    return { type: "NEW", createPath: "/subscriptions/v1/subscriptions", planField: "plan_id" };
  } catch (e) {
    // continua
  }

  // tenta ANTIGO
  try {
    await mpGet(`/preapproval_plan/${planId}`);
    return { type: "OLD", createPath: "/preapproval", planField: "preapproval_plan_id" };
  } catch (e) {
    // se nenhum dos dois, é id errado/token errado/ambiente errado
  }

  return null;
}

function pickRedirectUrl(mpData) {
  return (
    mpData?.init_point ||
    mpData?.sandbox_init_point ||
    mpData?.checkout_url ||
    mpData?.url ||
    null
  );
}

// ✅ ROTA: Base44 envia { plan_key, email }
app.post("/api/assinaturas/criar", async (req, res) => {
  try {
    assertEnv();

    const { plan_key, email } = req.body || {};
    console.log("BODY RECEBIDO:", req.body);

    if (!plan_key || !email) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios: plan_key e email",
      });
    }

    const planId = PLANS[plan_key];
    if (!planId) {
      return res.status(400).json({
        ok: false,
        error: `plan_key inválido (${plan_key}). Chaves válidas: ${Object.keys(PLANS).join(", ")}`,
      });
    }

    const detected = await detectPlanType(planId);
    if (!detected) {
      return res.status(400).json({
        ok: false,
        error:
          "Não consegui validar esse PLAN_ID no Mercado Pago. Verifique: (1) ID do plano (2) token/conta correta (3) produção vs teste.",
        planId,
      });
    }

    const back_url = `${FRONTEND_URL}/assinatura/retorno`; // você pode mudar esse caminho no Base44
    const notification_url = `${BACKEND_URL}/api/webhooks/mercadopago`; // opcional

    // Payload mínimo aceito (evita o 400 Parameters passed are invalid)
    const payload = {
      [detected.planField]: planId,     // plan_id OU preapproval_plan_id
      payer_email: email,              // ⚠️ email -> payer_email
      reason: `RUBI - ${plan_key}`,     // obrigatório na maioria dos casos
      back_url,                        // obrigatório
      external_reference: email,        // ajuda no rastreio
      notification_url,                // opcional (mas recomendado)
    };

    console.log("CRIANDO ASSINATURA NO MP:", detected, payload);

    const { data } = await mpPost(detected.createPath, payload);

    const redirect_url = pickRedirectUrl(data);

    return res.status(200).json({
      ok: true,
      plan_key,
      planId,
      mp_type: detected.type,
      redirect_url, // ✅ o Base44 pode redirecionar pra cá
      mp: data,      // retorna tudo pra debug
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const mpData = err.response?.data;

    console.error("ERRO MP STATUS:", status);
    console.error("ERRO MP DATA:", JSON.stringify(mpData, null, 2));
    console.error("ERRO GERAL:", err.message);

    return res.status(status).json({
      ok: false,
      error: "Falha ao criar assinatura no Mercado Pago",
      status,
      mp: mpData || null,
      message: err.message,
    });
  }
});

// (Opcional) Webhook para você registrar pagamentos/assinaturas
app.post("/api/webhooks/mercadopago", (req, res) => {
  console.log("WEBHOOK MP:", req.body);
  res.sendStatus(200);
});

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// CACHE SIMPLES EM MEMÓRIA
const cache = {};
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24h

function calculateScore(business) {
  let score = 50;

  if (!business.website) score += 30;
  if (business.rating && business.rating < 4.0) score += 20;
  if (!business.formatted_phone_number) score -= 10;

  return Math.min(score, 100);
}

app.post("/api/prospect", async (req, res) => {
  try {
    const { niche, city, state, noWebsiteOnly, lowRatingOnly } = req.body;

    const cacheKey = `${niche}-${city}-${state}-${noWebsiteOnly}-${lowRatingOnly}`;

    if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) {
      return res.json(cache[cacheKey].data);
    }

    const query = `${niche} em ${city} ${state}`;

    const searchResponse = await axios.get(
      "https://maps.googleapis.com/maps/api/place/textsearch/json",
      {
        params: {
          query,
          key: GOOGLE_API_KEY
        }
      }
    );

    if (searchResponse.data.status !== "OK") {
      return res.json({ google_status: searchResponse.data.status });
    }

    const results = searchResponse.data.results;

    const detailedResults = await Promise.all(
      results.slice(0, 15).map(async (place) => {
        const details = await axios.get(
          "https://maps.googleapis.com/maps/api/place/details/json",
          {
            params: {
              place_id: place.place_id,
              fields:
                "name,formatted_phone_number,website,rating,formatted_address,business_status,geometry",
              key: GOOGLE_API_KEY
            }
          }
        );

        const business = details.data.result;

        business.score = calculateScore(business);

        return business;
      })
    );

    let filtered = detailedResults;

    if (noWebsiteOnly) {
      filtered = filtered.filter(b => !b.website);
    }

    if (lowRatingOnly) {
      filtered = filtered.filter(b => b.rating && b.rating < 4.0);
    }

    filtered.sort((a, b) => b.score - a.score);

    cache[cacheKey] = {
      timestamp: Date.now(),
      data: filtered
    };

    res.json(filtered);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro interno" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});









