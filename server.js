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
  essencial_mensal: process.env.MP_PLAN_ESSENCIAL_MENSAL || "51f9c6b5c3134a83bd953a775fa3282f",
  pro_mensal: process.env.MP_PLAN_PRO_MENSAL || "5b23ac08002c4bfc08a1a35b3fa43a2f",
  black_mensal: process.env.MP_PLAN_BLACK_MENSAL || "d024551670154b2fa8c9b22bb8544e63",
  essencial_anual: process.env.MP_PLAN_ESSENCIAL_ANUAL || "51b85976dd354b4fb9e3e2487116caa9",
  pro_anual: process.env.MP_PLAN_PRO_ANUAL || "25ce3dd87a4742b091398822308d5b4f",
  black_anual: process.env.MP_PLAN_BLACK_ANUAL || "8c982a7456854ee38c32bad21d23e98a",
};
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
    const { plan_key, email } = req.body || {};

    if (!plan_key || !email) {
      return res.status(400).json({ ok: false, error: "Campos obrigatórios: plan_key e email" });
    }

    const planId = PLANS[plan_key];
    if (!planId) {
      return res.status(400).json({
        ok: false,
        error: `plan_key inválido (${plan_key}). Válidos: ${Object.keys(PLANS).join(", ")}`
      });
    }

    // Busca o plano e pega o init_point (link de checkout)
    const { data } = await axios.get(
      `https://api.mercadopago.com/preapproval_plan/${planId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    if (!data?.init_point) {
      return res.status(400).json({
        ok: false,
        error: "Plano não retornou init_point. Confirme se esse ID é de preapproval_plan.",
        planId,
        mp: data
      });
    }

    return res.status(200).json({
      ok: true,
      plan_key,
      planId,
      redirect_url: data.init_point
    });
  } catch (err) {
    const status = err.response?.status || 500;
    return res.status(status).json({
      ok: false,
      error: "Falha ao obter init_point do plano",
      status,
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













