import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(express.json());

// Knowledge base laden
const KB = JSON.parse(fs.readFileSync("./kb.json", "utf8"));

// --- einfache Text-Erkennung ---
function findAnswer(text) {
  const t = text.toLowerCase();
  if (t.includes("preis") || t.includes("kosten")) return KB.preise;
  if (t.includes("liefer")) return KB.lieferzeit;
  if (t.includes("einbau") || t.includes("montage")) return KB.einbau;
  if (t.includes("garantie")) return KB.garantie;
  if (t.includes("pflegekasse")) return KB.pflegekasse;
  if (t.includes("vorteil") || t.includes("nutzen")) return "Vorteile: " + KB.vorteile.join(", ");
  if (t.includes("maß") || t.includes("größe")) return KB.masse;
  if (t.includes("zahlung") || t.includes("raten")) return KB.zahlung;
  if (t.includes("platz") || t.includes("passen")) return KB.einwaende.platz;
  if (t.includes("teuer")) return KB.einwaende.teuer;
  if (t.includes("produkt") || t.includes("was ist eazystep")) return KB.produkt;
  if (t.includes("angebot") || t.includes("bestellen")) return KB.abschluss;
  return null;
}

// Healthcheck
app.get("/", (_, res) => res.status(200).send("OK"));

// Verify Webhook (Meta)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "meinverifytoken";
  if (req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

// Hauptlogik – Nachrichten empfangen
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text?.body?.trim() || msg.button?.text || "";
    console.log("Incoming:", text);

    // 1️⃣ Antwort aus Wissensdatenbank
    let reply = findAnswer(text);

    // 2️⃣ Fallback: KI (wenn keine Antwort gefunden)
    if (!reply && process.env.OPENAI_API_KEY) {
      const context = JSON.stringify(KB);
      const ai = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Du bist ein freundlicher Vertriebsassistent von EazyStep. Antworte in maximal 2 Sätzen, korrekt nach diesen Fakten:",
            },
            { role: "system", content: context },
            { role: "user", content: text },
          ],
        }),
      }).then((r) => r.json());

      reply = ai?.choices?.[0]?.message?.content || "Danke! Wir melden uns bald.";
    }

    if (!reply) reply = "Danke! Wir melden uns bald.";

    // 3️⃣ Antwort an WhatsApp senden
    await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply },
      }),
    });

    res.sendStatus(200);
  } catch (e) {
    console.error("Error:", e);
    res.sendStatus(200);
  }
});

app.listen(10000, () => console.log("Webhook läuft auf Port 10000"));
