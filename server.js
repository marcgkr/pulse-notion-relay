/* =========================================================================
   PULSE Brand Playbook -> Notion relay
   Receives the JSON payload from pulse-brand-playbook.html and creates one
   Notion page per submission, with every answer written into the page body.

   Env vars required (set these in Railway -> Variables):
     NOTION_TOKEN     ntn_xxxxxxxx        (Notion internal integration secret)
     NOTION_DATABASE_ID  32-char id from the database URL
     ALLOWED_ORIGINS     https://medical.pulsedigital.sg
   Optional:
     ANTHROPIC_API_KEY   turns on the summary and story angles
     ANTHROPIC_MODEL     defaults to claude-sonnet-4-6
     EXPORT_KEY          password for /export, strongly recommended
     PORT                Railway sets this automatically

   Routes:
     POST /submit                the form posts here
     GET  /health                sanity check
     GET  /export?key=...        list of every submission
     GET  /export/<id>?key=...   one full interview in the browser
     GET  /export/<id>.docx?key=...  the same thing as a Word file
   ========================================================================= */

const express = require("express");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle
} = require("docx");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = (process.env.NOTION_DATABASE_ID || "").replace(/-/g, "");
const NOTION_VERSION = "2022-06-28";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const EXPORT_KEY = process.env.EXPORT_KEY || "";
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
function subheading(text) {
  return { object: "block", type: "heading_3", heading_3: { rich_text: rt(text) } };
}
function divider() {
  return { object: "block", type: "divider", divider: {} };
}

/* ---------- ask Claude for a client summary + story angles ---------- */
const ANALYSIS_BRIEF = `You are a senior content strategist at PULSE Digital, a Singapore performance marketing agency working mostly with medical, aesthetic and professional-services clients.

Below is a personal brand interview a client has just completed. Read it and return your working notes for the team who will turn this into content.

Rules:
- British / Singapore English. No em dashes. No corporate jargon.
- Ground everything in what the client actually said. Do not invent facts, numbers, dates or events.
- Any answer marked PRIVATE is for the team's understanding only. Never build a public angle on one, and never quote one. You may let it inform your read of the person.
- For healthcare clients keep MOH and HCSA rules in mind: no outcome claims, no patient testimonials, no before-and-after promises.
- If the interview is too thin to work with, say so plainly rather than padding.

Return ONLY valid JSON, no markdown fences, in exactly this shape:
{
  "summary": "Three or four sentences on who this person is, what drives them, and how they come across. Written for a colleague, not for the client.",
  "voice_note": "One or two sentences on how their content should sound, drawn from how they actually write and what they picked for tone.",
  "angles": [
    {
      "title": "Short name for the angle",
      "hook": "The opening line or premise, in their voice",
      "why": "One or two sentences on why this lands and which part of the interview it draws on",
      "format": "Where it fits, e.g. LinkedIn post, short-form video, founder story page"
    }
  ],
  "handle_with_care": "Anything the team should avoid or tread carefully around, including what the client marked off limits. Empty string if nothing."
}

Give four angles, ordered strongest first.`;

async function analyse(payload) {
  if (!ANTHROPIC_KEY) return null;

  /* build a clean transcript, keeping the private flags visible to the model */
  let transcript = "";
  let lastSection = null;
  for (const r of Object.values(payload.responses || {})) {
    if (!r) continue;
    let a = Array.isArray(r.answer) ? r.answer.join(", ") : r.answer;
    if (!a || !String(a).trim()) continue;
    if (r.section !== lastSection) { transcript += `\n\n## ${r.section}\n`; lastSection = r.section; }
    transcript += `\nQ: ${r.question}\nA: ${a}\n`;
  }
  if (transcript.trim().length < 200) return null;   // too thin to be worth a call

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        system: ANALYSIS_BRIEF,
        messages: [{ role: "user", content: `Client: ${payload.name || payload.client || "unknown"}\n${transcript}` }]
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);

    let text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const out = JSON.parse(text);
    if (!out || typeof out.summary !== "string") throw new Error("unexpected shape");
    return out;
  } catch (e) {
    console.error("Analysis failed (page will still be created):", e.message);
    return null;
  }
}

