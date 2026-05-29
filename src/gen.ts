import { createCanvas, loadImage, Image } from "canvas";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { RESULTS, UPLOADS } from "./core.js";

const KEY = process.env.POLLINATIONS_API_KEY || "";
const POLL_ANON = "https://image.pollinations.ai/prompt/";
const POLL_AUTH = "https://gen.pollinations.ai/image/";
const POLL_CHAT = "https://gen.pollinations.ai/v1/chat/completions";

// 9router (LLM gateway) — billions of free-tier accounts. Chain of models tried in order.
const R9_KEY = process.env.ROUTE9_API_KEY || "";
const R9_URL = (process.env.ROUTE9_URL || "http://localhost:20128/v1") + "/chat/completions";
const R9_MODELS = (process.env.ROUTE9_MODELS || process.env.ROUTE9_MODEL || "cl/anthropic/claude-sonnet-4.6,smart-worker")
  .split(",").map(s => s.trim()).filter(Boolean);

function extractContent(j: any): string | null {
  // 9router wraps some provider responses in { data: {...} }
  const root = j?.data ?? j;
  const txt = root?.choices?.[0]?.message?.content;
  if (typeof txt === "string") return txt.trim() || null;
  if (Array.isArray(txt)) {
    const joined = txt.map((p: any) => p?.text || "").join("").trim();
    return joined || null;
  }
  return null;
}

