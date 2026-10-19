// Vercel serverless function: /api/colourways
// Fetches a Woolworths product page server-side (no CORS limit) and extracts
// all colourways (colour name, swatch, hero image, image set) from the
// window.__INITIAL_STATE__ blob the page embeds.

function json(res, obj, status = 200) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.status(status).send(JSON.stringify(obj));
}

// String-aware extraction of the balanced {...} object that follows
// `window.__INITIAL_STATE__ =`.
function extractState(html) {
  const marker = "__INITIAL_STATE__";
  const mi = html.indexOf(marker);
  if (mi < 0) return null;
  const start = html.indexOf("{", mi);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } } }
    }
  }
  return null;
}

async function readBody(req) {
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
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.status(200).send("ok");
    return;
  }

  let path = "";
  try {
    if (req.method === "POST") {
      const b = await readBody(req);
      path = String((b && (b.path || b.url)) || "");
    } else {
      path = String((req.query && req.query.path) || "");
    }
  } catch { /* ignore */ }

  if (!path) return json(res, { error: "Missing product path" }, 400);

  // Normalise to an absolute Woolworths product URL.
  let url = path.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://www.woolworths.co.za/" + url.replace(/^\/+/, "");
  if (!/(^|\.)woolworths\.co\.za\//i.test(url)) return json(res, { error: "Not a Woolworths URL" }, 400);

  let html = "";
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-ZA,en;q=0.9",
      },
    });
    if (!r.ok) return json(res, { error: "Product page fetch failed", status: r.status }, 502);
    html = await r.text();
  } catch {
    return json(res, { error: "Could not reach the product page" }, 502);
  }

  const state = extractState(html);
  if (!state) return json(res, { error: "Could not read product state" }, 502);

  const skus = state && state.pdp && state.pdp.productInfo && state.pdp.productInfo.colourSKUs;
  if (!Array.isArray(skus) || !skus.length) return json(res, { error: "No colourways found", colours: [] }, 200);

  const colours = skus.map((c) => {
    const imgs = Array.isArray(c.images)
      ? c.images.map((im) => im && (im.external || im.internal)).filter(Boolean)
      : [];
    const swatch = (c.swatchImage && (c.swatchImage.external || c.swatchImage.internal)) || null;
    return { colour: c.colour || "", swatch, hero: imgs[0] || null, images: imgs.slice(0, 8), id: c.id || null };
  }).filter((c) => c.colour && (c.hero || c.swatch));

  return json(res, { colours });
};