/* ---------- turn the payload into page body blocks ---------- */
function buildBlocks(p, analysis) {
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

  /* ---- Claude's read of the interview, above the raw answers ---- */
  if (analysis) {
    blocks.push(heading("Who we're working with"));
    blocks.push(para(analysis.summary || ""));

    if (analysis.voice_note) {
      blocks.push(para("How they should sound", { bold: true }));
      blocks.push(para(analysis.voice_note));
    }

    if (Array.isArray(analysis.angles) && analysis.angles.length) {
      blocks.push(heading("Story angles"));
      analysis.angles.forEach((a, i) => {
        blocks.push({
          object: "block", type: "toggle",
          toggle: {
            rich_text: rt(`${i + 1}. ${a.title || "Untitled angle"}`).map(t => ({ ...t, annotations: { bold: true } })),
            children: [
              para(`Hook: ${a.hook || ""}`),
              para(`Why it works: ${a.why || ""}`),
              para(`Format: ${a.format || ""}`)
            ]
          }
        });
      });
    }

    if (analysis.handle_with_care && String(analysis.handle_with_care).trim()) {
      blocks.push({
        object: "block", type: "callout",
        callout: {
          icon: { emoji: "\u26A0\uFE0F" },
          color: "yellow_background",
          rich_text: rt("Handle with care: " + analysis.handle_with_care)
        }
      });
    }

    blocks.push(divider());
    blocks.push(heading("The interview"));
  }

  const responses = p.responses || {};
  let lastSection = null;

  for (const [id, r] of Object.entries(responses)) {
    if (!r) continue;
    let a = r.answer;
    if (Array.isArray(a)) a = a.join(", ");
    if (a == null || String(a).trim() === "") continue;

    if (r.section && r.section !== lastSection) {
      blocks.push(subheading(r.section));
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
function buildProperties(p, analysis) {
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

  /* Claude's read, surfaced in the table so you can scan without opening pages */
  if (analysis) {
    if (analysis.summary) wanted["Summary"] = { rich_text: rt(analysis.summary) };
    if (Array.isArray(analysis.angles) && analysis.angles.length) {
      wanted["Story angles"] = {
        rich_text: rt(analysis.angles.map((a, i) => `${i + 1}. ${a.title}`).join("  ·  "))
      };
    }
  }

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

    const analysis = await analyse(p);          // null if no key, thin form, or API trouble

    const blocks = buildBlocks(p, analysis);
    const page = await notion("/pages", "POST", {
      parent: { database_id: DB_ID },
      icon: { emoji: "\u{1F5E3}" },
      properties: buildProperties(p, analysis),
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

/* =========================================================================
   Export: read a submission back out of Notion and hand it over as a
   document. Nothing is stored here, it is always rebuilt from the page,
   so an edit made in Notion shows up in the download.
   ========================================================================= */

const plain = rich => (rich || []).map(t => t.plain_text || t?.text?.content || "").join("");

async function fetchBlocks(id) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const r = await notion(`/blocks/${id}/children${q}`, "GET");
    for (const b of r.results) {
      out.push(b);
      if (b.has_children && b.type === "toggle") b._kids = await fetchBlocks(b.id);
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

/* Notion blocks -> a flat list this file can render as HTML or Word */
function flatten(blocks, depth = 0) {
  const items = [];
  for (const b of blocks) {
    const t = b.type;
    const text = plain(b[t]?.rich_text);
    if (t === "divider") { items.push({ kind: "rule" }); continue; }
    if (t === "heading_2") { items.push({ kind: "h2", text }); continue; }
    if (t === "heading_3") { items.push({ kind: "h3", text }); continue; }
    if (t === "callout") { items.push({ kind: "note", text }); continue; }
    if (t === "toggle") {
      items.push({ kind: "h4", text });
      if (b._kids) items.push(...flatten(b._kids, depth + 1));
      continue;
    }
    if (t === "paragraph") {
      if (!text.trim()) continue;
      const ann = (b.paragraph.rich_text[0] || {}).annotations || {};
      items.push({ kind: "p", text, bold: !!ann.bold, private: ann.color === "red" });
      continue;
    }
  }
  return items;
}

async function loadSubmission(pageId) {
  const page = await notion(`/pages/${pageId}`, "GET");
  const title = (() => {
    for (const v of Object.values(page.properties)) if (v.type === "title") return plain(v.title);
    return "Submission";
  })();
  const prop = (name) => {
    const v = page.properties[name];
    if (!v) return "";
    if (v.type === "rich_text") return plain(v.rich_text);
    if (v.type === "select") return v.select?.name || "";
    if (v.type === "multi_select") return v.multi_select.map(o => o.name).join(", ");
    if (v.type === "date") return v.date?.start || "";
    if (v.type === "checkbox") return v.checkbox ? "Yes" : "No";
    return "";
  };
  return {
    id: pageId, title,
    key: EXPORT_KEY ? `?key=${encodeURIComponent(EXPORT_KEY)}` : "",
    client: prop("Client"), submitted: prop("Submitted"), hasPrivate: prop("Has private"),
    items: flatten(await fetchBlocks(pageId))
  };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function buildDocx(sub) {
  const kids = [
    new Paragraph({ text: sub.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({
        text: [sub.client && `Client: ${sub.client}`, sub.submitted && `Submitted: ${sub.submitted.slice(0, 10)}`]
          .filter(Boolean).join("   ·   "),
        color: "666666", size: 20
      })],
      spacing: { after: 300 }
    })
  ];

  for (const it of sub.items) {
    if (it.kind === "rule") {
      kids.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "DDDDDD" } },
        spacing: { before: 200, after: 200 }
      }));
    } else if (it.kind === "h2") {
      kids.push(new Paragraph({ text: it.text, heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 140 } }));
    } else if (it.kind === "h3") {
      kids.push(new Paragraph({ text: it.text, heading: HeadingLevel.HEADING_2, spacing: { before: 260, after: 120 } }));
    } else if (it.kind === "h4") {
      kids.push(new Paragraph({ text: it.text, heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 } }));
    } else if (it.kind === "note") {
      kids.push(new Paragraph({
        children: [new TextRun({ text: it.text, italics: true, color: "8A6D00" })],
        spacing: { before: 160, after: 160 }
      }));
    } else {
      kids.push(new Paragraph({
        children: [new TextRun({
          text: it.text, bold: it.bold,
          italics: it.private, color: it.private ? "B03030" : undefined
        })],
        spacing: { after: it.bold ? 40 : 160 }
      }));
    }
  }

  const doc = new Document({
    creator: "PULSE Digital",
    title: sub.title,
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children: kids }]
  });
  return Packer.toBuffer(doc);
}

