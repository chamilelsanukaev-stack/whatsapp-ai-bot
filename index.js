import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "meinerverifytoken";
const STRICT_KB = process.env.STRICT_KB === "1";

// ===== KB laden =====
let KB = {};
try {
  KB = JSON.parse(fs.readFileSync("./kb.json", "utf8"));
  console.log("📘 KB geladen mit Feldern:", Object.keys(KB));
} catch (e) {
  console.error("❌ kb.json nicht gefunden/ungültig:", e);
}

// ===== Utils =====
const deUmlaut = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");

const clean = (s) => deUmlaut(String(s || "").trim().replace(/[^\p{L}\p{N}\s]/gu, " ")).replace(/\s+/g, " ");

const within = (t, pats) => pats.some((p) => (p instanceof RegExp ? p.test(t) : t.includes(p)));

const limitLen = (s, n = 1000) => String(s || "").slice(0, n);

// ===== Intent-Definitionen =====
// Jede Intent hat: key, score, patterns (Synonyme/Regex), responder (holt Text aus KB)
const INTENTS = [
  {
    key: "greeting",
    weight: 0.2,
    patterns: [/^(hi|hallo|hey)\b/, /\bguten (tag|morgen|abend)\b/],
    responder: () => "Hallo! Wie kann ich helfen?",
  },
  {
    key: "smalltalk",
    weight: 0.1,
    patterns: [/(wie geht s|wie gehts|alles gut|na wie)/],
    responder: () => "Alles gut – womit kann ich helfen?",
  },
  // Produkt/Allgemein
  {
    key: "produkt",
    weight: 0.9,
    patterns: [/eazystep/, /(was ist|was genau|erklaer|produkt|hilfe im bad)/],
    responder: () => KB.produkt,
  },
  // Preis
  {
    key: "preis",
    weight: 1.0,
    patterns: [/(preis|kosten|kostet|wie viel|teuer|kostenpunkt)/],
    responder: () => KB.preise,
  },
  // Lieferung
  {
    key: "lieferzeit",
    weight: 0.9,
    patterns: [/(liefer|lieferzeit|versand|zustell|wann kommt|wie lange)/],
    responder: () => KB.lieferzeit,
  },
  // Einbau
  {
    key: "einbau",
    weight: 0.9,
    patterns: [/(einbau|montage|install|aufbau|montier|anbring|einsetzen)/],
    responder: () => KB.einbau,
  },
  // Garantie
  {
    key: "garantie",
    weight: 0.8,
    patterns: [/(garantie|gewaehr|gewaehrleistung|defekt|austausch|reparatur)/],
    responder: () => KB.garantie,
  },
  // Pflegekasse/Zuschuss
  {
    key: "pflegekasse",
    weight: 0.85,
    patterns: [/(pflegekasse|zuschuss|pflegegrad|foerder|bezuschusst|antrag)/],
    responder: () => KB.pflegekasse,
  },
  // Vorteile/Nutzen
  {
    key: "vorteile",
    weight: 0.6,
    patterns: [/(vorteil|nutzen|sturz|sicher|rutsch)/],
    responder: () => (KB.vorteile && KB.vorteile.length ? "Vorteile: " + KB.vorteile.join(", ") : ""),
  },
  // Maße/Passform
  {
    key: "masse",
    weight: 0.8,
    patterns: [/(mass|masse|groe|grosse|groesse|abmess|breite|hoehe|passt)/],
    responder: () => KB.masse,
  },
  // Zahlung
  {
    key: "zahlung",
    weight: 0.7,
    patterns: [/(zahlung|zahlen|raten|paypal|rechnung|finanzierung)/],
    responder: () => KB.zahlung,
  },
  // Platz/Einwand
  {
    key: "einwand_platz",
    weight: 0.6,
    patterns: [/(platz|sperrig|zu gross|passt nicht|steht im weg)/],
    responder: () => KB.einwaende?.platz,
  },
  // TEUER/Einwand
  {
    key: "einwand_teuer",
    weight: 0.6,
    patterns: [/(teuer|preis hoch|zu teuer)/],
    responder: () => KB.einwaende?.teuer,
  },
  // BELASTBARKEIT – viele Synonyme, Zahlen/„kg“ erkennen
  {
    key: "belastbarkeit",
    weight: 1.0,
    patterns: [
      /(belast|tragfaehig|traegt|stabil|gewicht|max(imum)? gewicht|wie schwer|haelt .*kg|haelt .* kilo|kg|kilo|kilogramm)/,
    ],
    responder: (t) => {
      // Wenn eine kg-Zahl gefragt wird, antworte klar + KB-Text
      const kgMatch = t.match(/(\d{2,3})\s*(kg|kilo|kilogramm)/);
      if (kgMatch && KB.belastbarkeit) {
        return `${KB.belastbarkeit}`;
      }
      return KB.belastbarkeit || "";
    },
  },
  // Abschluss/Bestellung
  {
    key: "abschluss",
    weight: 0.9,
    patterns: [/(angebot|bestellen|kaufen|beratung|kontakt|anfrage|termin)/],
    responder: () => KB.abschluss,
  },
];

