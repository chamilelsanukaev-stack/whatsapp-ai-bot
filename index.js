import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meinerverifytoken";
const STRICT_KB = process.env.STRICT_KB === "1";

// 📂 KB laden
let KB = {};
try {
  KB = JSON.parse(fs.readFileSync("./kb.json", "utf8"));
  console.log("📘 KB geladen:", Object.keys(KB));
} catch (e) {
  console.error("❌ kb.json fehlt/ungültig:", e);
}

// ✅ Webhook-Verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// 📩 Eingang
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = msg?.from;
    const text = (msg?.text?.body || msg?.button?.text || "").trim();
    if (!from || !text) return;

    console.log("Incoming:", text);

    // 1) KB-Antwort
    let reply = findAnswer(text);

    // 2) Falls KB-Treffer: schön formulieren (nur umschreiben, keine neuen Fakten)
    if (reply && process.env.OPENAI_API_KEY) {
      reply = await beautifyReply(reply);
    }

    // 3) Kein KB-Treffer: optional GPT-Fallback, aber nur basierend auf KB
    if (!reply && !STRICT_KB && process.env.OPENAI_API_KEY) {
      reply = await getAIAnswer(text);
    }

    if (!reply) reply = "Gern helfe ich zu EazyStep – frag z. B. nach Preis, Einbau oder Zuschuss.";

    // 4) Senden
    const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: String(reply).slice(0, 1000) }
      })
    });
    const json = await resp.json();
    console.log("WA send result:", JSON.stringify(json));
  } catch (e) {
    console.error("❌ Fehler webhook:", e);
  }
});

// ---------- KB-Matcher ----------
function findAnswer(input) {
  const t = input.toLowerCase();

  // Small talk
  if (/(^|\b)(hi|hallo|hey|guten\s*(tag|morgen|abend))\b/.test(t)) return "Hallo! Wie kann ich helfen?";
  if (/(wie\s*geht'?s|wie\s*gehts)/.test(t)) return "Alles gut – womit kann ich helfen?";
  if (/(wer\s*bist\s*du|was\s*bist\s*du)/.test(t)) return "Ich bin der EazyStep-Assistent 😊";

  // Produkt
  if (/(was\s*ist|eazystep|produkt|hilfe\s*im\s*bad)/.test(t)) return KB.produkt;

  // Kernfragen
  if (/(preis|kosten|wie\s*viel)/.test(t)) return KB.preise;
  if (/(liefer|versand|zustell|wie\s*lange)/.test(t)) return KB.lieferzeit;
  if (/(einbau|montage|install)/.test(t)) return KB.einbau;
  if (/(garantie|gewähr)/.test(t)) return KB.garantie;
  if (/(pflegekasse|zuschuss|pflegegrad)/.test(t)) return KB.pflegekasse;

  // Details
  if (/(vorteil|nutzen|sturz|sicher)/.test(t)) return "Vorteile: " + (KB.vorteile || []).join(", ");
  if (/(maß|groe|größe|abmess|passt)/.test(t)) return KB.masse;
  if (/(zahlung|raten|paypal|rechnung)/.test(t)) return KB.zahlung;
  if (/(teuer|preis\s*hoch)/.test(t)) return KB.einwaende?.teuer;
  if (/(platz|zu\s*groß|sperrig|passt\s*nicht)/.test(t)) return KB.einwaende?.platz;

  // Abschluss
  if (/(angebot|bestellen|kaufen|beratung)/.test(t)) return KB.abschluss;

  return null;
}

// ---------- GPT: Schön formulieren (nur Umformulierung) ----------
async function beautifyReply(text) {
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
          { role: "system", content: "Formuliere folgenden Produkttext von EazyStep freundlich, klar und vertriebsorientiert um, ohne Fakten zu verändern. Maximal 2 Sätze." },
          { role: "user", content: text }
        ]
      })
    });
    const data = await resp.json();
    if (data?.error) {
      console.error("OpenAI beautify error:", data.error);
      return text;
    }
    return data?.choices?.[0]?.message?.content || text;
  } catch {
    return text;
  }
}

// ---------- GPT-Fallback (benutzt NUR KB als Kontext) ----------
async function getAIAnswer(userText) {
  try {
    const context = JSON.stringify(KB);
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Du bist ein EazyStep-Berater. Antworte nur auf Basis des folgenden JSON (keine neuen Fakten). Max. 2 Sätze." },
          { role: "system", content: context },
          { role: "user", content: userText }
        ]
      })
    });
    const data = await r.json();
    if (data?.error) {
      console.error("OpenAI fallback error:", data.error);
      return null;
    }
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("OpenAI fetch error:", e);
    return null;
  }
}

app.listen(10000, () => console.log("Webhook läuft auf Port 10000 🚀"));
