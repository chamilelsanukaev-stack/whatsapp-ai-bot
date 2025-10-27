import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meinerverifytoken";

// 📂 Wissensdatenbank laden
let kb = {};
try {
  kb = JSON.parse(fs.readFileSync("./kb.json", "utf8"));
  console.log("📘 Wissensdatenbank geladen mit", Object.keys(kb).length, "Einträgen");
} catch (err) {
  console.error("❌ Konnte kb.json nicht laden:", err);
}

// ✅ Webhook-Validierung (erforderlich für Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook bestätigt");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 📩 Webhook für eingehende WhatsApp-Nachrichten
app.post("/webhook", async (req, res) => {
  console.log("Incoming:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const text = message?.text?.body?.toLowerCase();

    if (!from || !text) return;

    // 🧠 Antwort aus Wissensdatenbank oder GPT holen
    let reply = getAnswerFromKB(text);
    if (!reply) {
      reply = await getAIAnswer(text);
    }

    // 💬 Antwort an WhatsApp senden + Debug
    const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply || "Test: Nachricht erhalten." },
      }),
    });

    const json = await resp.json();
    console.log("WA send result:", JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("❌ Fehler in webhook:", err);
  }
});

// 📘 Suche in Wissensdatenbank
function getAnswerFromKB(text) {
  text = text.toLowerCase();
  for (const [key, value] of Object.entries(kb)) {
    if (text.includes(key.toLowerCase())) return value;
  }
  return null;
}

// 🤖 Antwort von OpenAI holen
async function getAIAnswer(text) {
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Du bist ein Verkaufsassistent von EazyStep. Sei freundlich und informativ." },
          { role: "user", content: text },
        ],
      }),
    });

    const data = await resp.json();
    console.log("OpenAI Antwort:", JSON.stringify(data, null, 2));
    return data.choices?.[0]?.message?.content || "Entschuldigung, ich konnte das gerade nicht beantworten.";
  } catch (err) {
    console.error("OpenAI Fehler:", err);
    return "Fehler bei der Anfrage an die KI.";
  }
}

app.listen(10000, () => console.log("Webhook läuft auf Port 10000 🚀"));