async function chatComplete(messages: any[], maxTokens = 200, temperature = 0.7): Promise<string | null> {
  // Try each model in the 9router chain
  if (R9_KEY) {
    for (const model of R9_MODELS) {
      try {
        const r = await fetch(R9_URL, {
          method: "POST",
          headers: { "Authorization": `Bearer ${R9_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
        });
        if (!r.ok) continue;
        const txt = extractContent(await r.json());
        if (txt) return txt;
      } catch {}
    }
  }
  // Last-resort fallback: Pollinations
  if (KEY) {
    try {
      const r = await fetch(POLL_CHAT, {
        method: "POST",
        headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mistral", messages, max_tokens: maxTokens, temperature }),
      });
      if (r.ok) {
        const txt = extractContent(await r.json());
        if (txt) return txt;
      }
    } catch {}
  }
  return null;
}

// Image gen chain — try free unlimited endpoints first, paid as last resort.
const ZGEN = "https://z-gen-turbo.vercel.app/api/generate";
const R9_IMG_URL = (process.env.ROUTE9_URL || "http://localhost:20128/v1") + "/images/generations";
const R9_IMG_MODELS = (process.env.ROUTE9_IMG_MODELS || "cx/gpt-5.5-image,cx/gpt-5.4-image,cx/gpt-5.3-image,cx/gpt-5.2-image")
  .split(",").map(s => s.trim()).filter(Boolean);

async function try9RouterImage(prompt: string): Promise<Buffer | null> {
  if (!R9_KEY) { console.log("[9r-img] no R9_KEY"); return null; }
  for (const model of R9_IMG_MODELS) {
    try {
      const r = await fetch(R9_IMG_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${R9_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024", quality: "auto", output_format: "png" }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.log(`[9r-img] ${model} status=${r.status} body=${txt.slice(0,200)}`);
        continue;
      }
      const j: any = await r.json();
      const b64 = j?.data?.[0]?.b64_json;
      if (b64) {
        const buf = Buffer.from(b64, "base64");
        if (buf.length > 1000) return buf;
      }
      const url = j?.data?.[0]?.url;
      if (url) {
        const ir = await fetch(url);
        if (ir.ok) {
          const buf = Buffer.from(await ir.arrayBuffer());
          if (buf.length > 1000) return buf;
        }
      }
      console.log(`[9r-img] ${model} returned no b64 or url`);
    } catch (e: any) { console.log(`[9r-img] ${model} throw: ${e?.message || e}`); }
  }
  return null;
}

async function tryZGen(prompt: string, seed: number): Promise<Buffer | null> {
  // z-gen-turbo occasionally 504s — retry 3x w/ small backoff before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const u = `${ZGEN}?prompt=${encodeURIComponent(prompt)}&width=1024&height=1024&seed=${seed + attempt}`;
      const r = await fetch(u, {
        headers: {
          "Referer": "https://z-gen-turbo.vercel.app/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept": "image/*,*/*",
        },
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 1000) return buf;
      }
    } catch {}
    if (attempt < 2) await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

async function tryPollAuth(prompt: string, seed: number, model: string): Promise<Buffer | null> {
  if (!KEY) return null;
  try {
    const u = `${POLL_AUTH}${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&model=${model}&nologo=true&enhance=true`;
    const r = await fetch(u, {
      headers: { "User-Agent": "ChimeBuilder/1.0", "Accept": "image/*", "Authorization": `Bearer ${KEY}` },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 1000 ? buf : null;
  } catch { return null; }
}

async function tryPollAnon(prompt: string, seed: number): Promise<Buffer | null> {
  try {
    const u = `${POLL_ANON}${encodeURIComponent(prompt)}?seed=${seed}&nologo=true`;
    const r = await fetch(u, { headers: { "User-Agent": "ChimeBuilder/1.0", "Accept": "image/*" } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 1000 ? buf : null;
  } catch { return null; }
}

export async function genChimeImage(prompt: string, seed?: number, model?: string): Promise<Buffer> {
  const s = seed ?? Math.floor(Math.random() * 1e9);
  const m = model || "flux";
  // 9router GPT-Image only — chain across cx/gpt-5.5/5.4/5.3/5.2-image (4 Codex accounts).
  const buf = await try9RouterImage(prompt);
  if (buf) return buf;
  throw new Error("All image endpoints failed");
}

// QC — score generated image against material + product expectations. Returns 0-10 + issues.
export async function qcImage(buf: Buffer, expectedMaterials: string, product?: string | null): Promise<{score:number; issues:string[]; ok:boolean}> {
  const fail = { score: 5, issues: [] as string[], ok: true };
  const { def: prod } = resolveProduct(product);
  try {
    const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
    const txt = await chatComplete([{
      role: "user",
      content: [
        { type: "text", text: `Evaluate this image as a handcrafted ${prod.label.toLowerCase()} made from: ${expectedMaterials}.

Check:
1. Is the main subject clearly a ${prod.qcSubject} (not a different product type, not random objects)?
2. Are the materials visually consistent with the description (right colors, right items)?
3. Is composition usable (subject on left side, empty/soft right area for text overlay)?
4. Any obvious AI artifacts (mangled hands, extra heads, distorted shapes)?

Respond ONLY as compact JSON:
{"score": 1-10, "issues": ["short issue 1", "short issue 2"]}
Score 8+ = ship it. 5-7 = okay-ish. <5 = bad, regen.` },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }], 200, 0.2);
    if (!txt) return fail;
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return fail;
    const j = JSON.parse(m[0]);
    const score = Math.max(0, Math.min(10, Number(j.score) || 5));
    const issues = Array.isArray(j.issues) ? j.issues.map(String).slice(0, 5) : [];
    return { score, issues, ok: score >= 6 };
  } catch { return fail; }
}

// Vision — describe an uploaded chime photo in <20 words.
export async function describeChime(filename: string): Promise<string | null> {
  try {
    const buf = readFileSync(join(UPLOADS, filename));
    const ext = filename.split(".").pop()?.toLowerCase() || "jpg";
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    const txt = await chatComplete([{
      role: "user",
      content: [
        { type: "text", text: "Describe what is shown in 18 words or less. Focus on physical materials, colors, shapes, textures only. No fluff, no preamble. Examples: 'Two orange knobbly starfish' or 'White and pink scallop shells with ridges'." },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }], 80, 0.4);
    if (!txt) return null;
    return txt.replace(/^["'`]+|["'`]+$/g, "").slice(0, 200);
  } catch { return null; }
}

// Text suggestion for client form fields (title/message/footer/scene).
type SuggestField = "title" | "message" | "footer" | "scene";
function fieldGuide(field: SuggestField, productLabel: string): string {
  const p = productLabel.toLowerCase();
  switch (field) {
    case "title":
      return `A short, heartfelt card title (3-6 words). Romantic, memorial, or celebratory. Examples: 'Forever In Our Hearts', 'Whispers From The Sea', 'In Loving Memory'.`;
    case "message":
      return `A heartfelt 2-3 sentence message (30-50 words) for a handcrafted ${p} keepsake card. Evocative, warm, coastal imagery. No corny clichés. Examples: 'Like the ocean\\'s gentle whisper, this ${p} carries memories that never fade.'`;
    case "footer":
      return `A short closing wish (10-20 words), italic-feel. Examples: 'May this ${p} bring comfort, peace, and cherished memories with every wear.'`;
    case "scene":
      return `A short 8-15 word scene/setting description for where the ${p} is shown or worn. Examples for a chime: 'hanging on a sunlit seaside porch'. Examples for earrings: 'displayed on cream linen beside a vase of sea grass'.`;
  }
}
export async function suggestText(
  field: SuggestField,
  chimeDescs: string[],
  context: Partial<Record<SuggestField, string>> & { keywords?: string; product?: string | null },
): Promise<string | null> {
  const { def: prod } = resolveProduct(context.product);
  const ctxLines: string[] = [];
  ctxLines.push(`Product type: ${prod.label}`);
  if (chimeDescs.length) ctxLines.push(`Made from: ${chimeDescs.join("; ")}`);
  if (context.keywords?.trim()) ctxLines.push(`Personal touches / memories to weave in: ${context.keywords.trim()}`);
  for (const k of ["title","message","footer","scene"] as SuggestField[]) {
    if (k !== field && context[k]?.trim()) ctxLines.push(`Existing ${k}: ${context[k]!.trim()}`);
  }
  const sys = `You write heartfelt copy for handcrafted Coastal Creations ${prod.label.toLowerCase()} keepsake cards. Brand voice: warm, sincere, slightly poetic, never schmaltzy. Output ONLY the requested text — no preamble, no quotes, no labels.`;
  const usr = `${ctxLines.join("\n")}\n\nGenerate the ${field} only. ${fieldGuide(field, prod.label)}`;
  const txt = await chatComplete([
    { role: "system", content: sys },
    { role: "user", content: usr },
  ], 180, 0.9);
  if (!txt) return null;
  return txt.replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, field === "title" ? 80 : 500);
}

// ---------- PRODUCT REGISTRY ----------
// Each product describes how the AI should compose the materials and what to forbid.
export type ProductKey =
  | "wind_chime" | "earrings" | "necklace" | "bracelet" | "ornament"
  | "mobile" | "garland" | "wreath" | "keychain" | "magnet" | "ring" | "anklet";

interface ProductDef {
  label: string;
  // How the materials are physically assembled into this product.
  scaffold: string;
  // What the model must NOT draw (avoid wrong product confusion).
  negatives: string;
  // Subject phrasing used by QC vision check.
  qcSubject: string;
  // Default scene when caller doesn't supply one.
  defaultScene: string;
  // Composition framing — most products want left-half subject, right-half empty for text overlay.
  framing: string;
}

export const PRODUCTS: Record<ProductKey, ProductDef> = {
  wind_chime: {
    label: "Wind Chime",
    scaffold: "wind chime sculpture, each piece individually strung on natural jute twine, dangling vertically from a small piece of weathered driftwood at the top, with small knots between each piece",
    negatives: "NO bamboo tubes, NO metal pipes, NO glass cylinders. Only the listed natural elements hanging from twine.",
    qcSubject: "hanging wind chime",
    defaultScene: "hanging on a seaside porch overlooking the ocean at sunset",
    framing: "Vertical portrait composition, chime hangs on left side of frame, soft empty background on right side for text overlay.",
  },
  earrings: {
    label: "Earrings",
    scaffold: "matched pair of handcrafted dangle earrings, each shell or element delicately wire-wrapped in thin gold-fill or silver wire, suspended below a small hypoallergenic French hook earwire post, both earrings shown side by side at slightly different angles",
    negatives: "NO long strands, NO chime structure, NO mass of elements. Earrings only — two small matched pieces.",
    qcSubject: "matched pair of dangle earrings",
    defaultScene: "displayed on soft cream linen with a sprinkle of beach sand, soft morning light",
    framing: "Square composition, earring pair centered on left half, soft empty cream space on right for text overlay.",
  },
  necklace: {
    label: "Necklace",
    scaffold: "handcrafted pendant necklace, single central element wire-wrapped and hanging from a delicate gold-fill or silver chain that loops behind to a small clasp, pendant prominently displayed",
    negatives: "NO chime structure, NO multiple hanging strands, NO bracelet.",
    qcSubject: "necklace with central pendant on a chain",
    defaultScene: "draped gracefully on cream linen with soft natural light",
    framing: "Composition centered slightly left, pendant clearly visible, soft empty space on right for text overlay.",
  },
  bracelet: {
    label: "Bracelet",
    scaffold: "handcrafted bracelet laid in a graceful curve, individual elements connected by delicate gold-fill or silver wire links and a small lobster clasp, photographed flat",
    negatives: "NO long pendant, NO chime, NO necklace chain.",
    qcSubject: "bracelet laid flat in a curve",
    defaultScene: "on cream linen with a few scattered grains of sand, soft natural light",
    framing: "Horizontal composition, bracelet arcing across left two-thirds, soft empty cream space on right for text overlay.",
  },
  ornament: {
    label: "Hanging Ornament",
    scaffold: "single decorative hanging ornament, central element with a small loop of natural jute cord at the top for hanging, optionally accented with a single small charm or bead",
    negatives: "NO multi-strand structure, NO chime tubes, NO earring pair.",
    qcSubject: "single hanging ornament",
    defaultScene: "hanging from a window edge with soft seaside light filtering through",
    framing: "Vertical composition, ornament hanging on left side, soft empty background on right for text overlay.",
  },
  mobile: {
    label: "Mobile",
    scaffold: "delicate hanging mobile, multiple small elements suspended at different lengths from a horizontal driftwood crossbar at the top, balanced symmetrical composition with elements gently rotating",
    negatives: "NO single vertical strand (that would be a chime), NO bamboo tubes.",
    qcSubject: "hanging mobile with horizontal crossbar",
    defaultScene: "hanging in a sun-drenched nursery or coastal living room",
    framing: "Vertical composition, mobile hangs on left side, soft empty background on right for text overlay.",
  },
  garland: {
    label: "Garland",
    scaffold: "long horizontal garland, elements strung along a natural jute or cotton twine line at even spacing, draped gracefully along a mantel or window edge",
    negatives: "NO vertical chime structure, NO single pendant.",
    qcSubject: "horizontal garland strung with elements",
    defaultScene: "draped along a weathered driftwood mantel with soft morning seaside light",
    framing: "Horizontal landscape composition, garland stretching across left side, soft empty area on right for text overlay.",
  },
  wreath: {
    label: "Wreath",
    scaffold: "circular coastal wreath built on a driftwood ring base, elements attached around the ring in a balanced pattern with small touches of dried sea grass or jute ribbon",
    negatives: "NO hanging strands, NO chime, NO straight garland.",
    qcSubject: "circular coastal wreath",
    defaultScene: "hanging on a weathered cottage door painted soft blue, late-afternoon light",
    framing: "Centered circular composition on left, soft empty space on right for text overlay.",
  },
  keychain: {
    label: "Keychain",
    scaffold: "small handcrafted keychain, central element wire-wrapped and attached by a short braided leather or jute cord to a small split metal ring",
    negatives: "NO chime, NO long strands, NO necklace.",
    qcSubject: "small keychain with central element",
    defaultScene: "lying on cream linen with soft natural light",
    framing: "Composition centered slightly left, soft empty space on right for text overlay.",
  },
  magnet: {
    label: "Refrigerator Magnet",
    scaffold: "small decorative refrigerator magnet, single element mounted on a small circular cork or wood backing with a flat magnet on the reverse",
    negatives: "NO hanging structure, NO chime, NO chain.",
    qcSubject: "small refrigerator magnet",
    defaultScene: "photographed on cream linen, soft natural light",
    framing: "Centered composition on left, soft empty cream space on right for text overlay.",
  },
  ring: {
    label: "Ring",
    scaffold: "handcrafted ring, central element wire-wrapped onto an adjustable gold-fill or silver wire band",
    negatives: "NO chain, NO chime, NO earring pair, NO bracelet.",
    qcSubject: "single handcrafted ring",
    defaultScene: "displayed on cream linen with soft natural light",
    framing: "Centered macro composition on left, soft empty space on right for text overlay.",
  },
  anklet: {
    label: "Anklet",
    scaffold: "delicate anklet laid in a graceful curve, small elements spaced along a thin gold-fill or silver chain with a small lobster clasp",
    negatives: "NO long pendant, NO chime, NO bracelet (anklet is thinner and more delicate).",
    qcSubject: "delicate ankle bracelet (anklet)",
    defaultScene: "on cream linen with a few grains of sand, soft warm light",
    framing: "Horizontal composition, anklet arcing across left side, soft empty space on right for text overlay.",
  },
};

export function listProducts() {
  return Object.entries(PRODUCTS).map(([key, def]) => ({
    key,
    label: def.label,
    default_scene: def.defaultScene,
  }));
}

function resolveProduct(p?: string | null): { key: ProductKey; def: ProductDef } {
  const k = (p || "wind_chime").toLowerCase().replace(/[\s-]+/g, "_") as ProductKey;
  if (k in PRODUCTS) return { key: k, def: PRODUCTS[k] };
  return { key: "wind_chime", def: PRODUCTS.wind_chime };
}

// Build the AI prompt from picked chimes. Accepts {name, description?} — prefers description when present.
export function buildPrompt(
  chimes: Array<{name:string; description?:string|null}> | string[],
  extras?: string,
  keywords?: string,
  product?: string | null,
): string {
  const { def: prod } = resolveProduct(product);
  const parts: string[] = (chimes as any[]).map((c: any) =>
    typeof c === "string" ? c : (c.description?.trim() ? c.description.trim() : c.name)
  );
  const items = parts.join("; ");
  const scene = extras?.trim() || prod.defaultScene;
  const personal = keywords?.trim()
    ? ` Subtly incorporate these personal touches into the composition (as colors, charms, or beach elements): ${keywords.trim()}.`
    : "";
  const lower = items.toLowerCase();
  const isShell = /shell|conch|nautilus|scallop|whelk|cowrie|sand dollar|starfish|clam|oyster/.test(lower);
  const isGlass = /sea ?glass|crystal|gem|prism/.test(lower);
  const isWood = /driftwood|wood|bamboo/.test(lower);
  let materialDesc: string;
  let materialNote: string;
  if (isShell) {
    materialDesc = "real natural seashells and beach treasures";
    materialNote = "Each shell clearly visible with authentic natural texture, ridges, iridescent surface, and real color variation.";
  } else if (isGlass) {
    materialDesc = "polished sea glass and natural beach finds";
    materialNote = "Each glass piece frosted, smooth, translucent with soft pastel color, like genuine ocean-tumbled sea glass.";
  } else if (isWood) {
    materialDesc = "natural driftwood pieces and beach-found artisan elements";
    materialNote = "Each driftwood piece weathered, sun-bleached, with authentic grain.";
  } else {
    materialDesc = "natural handcrafted artisan elements";
    materialNote = "Each element clearly visible with rich realistic texture and authentic detail.";
  }
  return `Professional product photograph of a handcrafted ${prod.label.toLowerCase()} made from ${materialDesc}: ${items}. Assembly: ${prod.scaffold}. ${materialNote}${personal} ${scene}. Macro detail, sharp focus, soft warm golden hour light, shallow depth of field with creamy bokeh background. ${prod.negatives} ${prod.framing}`;
}

// Word-wrap helper
function wrapText(ctx: any, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    if (line) lines.push(line);
    lines.push(""); // paragraph break
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Composite final card: AI image left, text card right
export async function buildCard(opts: {
  aiImage: Buffer;
  title: string;
  message: string;
  footer?: string;
}): Promise<Buffer> {
  const W = 2048, H = 1024;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Right-side cream background
  ctx.fillStyle = "#faf6ed";
  ctx.fillRect(0, 0, W, H);

  // Draw AI image on left half (1024x1024)
  const img = await loadImage(opts.aiImage);
  ctx.drawImage(img, 0, 0, 1024, 1024);

  // Card area: x=1024..2048
  const CX = 1024, CW = 1024, PAD = 80;
  const TX = CX + PAD; // text left edge
  const TW = CW - PAD * 2; // text width

  // Inner border
  ctx.strokeStyle = "#c9b894";
  ctx.lineWidth = 2;
  ctx.strokeRect(CX + 40, 40, CW - 80, H - 80);

  // Title (Pinyon script)
  ctx.fillStyle = "#3a2c1e";
  ctx.textAlign = "center";
  ctx.font = "120px Pinyon";
  const titleLines = wrapText(ctx, opts.title, TW);
  let y = 200;
  for (const ln of titleLines) {
    ctx.fillText(ln, CX + CW / 2, y);
    y += 130;
  }

  // Divider w/ heart
  y += 20;
  ctx.strokeStyle = "#c9b894";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(TX, y); ctx.lineTo(CX + CW / 2 - 30, y);
  ctx.moveTo(CX + CW / 2 + 30, y); ctx.lineTo(CX + CW - PAD, y);
  ctx.stroke();
  ctx.font = "28px Cormorant";
  ctx.fillStyle = "#c9b894";
  ctx.fillText("♥", CX + CW / 2, y + 10);

  // Body (Cormorant serif)
  y += 70;
  ctx.fillStyle = "#3a2c1e";
  ctx.font = "36px Cormorant";
  ctx.textAlign = "center";
  const bodyLines = wrapText(ctx, opts.message, TW);
  for (const ln of bodyLines) {
    if (ln === "") { y += 24; continue; }
    ctx.fillText(ln, CX + CW / 2, y);
    y += 50;
  }

  // Footer divider
  y = H - 180;
  ctx.strokeStyle = "#c9b894";
  ctx.beginPath();
  ctx.moveTo(TX, y); ctx.lineTo(CX + CW / 2 - 30, y);
  ctx.moveTo(CX + CW / 2 + 30, y); ctx.lineTo(CX + CW - PAD, y);
  ctx.stroke();
  ctx.fillStyle = "#c9b894";
  ctx.fillText("♥", CX + CW / 2, y + 10);

  // Footer text
  if (opts.footer) {
    ctx.font = "italic 30px Cormorant";
    ctx.fillStyle = "#5a4a36";
    const fl = wrapText(ctx, opts.footer, TW - 100);
    let fy = y + 60;
    for (const ln of fl) {
      ctx.fillText(ln, CX + CW / 2, fy);
      fy += 42;
    }
  }

  return canvas.toBuffer("image/png");
}

export function saveResult(buf: Buffer, ext = "png"): string {
  const name = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  writeFileSync(join(RESULTS, name), buf);
  return name;
}
