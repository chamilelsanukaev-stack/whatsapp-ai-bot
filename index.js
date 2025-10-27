import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.get("/", (_, res) => res.status(200).send("OK"));

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "meinverifytoken";
  if (req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text?.body?.trim() || msg.button?.text || "";
    console.log("Incoming text:", text);

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Du bist ein kurzer, präziser Support-Assistent von EazyStep. Max. 2 Sätze." },
          { role: "user", content: text || "Hallo" }
        ]
      })
    }).then(r => r.json());

    if (aiRes?.error) console.error("OpenAI error:", aiRes.error);

    const reply = aiRes?.choices?.[0]?.message?.content?.slice(0, 1000)
      || "Danke! Wir melden uns bald.";

    const sendRes = await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply }
      })
    }).then(r => r.json());

    console.log("WA send result:", sendRes);
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(200);
  }
});

app.listen(10000, () => console.log("Webhook läuft auf Port 10000"));
