import { app, db, UPLOADS, RESULTS } from "./core.js";
import { genChimeImage, buildPrompt, buildCard, saveResult, describeChime, suggestText, qcImage } from "./gen.js";
import { writeFileSync, readFileSync } from "fs";
import { join, extname } from "path";
import { randomBytes } from "crypto";

function cleanName(raw: string): string {
  let s = raw.replace(/\.[^.]+$/, "");
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, "");
  s = s.replace(/\b\d{6,}\b/g, "");
  s = s.replace(/\b[a-f0-9]{6,}\b/ig, "");
  s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const stop = new Set(["free","photo","image","img","stock","copy","final","new","jpg","png","jpeg","webp"]);
  s = s.split(" ").filter(w => w && !stop.has(w.toLowerCase())).join(" ");
  if (!s) return "Beach Element";
  return s.split(" ").map(w => w[0]?.toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function publicBase(c: any): string {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/$/, "");
  const proto = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || "localhost";
  return `${proto}://${host}`;
}

// ---------- CHIMES (catalog) ----------
app.post("/api/chimes", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const files = ([] as File[]).concat(body["images"] as any || []);
  const names = ([] as string[]).concat((body["names"] as any) || []);
  const created: any[] = [];
  const base = publicBase(c);
  let i = 0;
  for (const f of files) {
    if (!(f instanceof File)) continue;
    const buf = Buffer.from(await f.arrayBuffer());
    const ext = (extname(f.name) || ".png").toLowerCase();
    const fn = `chime_${Date.now()}_${randomBytes(3).toString("hex")}${ext}`;
    writeFileSync(join(UPLOADS, fn), buf);
    const nm = cleanName(names[i] || f.name);
    const r = db.prepare("INSERT INTO chimes (name, image_path) VALUES (?,?)").run(nm, fn);
    const id = r.lastInsertRowid as number;
    created.push({ id, name: nm, image_path: fn, image_url: `${base}/uploads/${fn}` });
    describeChime(fn).then(desc => {
      if (desc) db.prepare("UPDATE chimes SET description=? WHERE id=?").run(desc, id);
    }).catch(()=>{});
    i++;
  }
  return c.json({ ok: true, created });
});

app.get("/api/chimes", (c) => {
  const rows = db.prepare("SELECT * FROM chimes ORDER BY created DESC").all() as any[];
  const base = publicBase(c);
  return c.json({ chimes: rows.map(r => ({ ...r, image_url: `${base}/uploads/${r.image_path}` })) });
});

app.put("/api/chimes/:id", async (c) => {
  const { name } = await c.req.json();
  db.prepare("UPDATE chimes SET name=? WHERE id=?").run(name, c.req.param("id"));
  return c.json({ ok: true });
});

app.delete("/api/chimes/:id", (c) => {
  db.prepare("DELETE FROM chimes WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/chimes/:id/describe", async (c) => {
  const row: any = db.prepare("SELECT * FROM chimes WHERE id=?").get(c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const desc = await describeChime(row.image_path);
  if (desc) db.prepare("UPDATE chimes SET description=? WHERE id=?").run(desc, row.id);
  return c.json({ ok: true, description: desc });
});

// ---------- ORDERS ----------
app.get("/api/orders", (c) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY created DESC").all();
  const base = publicBase(c);
  return c.json({ orders: rows.map((r: any) => ({
    ...r,
    picks: JSON.parse(r.picks || "[]"),
    result_url: r.result_path ? `${base}/results/${r.result_path}` : null,
  })) });
});

// ---------- TEXT SUGGEST ----------
app.post("/api/suggest", async (c) => {
  const body = await c.req.json();
  const field = body.field as "title"|"message"|"footer"|"scene";
  if (!["title","message","footer","scene"].includes(field)) return c.json({ error: "bad field" }, 400);
  const picks: number[] = Array.isArray(body.picks) ? body.picks : [];
  let descs: string[] = [];
  if (picks.length) {
    const ph = picks.map(() => "?").join(",");
    const rows: any[] = db.prepare(`SELECT name, description FROM chimes WHERE id IN (${ph})`).all(...picks);
    descs = rows.map(r => r.description?.trim() || r.name);
  }
  const text = await suggestText(field, descs, {
    title: body.title, message: body.message, footer: body.footer, scene: body.scene,
    keywords: body.keywords,
  });
  if (!text) return c.json({ error: "no suggestion" }, 500);
  return c.json({ ok: true, text });
});

// ---------- GENERATE ----------
app.post("/api/generate", async (c) => {
  const { picks, title, message, footer, scene, seed, keywords, return_b64 } = await c.req.json();
  if (!picks?.length) return c.json({ error: "pick at least one chime" }, 400);

  const ph = picks.map(() => "?").join(",");
  const chimes: any[] = db.prepare(`SELECT name, description FROM chimes WHERE id IN (${ph})`).all(...picks);

  const prompt = buildPrompt(chimes, scene, keywords);
  const seedNum = Number.isFinite(seed) ? Number(seed) : undefined;
  const expectedMats = chimes.map((c: any) => c.description?.trim() || c.name).join("; ");

  const MAX_TRIES = Number(process.env.QC_MAX_ATTEMPTS || 20);
  const PASS_SCORE = Number(process.env.QC_PASS_SCORE || 8);
  let best: { buf: Buffer; score: number; issues: string[]; seedUsed: number } | null = null;
  let attempts = 0;
  for (let i = 0; i < MAX_TRIES; i++) {
    const trySeed = i === 0 && seedNum !== undefined ? seedNum : Math.floor(Math.random() * 1e9);
    attempts = i + 1;
    try {
      const buf = await genChimeImage(prompt, trySeed);
      const qc = await qcImage(buf, expectedMats);
      if (!best || qc.score > best.score) best = { buf, score: qc.score, issues: qc.issues, seedUsed: trySeed };
      if (qc.score >= PASS_SCORE) break;
    } catch {}
  }
  if (!best) return c.json({ error: "image generation failed" }, 500);

  const card = await buildCard({
    title: title || "A Beautiful Wind Chime",
    message: message || "Handcrafted with love, made just for you.",
    footer: footer || "May this chime bring you comfort, peace, and cherished memories with every gentle breeze.",
    aiImage: best.buf,
  });
  const fn = saveResult(card, "png");

  db.prepare("INSERT INTO orders (link_slug, picks, title, message, result_path) VALUES (?,?,?,?,?)")
    .run("", JSON.stringify(picks), title, message, fn);

  const out: any = {
    ok: true,
    result: fn,
    result_url: `${publicBase(c)}/results/${fn}`,
    prompt,
    qc: { score: best.score, issues: best.issues, attempts, seed: best.seedUsed },
  };
  if (return_b64) out.b64 = card.toString("base64");
  return c.json(out);
});

// ---------- PREVIEW (raw AI image, no card overlay) ----------
app.post("/api/preview", async (c) => {
  const { picks, scene, seed, keywords, return_b64 } = await c.req.json();
  const ph = (picks || []).map(() => "?").join(",");
  const chimes: any[] = picks?.length ? db.prepare(`SELECT name, description FROM chimes WHERE id IN (${ph})`).all(...picks) : [];
  const prompt = buildPrompt(chimes, scene, keywords);
  const seedNum = Number.isFinite(seed) ? Number(seed) : undefined;
  const ai = await genChimeImage(prompt, seedNum);
  const fn = saveResult(ai, "png");
  const out: any = { ok: true, result: fn, result_url: `${publicBase(c)}/results/${fn}`, prompt };
  if (return_b64) out.b64 = ai.toString("base64");
  return c.json(out);
});
