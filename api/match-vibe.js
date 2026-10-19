// Vercel serverless function: /api/match-vibe
// Reads a reference outfit image with Google Gemini and returns a short vibe
// "read" plus a few Woolworths South Africa search threads.
// The Gemini key is read from the GEMINI_API_KEY environment variable (set it
// in Vercel > Project > Settings > Environment Variables). Never hard-code it.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const SYSTEM = `You are a fashion stylist for an internal tool used by a creative studio working on the Woolworths South Africa account. You are shown a REFERENCE OUTFIT image, and optionally a short styling note. Your job is to read the overall VIBE of the look (colour palette, formality, silhouette, fabric feel, key pieces) and translate it into a small set of search queries for Woolworths South Africa's own catalogue.

Woolworths SA is a mid-market retailer. Do NOT copy the reference garment for garment. Instead capture the mood and translate aspirational or high-fashion references into pieces Woolworths realistically stocks. Use plain product language a shopper would type (for example "wide leg linen trousers", "oversized blazer", "strappy heeled sandals"), optionally with a colour when the palette clearly calls for it. Keep each query short (2 to 5 words) so the catalogue search returns results.

Return between 2 and 5 threads. Each thread is one garment role in the look, with a short human label and one search query.

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"read":"one short sentence describing the vibe","threads":[{"label":"Neutral linen trousers","query":"wide leg linen trousers stone"}]}`;

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

async function readBody(req) {
  // Vercel usually parses JSON bodies for us. Fall back to reading the raw
  // stream if req.body is empty or a string.
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).send("ok"); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const KEY = process.env.GEMINI_API_KEY || "";
  if (!KEY) { res.status(500).json({ error: "Server not configured: GEMINI_API_KEY missing" }); return; }

  const body = await readBody(req);

  const img = parseDataUrl(String(body.image || ""));
  if (!img) { res.status(400).json({ error: "Missing or invalid image (expected a data URL)" }); return; }

  // Base64 length is roughly 1.37x the byte size; ~7M chars caps the image near 5MB.
  if (img.data.length > 7_000_000) {
    res.status(413).json({ error: "Image too large; please use one under about 5MB" });
    return;
  }

  const note = String(body.note || "").slice(0, 500);
  const userText = note
    ? `Styling note from the user: ${note}`
    : "Read the vibe of this outfit and suggest Woolworths pieces.";

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: img.media_type, data: img.data } },
        { text: userText },
      ],
    }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 800,
      responseMimeType: "application/json",
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${KEY}`;

  let gRes;
  try {
    gRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    res.status(502).json({ error: "Could not reach the vision model" });
    return;
  }

  if (!gRes.ok) {
    const t = await gRes.text();
    res.status(502).json({ error: "Vision model error", detail: t.slice(0, 500) });
    return;
  }

  const data = await gRes.json();
  let text = "";
  try {
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    text = parts.map((p) => (p && p.text) || "").join("").trim();
  } catch {
    text = "";
  }

  if (!text) {
    const reason =
      (data.candidates && data.candidates[0] && data.candidates[0].finishReason) ||
      (data.promptFeedback && data.promptFeedback.blockReason) ||
      "no output";
    res.status(502).json({ error: "No usable output from the vision model", detail: String(reason) });
    return;
  }

  // Strip any accidental code fences before parsing.
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let out;
  try {
    out = JSON.parse(text);
  } catch {
    res.status(502).json({ error: "Could not parse model output", raw: text.slice(0, 500) });
    return;
  }

  const threads = Array.isArray(out && out.threads)
    ? out.threads
        .filter((t) => t && t.query)
        .slice(0, 5)
        .map((t) => ({
          label: String(t.label || t.query).slice(0, 60),
          query: String(t.query).slice(0, 80),
        }))
    : [];

  if (!threads.length) { res.status(502).json({ error: "No usable threads returned" }); return; }

  res.status(200).json({ read: String((out && out.read) || "").slice(0, 200), threads });
};
