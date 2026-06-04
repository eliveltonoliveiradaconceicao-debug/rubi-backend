require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ====== MERCADO PAGO ASSINATURAS (RUBI) ======
const axios = require("axios");

// 1) Coloque seus PLAN IDs aqui (ou pegue de ENV do Render)
const PLANS = {
  pro: {
    id: "5b2a3c08002c4bfc90a1a35b3fa4a32f",
    name: "RUBI Pro",
    price: 30
  }
};
  // exemplo:
  // pro_mensal: process.env.MP_PLAN_PRO_MENSAL || "COLE_AQUI_O_ID",

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

// ====== HEALTH (fora de qualquer rota) ======
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "backend online" });
});

// ====== CRIAR ASSINATURA (APENAS 1 ROTA) ======
app.post("/api/assinaturas/criar", async (req, res) => {
  try {
    const { plan_key, email } = req.body || {};
    if (!plan_key || !email) return res.status(400).json({ ok:false, error:"Campos obrigatórios: plan_key e email" });

    const plan = PLANS[plan_key];
    if (!plan) return res.status(400).json({ ok:false, error:`plan_key inválido (${plan_key}). Válidos: ${Object.keys(PLANS).join(", ")}` });

    const { data } = await axios.post(
      "https://api.mercadopago.com/preapproval",
      {
        reason: "RUBI Pro - Assinatura Mensal",
        external_reference: `RUBI_${email}`,
        payer_email: email,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: plan.price,
          currency_id: "BRL"
        },
        back_url: FRONTEND_URL,
        status: "pending"
      },
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );

    if (!data?.init_point) {
      return res.status(400).json({ ok:false, error:"Mercado Pago não retornou init_point.", mp:data });
    }

    return res.json({ ok:true, redirect_url: data.init_point, init_point: data.init_point });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok:false,
      error:"Erro ao criar assinatura",
      mp: err.response?.data || null,
      message: err.message
    });
  }
});

// ====== STATUS DA ASSINATURA (APENAS 1 ROTA) ======
app.get("/api/assinaturas/status", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    const plan_key = String(req.query.plan_key || "").trim(); // opcional

    if (!email) return res.status(400).json({ ok: false, error: "email é obrigatório" });

    const plan = plan_key ? PLANS[plan_key] : null;
    if (plan_key && !plan) {
      return res.status(400).json({
        ok: false,
        error: `plan_key inválido (${plan_key}). Válidos: ${Object.keys(PLANS).join(", ")}`
      });
    }

    const params = {
      payer_email: email,
      sort: "date_created",
      order: "desc",
      limit: 1
    };

    // se quiser filtrar pelo plano pro
    if (plan) params.preapproval_plan_id = plan.id;

    const { data } = await axios.get(
      "https://api.mercadopago.com/preapproval/search",
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }, params }
    );

    const last = data?.results?.[0] || null;
    const status = (last?.status || "none").toLowerCase();
    const active = status === "authorized" || status === "active";

    return res.json({ ok: true, email, plan_key: plan_key || null, active, status, preapproval_id: last?.id || null });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok: false,
      error: "Erro ao consultar status",
      mp: err.response?.data || null,
      message: err.message
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















