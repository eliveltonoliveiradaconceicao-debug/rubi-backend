require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { MercadoPagoConfig, PreApproval } = require("mercadopago");

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const app = express();
app.use(cors());
app.use(express.json());

const PLANS = {
  essencial_mensal: "51f9c6b5c3134a83bd953a775fa3282f",
  pro_mensal: "5b2a3c08002c4bfc90a1a35b3fa4a32f",
  black_mensal: "d024551670154b2fa8c9b22bb8544e63",
  essencial_anual: "51b85976dd354b4fb9e3e2487116caa9",
  pro_anual: "25ce3dd87a4742b091398822308d5b4f",
  black_anual: "8c982a7456854ee38c32bad21d23e98a"
};

app.post("/create-subscription", async (req, res) => {
  try {
    console.log("BODY RECEBIDO:", req.body);

    const { plan_key, email } = req.body;

    console.log("PLAN_KEY RECEBIDO:", plan_key);

    const plan_id = PLANS[plan_key];

    if (!plan_id) {
      console.log("Plano não encontrado no objeto PLANS");
      return res.status(400).json({ error: "Plano inválido" });
    }

    const preapproval = new PreApproval(client);

    const subscription = await preapproval.create({
  preapproval_plan_id: plan_id,
  payer_email: email,
  reason: "Assinatura RUBI",
  back_url: "https://rubidigital.base44.app/dashboard",
  status: "pending"
});

    res.json({ init_point: subscription.init_point });

  } catch (error) {
    console.error("ERRO MP:", error);
    res.status(500).json({ error: "Erro ao criar assinatura" });
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







