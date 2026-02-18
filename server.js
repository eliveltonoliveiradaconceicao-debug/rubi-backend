require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

app.post("/api/prospect", async (req, res) => {
  try {
    const { niche, city, state } = req.body;

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

    console.log("Google Status:", searchResponse.data.status);
    console.log("Google Response:", searchResponse.data);

    if (searchResponse.data.status !== "OK") {
      return res.json({
        google_status: searchResponse.data.status,
        google_error: searchResponse.data.error_message || null
      });
    }

    const results = searchResponse.data.results;

    const detailedResults = await Promise.all(
      results.slice(0, 5).map(async (place) => {
        const details = await axios.get(
          "https://maps.googleapis.com/maps/api/place/details/json",
          {
            params: {
              place_id: place.place_id,
              fields:
                "name,formatted_phone_number,website,rating,formatted_address,business_status",
              key: GOOGLE_API_KEY
            }
          }
        );

        return details.data.result;
      })
    );

    res.json(detailedResults);
  } catch (error) {
    console.error("Erro geral:", error.response?.data || error.message);
    res.status(500).json({ error: "Erro ao buscar dados" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