// ===== Intent-Erkennung (Multi) =====
function detectIntents(raw) {
  const t = clean(raw);
  const found = [];

  for (const intent of INTENTS) {
    if (within(t, intent.patterns)) {
      // Spezialfall: „preis“ in Nebensatz → leichte Abwertung, sonst voll
      let score = intent.weight;
      if (intent.key === "preis" && !/(^| )preis( |$)/.test(t)) score *= 0.9;
      found.push({ key: intent.key, score, responder: intent.responder });
    }
  }

  // sortiert nach Score absteigend & deduplizieren
  found.sort((a, b) => b.score - a.score);
  const uniq = [];
  const seen = new Set();
  for (const f of found) {
    if (!seen.has(f.key)) {
      seen.add(f.key);
      uniq.push(f);
    }
  }
  return uniq;
}

// ===== Antwort bauen (Multi-Intent-Merge) =====
async function buildReply(text) {
  const intents = detectIntents(text);
  if (intents.length === 0) return null;

  // Nimm die Top 1–3 Intents (z. B. Preis + Lieferzeit + Einbau)
  const top = intents.slice(0, 3);

  // Antworten aus KB holen
  const parts = top
    .map((i) => {
      try {
        const val = i.responder(clean(text));
        return (val && String(val).trim()) || "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  if (parts.length === 0) return null;

  // Kompakte Merge-Strategie
  let merged = parts.join("\n");

  // Optional schön formulieren
  if (process.env.OPENAI_API_KEY) {
    merged = await beautifyReply(merged);
  }

  return merged;
}

// ===== OpenAI: Umformulieren (keine neuen Fakten) =====
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
          {
            role: "system",
            content:
              "Formuliere folgenden EazyStep-Produkttext freundlich, klar und verkaufsorientiert um. Ändere KEINE Fakten, füge nichts Neues hinzu. Antworte kompakt (max. 2 Sätze).",
          },
          { role: "user", content: text },
        ],
      }),
    });
    const data = await resp.json();
    if (data?.error) {
      console.error("OpenAI beautify error:", data.error);
      return text;
    }
    return data?.choices?.[0]?.message?.content || text;
  } catch (e) {
    console.error("OpenAI beautify fetch error:", e);
    return text;
  }
}

// ===== GPT-Fallback (optional, nutzt KB als Kontext) =====
async function kbAwareFallback(userText) {
  if (STRICT_KB || !process.env.OPENAI_API_KEY) return null;
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
          { role: "system", content: "Du bist ein EazyStep-Berater. Antworte NUR basierend auf diesem JSON. Keine neuen Fakten. Max. 2 Sätze." },
          { role: "system", content: context },
          { role: "user", content: userText },
        ],
      }),
    });
    const data = await r.json();
    if (data?.error) {
      console.error("OpenAI fallback error:", data.error);
      return null;
    }
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("OpenAI fallback fetch error:", e);
    return null;
  }
}

// ===== Meta Webhook Verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Eingang =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = msg?.from;
    const text = (msg?.text?.body || msg?.button?.text || "").trim();
    if (!from || !text) return;

    console.log("Incoming:", text);

    // 1) Multi-Intent aus KB
    let reply = await buildReply(text);

    // 2) Fallback (KB-basiert via GPT) falls nichts gefunden
    if (!reply) reply = await kbAwareFallback(text);

    if (!reply)
      reply = "Gern helfe ich zu EazyStep – frag z. B. nach Preis, Lieferzeit, Einbau, Zuschuss oder Belastbarkeit.";

    // Senden
    const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: limitLen(reply) },
      }),
    });
    const json = await resp.json();
    console.log("WA send result:", JSON.stringify(json));
  } catch (e) {
    console.error("❌ Fehler webhook:", e);
  }
});

app.listen(10000, () => console.log("Webhook läuft auf Port 10000 🚀"));
