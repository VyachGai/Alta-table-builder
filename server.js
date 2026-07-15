// server.js — статика + прокси к Claude API для Alta-TEST.
const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;                  // ключ — только на сервере
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const PROXY_SECRET = process.env.PROXY_SECRET || "";            // необязательная защита эндпоинта

// Документы (в т.ч. base64 сканов) бывают крупными — поднимаем лимит тела запроса
app.use(express.json({ limit: "25mb" }));

// Раздача статики (index.html, styles.css, app.js)
app.use(express.static(__dirname));

// Прокси к Claude API: ключ подставляется здесь и в браузер не попадает
app.post("/api/anthropic", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY не задан в переменных Railway" });
  }
  if (PROXY_SECRET && req.get("x-proxy-secret") !== PROXY_SECRET) {
    return res.status(401).json({ error: "Неверный proxy secret" });
  }

  try {
    const body = {
      model: req.body.model || MODEL,
      max_tokens: req.body.max_tokens || 4096,
      messages: req.body.messages || [],
    };
    if (req.body.system) body.system = req.body.system;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();
    res.status(r.status).json(data);           // прозрачно пробрасываем ответ и код
  } catch (err) {
    res.status(502).json({ error: "Ошибка обращения к Claude API: " + err.message });
  }
});

app.listen(PORT, () => console.log(`Alta-TEST запущен на порту ${PORT}`));
