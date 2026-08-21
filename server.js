/* =========================================================================
   PULSE Brand Playbook -> Notion relay
   Receives the JSON payload from pulse-brand-playbook.html and creates one
   Notion page per submission, with every answer written into the page body.

   Env vars required (set these in Railway -> Variables):
     NOTION_TOKEN     ntn_xxxxxxxx        (Notion internal integration secret)
     NOTION_DATABASE_ID  32-char id from the database URL
     ALLOWED_ORIGINS  https://playbook.pulsedigital.sg,https://pulsedigital.sg
   Optional:
     PORT             Railway sets this automatically
   ========================================================================= */

const express = require("express");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = (process.env.NOTION_DATABASE_ID || "").replace(/-/g, "");
const NOTION_VERSION = "2022-06-28";
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!NOTION_TOKEN || !DB_ID) {
  console.error("Missing NOTION_TOKEN or NOTION_DATABASE_ID");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!ALLOWED.length || (origin && ALLOWED.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ---------- crude rate limit: 5 submissions per IP per 10 min ---------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 5;
}

/* ---------- Notion helpers ---------- */
async function notion(path, method, body) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: {
      "Authorization": "Bearer " + NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Notion ${r.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

/* Read the database schema once so we only send properties that actually
   exist. Keeps the relay working if a column gets renamed or removed. */
let schema = null, titleProp = "Name";
async function loadSchema() {
  const db = await notion("/databases/" + DB_ID, "GET");
  schema = db.properties;
  for (const [k, v] of Object.entries(schema)) if (v.type === "title") titleProp = k;
  console.log("Notion schema loaded:", Object.keys(schema).join(", "));
}

/* Notion caps a single rich_text run at 2000 characters. */
function rt(text) {
  const out = [];
  let s = String(text == null ? "" : text);
  while (s.length > 1900) {
    let cut = s.lastIndexOf(" ", 1900);
    if (cut < 1200) cut = 1900;
    out.push({ type: "text", text: { content: s.slice(0, cut) } });
    s = s.slice(cut);
  }
  out.push({ type: "text", text: { content: s } });
  return out;
}

function para(text, opts = {}) {
  return {
    object: "block", type: "paragraph",
    paragraph: { rich_text: rt(text).map(t => ({ ...t, annotations: opts })) }
  };
}
function heading(text) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: rt(text) } };
}
function divider() {
  return { object: "block", type: "divider", divider: {} };
}

/* ---------- turn the payload into page body blocks ---------- */
function buildBlocks(p) {
  const blocks = [];

  blocks.push({
    object: "block", type: "callout",
    callout: {
      icon: { emoji: p.hasPrivate ? "\u{1F512}" : "\u{1F9E9}" },
      rich_text: rt(
        (p.hasPrivate
          ? "Contains answers the client marked PRIVATE. Team use only, never publish those lines. "
          : "") +
        `Submitted ${new Date(p.submittedAt || Date.now()).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })} SGT.`
      )
    }
  });
  blocks.push(divider());

  const responses = p.responses || {};
  let lastSection = null;

  for (const [id, r] of Object.entries(responses)) {
    if (!r) continue;
    let a = r.answer;
    if (Array.isArray(a)) a = a.join(", ");
    if (a == null || String(a).trim() === "") continue;

    if (r.section && r.section !== lastSection) {
      blocks.push(heading(r.section));
      lastSection = r.section;
    }
    blocks.push(para(r.question || id, { bold: true }));
    blocks.push(para(a, r.private ? { italic: true, color: "red" } : {}));
  }

  /* fallback if responses is ever empty but the markdown summary came through */
  if (blocks.length <= 2 && p.summaryMarkdown) blocks.push(para(p.summaryMarkdown));

  return blocks;
}

/* ---------- map the flat fields onto Notion properties ---------- */
function buildProperties(p) {
  const ans = id => {
    const r = (p.responses || {})[id];
    if (!r) return "";
    return Array.isArray(r.answer) ? r.answer.join(", ") : (r.answer || "");
  };

  const wanted = {
    [titleProp]:        { title: rt(p.name || p.client || "New response") },
    "Client":           { rich_text: rt(p.client || "") },
    "Status":           { select: { name: "New submission" } },
    "Submitted":        { date: { start: p.submittedAt || new Date().toISOString() } },
    "Form":             { rich_text: rt(`${p.form || "pulse_brand_playbook"} v${p.version || ""}`) },
    "Age":              { rich_text: rt(p.age || "") },
    "Kids":             { rich_text: rt(p.kids || "") },
    "Pets":             { rich_text: rt(p.pets || "") },
    "Archetype":        { rich_text: rt(ans("archetype")) },
    "Marital status":   { rich_text: rt(ans("marital_status")) },
    "Off limits":       { rich_text: rt(ans("offlimits")) },
    "Has private":      { checkbox: !!p.hasPrivate },
    "Page URL":         { url: p.pageUrl || null }
  };

  /* multi-select for the tone-of-voice question */
  const voice = ((p.responses || {}).voice || {}).answer;
  if (Array.isArray(voice) && voice.length) {
    wanted["Voice"] = { multi_select: voice.slice(0, 20).map(v => ({ name: String(v).slice(0, 100) })) };
  }

  /* only keep properties that exist in the database, with a matching type */
  const props = {};
  for (const [key, val] of Object.entries(wanted)) {
    const def = schema[key];
    if (!def) continue;
    const type = Object.keys(val)[0];
    if (def.type !== type) continue;
    if (type === "url" && !val.url) continue;
    props[key] = val;
  }
  return props;
}

/* ---------- routes ---------- */
app.get("/health", (_req, res) => res.json({ ok: true, schemaLoaded: !!schema }));

app.post("/submit", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: "Too many submissions" });

  const p = req.body || {};
  if (p.form && p.form !== "pulse_brand_playbook") {
    return res.status(400).json({ ok: false, error: "Unknown form" });
  }

  try {
    if (!schema) await loadSchema();

    const blocks = buildBlocks(p);
    const page = await notion("/pages", "POST", {
      parent: { database_id: DB_ID },
      icon: { emoji: "\u{1F5E3}" },
      properties: buildProperties(p),
      children: blocks.slice(0, 100)
    });

    /* Notion accepts max 100 children per call, so append the rest */
    for (let i = 100; i < blocks.length; i += 100) {
      await notion(`/blocks/${page.id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
    }

    console.log("Created Notion page for", p.name || p.client, page.id);
    res.json({ ok: true, pageId: page.id, url: page.url });
  } catch (err) {
    console.error("FAILED", err.message, JSON.stringify(req.body).slice(0, 2000));
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
loadSchema()
  .catch(e => console.error("Schema load failed (will retry on first submit):", e.message))
  .finally(() => app.listen(PORT, () => console.log("PULSE relay listening on " + PORT)));
