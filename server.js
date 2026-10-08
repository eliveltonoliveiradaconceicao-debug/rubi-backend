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

const crypto = require("crypto");

// ====== PIX (QR + COPIA E COLA) - RUBI PRO ======
app.post("/api/pix/criar", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, error: "email é obrigatório" });
    }

    // valor do seu plano Pro
    const amount = PLANS.pro.price; // 30

    // Idempotency-Key recomendado/obrigatório para evitar pagamentos duplicados
    // (Mercado Pago recomenda enviar X-Idempotency-Key) :contentReference[oaicite:2]{index=2}
    const idempotencyKey = crypto.randomUUID();

    const { data } = await axios.post(
      "https://api.mercadopago.com/v1/payments",
      {
        transaction_amount: amount,
        description: "RUBI Pro - Mensalidade (Pix)",
        payment_method_id: "pix",
        payer: { email },
        external_reference: `RUBI_PRO_PIX_${email}`,
        notification_url: `${BACKEND_URL}/api/webhooks/mercadopago` // opcional
      },
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey
        }
      }
    );

    const tx = data?.point_of_interaction?.transaction_data;

    return res.json({
      ok: true,
      payment_id: data?.id || null,
      status: data?.status || null,
      ticket_url: tx?.ticket_url || null,
      qr_code: tx?.qr_code || null, // copia e cola
      qr_code_base64: tx?.qr_code_base64 || null // imagem do QR
    });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok: false,
      error: "Erro ao criar Pix",
      mp: err.response?.data || null,
      message: err.message
    });
  }
});

app.get("/api/pix/status", async (req, res) => {
  try {
    const payment_id = String(req.query.payment_id || "").trim();
    if (!payment_id) {
      return res.status(400).json({ ok: false, error: "payment_id é obrigatório" });
    }

    const { data } = await axios.get(
      `https://api.mercadopago.com/v1/payments/${payment_id}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    return res.json({
      ok: true,
      payment_id,
      status: data?.status || null,          // approved | pending | rejected | etc
      status_detail: data?.status_detail || null
    });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok: false,
      error: "Erro ao consultar Pix",
      mp: err.response?.data || null,
      message: err.message
    });
  }
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
  const { niche, city, state, noWebsiteOnly = false, lowRatingOnly = false } = req.body || {};

  if (!GOOGLE_API_KEY) {
    return res.status(503).json({
      ok: false,
      code: "GOOGLE_PLACES_API_KEY_MISSING",
      error: "A chave GOOGLE_PLACES_API_KEY não está configurada no Render."
    });
  }

  if (![niche, city, state].every(v => typeof v === "string" && v.trim())) {
    return res.status(400).json({
      ok: false,
      code: "INVALID_SEARCH_INPUT",
      error: "Informe nicho, cidade e estado."
    });
  }

  const cacheKey = JSON.stringify({
    niche: niche.trim(), city: city.trim(), state: state.trim(),
    noWebsiteOnly: Boolean(noWebsiteOnly), lowRatingOnly: Boolean(lowRatingOnly)
  });

  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) {
    return res.json(cache[cacheKey].data);
  }

  try {
    const query = `${niche.trim()} em ${city.trim()} ${state.trim()}`;
    const searchResponse = await axios.get(
      "https://maps.googleapis.com/maps/api/place/textsearch/json",
      { params: { query, key: GOOGLE_API_KEY }, timeout: 15000 }
    );
    const searchData = searchResponse.data || {};
    const googleStatus = searchData.status;

    if (googleStatus === "ZERO_RESULTS") {
      cache[cacheKey] = { timestamp: Date.now(), data: [] };
      return res.json([]);
    }

    if (googleStatus !== "OK") {
      const explanations = {
        REQUEST_DENIED: "O Google recusou a solicitação. Confira a chave, a API Places habilitada e a conta de cobrança do Google Cloud.",
        OVER_QUERY_LIMIT: "A cota ou o limite de uso do Google Places foi excedido. Confira cotas e faturamento no Google Cloud.",
        INVALID_REQUEST: "A consulta enviada ao Google é inválida. Confira nicho, cidade e estado.",
        UNKNOWN_ERROR: "O Google retornou um erro temporário. Tente novamente."
      };
      console.error("Google Places Text Search status:", googleStatus, searchData.error_message || "");
      return res.status(502).json({
        ok: false,
        code: googleStatus || "GOOGLE_PLACES_ERROR",
        error: explanations[googleStatus] || "A API do Google Places não conseguiu concluir a busca.",
        google_status: googleStatus || "UNKNOWN",
        google_message: searchData.error_message || null
      });
    }

    const places = Array.isArray(searchData.results) ? searchData.results.slice(0, 20) : [];
    const detailResults = await Promise.allSettled(
      places.map(async (place) => {
        const response = await axios.get(
          "https://maps.googleapis.com/maps/api/place/details/json",
          {
            params: {
              place_id: place.place_id,
              fields: "name,formatted_phone_number,website,rating,formatted_address,business_status,geometry",
              key: GOOGLE_API_KEY
            },
            timeout: 15000
          }
        );
        const detailsData = response.data || {};
        if (detailsData.status !== "OK" || !detailsData.result) {
          throw new Error(`Place Details: ${detailsData.status || "UNKNOWN"}`);
        }
        const business = detailsData.result;
        business.score = calculateScore(business);
        return business;
      })
    );

    const failedDetails = detailResults.filter(item => item.status === "rejected");
    if (failedDetails.length) {
      console.error("Google Places Details failures:", failedDetails.length, "of", places.length);
    }

    let filtered = detailResults
      .filter(item => item.status === "fulfilled")
      .map(item => item.value);

    if (noWebsiteOnly) filtered = filtered.filter(b => !b.website);
    if (lowRatingOnly) filtered = filtered.filter(b => typeof b.rating === "number" && b.rating < 4.0);

    filtered.sort((a, b) => b.score - a.score);
    cache[cacheKey] = { timestamp: Date.now(), data: filtered };
    return res.json(filtered);
  } catch (error) {
    const googleStatus = error.response?.data?.status;
    console.error("Erro na prospecção Google Places:", googleStatus || error.code || error.message);
    return res.status(error.code === "ECONNABORTED" ? 504 : 502).json({
      ok: false,
      code: error.code || "PROSPECT_REQUEST_FAILED",
      error: "Não foi possível concluir a busca no Google Places. Confira a API, a cobrança e tente novamente.",
      google_status: googleStatus || null
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});