function renderHtml(sub) {
  const body = sub.items.map(it => {
    if (it.kind === "rule") return "<hr>";
    if (it.kind === "h2") return `<h2>${esc(it.text)}</h2>`;
    if (it.kind === "h3") return `<h3>${esc(it.text)}</h3>`;
    if (it.kind === "h4") return `<h4>${esc(it.text)}</h4>`;
    if (it.kind === "note") return `<p class="note">${esc(it.text)}</p>`;
    return `<p class="${it.bold ? "q" : ""}${it.private ? " priv" : ""}">${esc(it.text)}</p>`;
  }).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${esc(sub.title)}</title>
<style>
 body{max-width:46rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:#16323d}
 h1{font-size:2rem;margin:0 0 .2rem} .meta{color:#6b8b91;font-size:.85rem;margin:0 0 2rem}
 h2{font-size:1.3rem;margin:2.4rem 0 .6rem;color:#175E69} h3{font-size:1.05rem;margin:1.8rem 0 .4rem;color:#399677}
 h4{font-size:1rem;margin:1.4rem 0 .3rem} hr{border:0;border-top:1px solid #e3ebec;margin:2rem 0}
 p{margin:0 0 1rem} p.q{font-weight:600;margin-bottom:.15rem}
 p.priv{color:#b03030;font-style:italic} p.note{background:#fff8e1;padding:.75rem 1rem;border-radius:6px}
 .bar{margin-bottom:2rem} .bar a{display:inline-block;background:#399677;color:#fff;text-decoration:none;
   padding:.5rem 1rem;border-radius:6px;font-size:.9rem;margin-right:.5rem}
 @media print{.bar{display:none}}
</style>
<div class="bar"><a href="/export/${sub.id}.docx${sub.key}">Download as Word</a><a href="/export${sub.key}">All submissions</a></div>
<h1>${esc(sub.title)}</h1>
<p class="meta">${esc([sub.client && "Client: " + sub.client, sub.submitted && "Submitted: " + sub.submitted.slice(0, 10)].filter(Boolean).join("   ·   "))}</p>
${body}`;
}

/* Everything under /export is client interview material, including the
   answers they marked private. Set EXPORT_KEY in Railway and the pages are
   only reachable with ?key=... on the end. Leave it unset and they are open
   to anyone who knows the URL. */
app.use("/export", (req, res, next) => {
  if (!EXPORT_KEY) return next();
  if (req.query.key === EXPORT_KEY) return next();
  res.status(404).send("Not found");
});

app.get("/export", async (req, res) => {
  const k = EXPORT_KEY ? `?key=${encodeURIComponent(EXPORT_KEY)}` : "";
  try {
    const q = await notion(`/databases/${DB_ID}/query`, "POST", {
      page_size: 100,
      sorts: [{ timestamp: "created_time", direction: "descending" }]
    });
    const rows = q.results.map(pg => {
      let title = "Untitled";
      for (const v of Object.values(pg.properties)) if (v.type === "title") title = plain(v.title) || title;
      const client = pg.properties.Client?.rich_text ? plain(pg.properties.Client.rich_text) : "";
      const when = pg.properties.Submitted?.date?.start || pg.created_time;
      return `<tr><td><a href="/export/${pg.id}${k}">${esc(title)}</a></td><td>${esc(client)}</td>
        <td>${esc((when || "").slice(0, 10))}</td><td><a href="/export/${pg.id}.docx${k}">Word</a></td></tr>`;
    }).join("\n");
    res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8">
<title>Brand Playbook submissions</title>
<style>body{max-width:52rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#16323d}
h1{color:#175E69} table{width:100%;border-collapse:collapse;margin-top:1.5rem}
td,th{text-align:left;padding:.6rem .5rem;border-bottom:1px solid #e3ebec;font-size:.95rem}
th{color:#6b8b91;font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
a{color:#399677}</style>
<h1>Brand Playbook submissions</h1>
<table><tr><th>Name</th><th>Client</th><th>Submitted</th><th></th></tr>${rows}</table>`);
  } catch (e) {
    res.status(500).send("Could not load submissions: " + esc(e.message));
  }
});

app.get("/export/:id.docx", async (req, res) => {
  try {
    const sub = await loadSubmission(req.params.id);
    const buf = await buildDocx(sub);
    const safe = (sub.title || "submission").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "submission";
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="brand-playbook-${safe}.docx"`
    }).send(buf);
  } catch (e) {
    console.error("Export failed:", e.message);
    res.status(500).send("Export failed: " + esc(e.message));
  }
});

app.get("/export/:id", async (req, res) => {
  try {
    res.set("Content-Type", "text/html; charset=utf-8").send(renderHtml(await loadSubmission(req.params.id)));
  } catch (e) {
    res.status(500).send("Could not load that submission: " + esc(e.message));
  }
});

const PORT = process.env.PORT || 3000;
loadSchema()
  .catch(e => console.error("Schema load failed (will retry on first submit):", e.message))
  .finally(() => app.listen(PORT, () => console.log("PULSE relay listening on " + PORT)));
