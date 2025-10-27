import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (_, res) => res.status(200).send("OK"));

// Webhook verify (Meta)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "meinverifytoken";
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

// Incoming messages
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];

    if (!msg) {
      // Status-Updates oder andere Events
      return res.sendStatus(200);
    }

    const from = msg.from;
    const text = msg.text?.body?.trim() || msg.button?.text || "";
    console.log("Incoming:", { from, text });

    // 1) OpenAI fragen
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Du bist ein kurzer, präziser Support‑Assistent von EazyStep. Antworte in maximal 2 Sätzen." },
          { role: "user", content: text || "Hallo" }
        ]
      })
    }).then(r => r.json());

    const reply = aiRes?.choices?.[0]?.message?.content?.slice(0, 1000) || "Danke! Wir melden uns bald.";

    // 2) Antwort an WhatsApp senden (Meta Cloud API)
    const waRes = await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply }
      })
    }).then(r => r.json());

    console.log("WA send result:", waRes);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200);
  }
});

app.listen(10000, () => console.log("Webhook läuft auf Port 10000"));
