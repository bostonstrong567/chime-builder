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
  if (!R9_KEY) return null;
  for (const model of R9_IMG_MODELS) {
    try {
      const r = await fetch(R9_IMG_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${R9_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024", quality: "auto", output_format: "png" }),
      });
      if (!r.ok) continue;
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
    } catch {}
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

// QC — score generated image against material expectations. Returns 0-10 + issues.
export async function qcImage(buf: Buffer, expectedMaterials: string): Promise<{score:number; issues:string[]; ok:boolean}> {
  const fail = { score: 5, issues: [] as string[], ok: true };
  try {
    const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
    const txt = await chatComplete([{
      role: "user",
      content: [
        { type: "text", text: `Evaluate this image as a handcrafted wind chime made from: ${expectedMaterials}.

Check:
1. Is the main subject clearly a hanging wind chime (not bamboo tubes, not random objects)?
2. Are the materials visually consistent with the description (right colors, right items)?
3. Is composition usable (chime on left, empty/soft right area for text overlay)?
4. Any obvious AI artifacts (mangled hands, extra heads, distorted shells)?

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
const FIELD_GUIDE: Record<SuggestField, string> = {
  title: "A short, heartfelt card title (3-6 words). Romantic, memorial, or celebratory. Examples: 'Forever In Our Hearts', 'Whispers From The Sea', 'In Loving Memory'.",
  message: "A heartfelt 2-3 sentence message (30-50 words) for a wind chime keepsake card. Evocative, warm, coastal imagery. No corny clichés. Examples: 'Like the ocean\\'s gentle whisper, this chime carries memories that never fade. Each shell tells a story of love that lingers long after the tide pulls back.'",
  footer: "A short closing wish (10-20 words), italic-feel. Examples: 'May this chime bring comfort, peace, and cherished memories with every gentle breeze.'",
  scene: "A short 8-15 word scene/setting description for the chime to hang in. Examples: 'hanging on a sunlit seaside porch overlooking the ocean at sunset', 'beside a window with soft morning light over a coastal garden'.",
};
export async function suggestText(
  field: SuggestField,
  chimeDescs: string[],
  context: Partial<Record<SuggestField, string>> & { keywords?: string },
): Promise<string | null> {
  const ctxLines: string[] = [];
  if (chimeDescs.length) ctxLines.push(`Wind chime contains: ${chimeDescs.join("; ")}`);
  if (context.keywords?.trim()) ctxLines.push(`Personal touches / memories to weave in: ${context.keywords.trim()}`);
  for (const k of ["title","message","footer","scene"] as SuggestField[]) {
    if (k !== field && context[k]?.trim()) ctxLines.push(`Existing ${k}: ${context[k]!.trim()}`);
  }
  const sys = `You write heartfelt copy for handcrafted wind chime keepsake cards. Coastal Creations brand voice: warm, sincere, slightly poetic, never schmaltzy. Output ONLY the requested text — no preamble, no quotes, no labels.`;
  const usr = `${ctxLines.join("\n")}\n\nGenerate the ${field} only. ${FIELD_GUIDE[field]}`;
  const txt = await chatComplete([
    { role: "system", content: sys },
    { role: "user", content: usr },
  ], 180, 0.9);
  if (!txt) return null;
  return txt.replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, field === "title" ? 80 : 500);
}

// Build the AI prompt from picked chimes. Accepts {name, description?} — prefers description when present.
export function buildPrompt(
  chimes: Array<{name:string; description?:string|null}> | string[],
  extras?: string,
  keywords?: string,
): string {
  const parts: string[] = (chimes as any[]).map((c: any) =>
    typeof c === "string" ? c : (c.description?.trim() ? c.description.trim() : c.name)
  );
  const items = parts.join("; ");
  const scene = extras?.trim() || "hanging on a seaside porch overlooking the ocean at sunset";
  const personal = keywords?.trim()
    ? ` Subtly incorporate these personal touches into the chime composition (as colors, charms, or beach elements): ${keywords.trim()}.`
    : "";
  const lower = items.toLowerCase();
  const isShell = /shell|conch|nautilus|scallop|whelk|cowrie|sand dollar|starfish|clam|oyster/.test(lower);
  const isGlass = /sea ?glass|crystal|gem|prism/.test(lower);
  const isWood = /driftwood|wood|bamboo/.test(lower);
  let materialDesc: string;
  let materialNote: string;
  let negatives: string;
  if (isShell) {
    materialDesc = "real natural seashells and beach treasures";
    materialNote = "Each shell clearly visible with authentic natural texture, ridges, iridescent surface, and real color variation.";
    negatives = "Absolutely NO bamboo tubes, NO metal pipes, NO glass cylinders — only real seashells hanging from twine.";
  } else if (isGlass) {
    materialDesc = "polished sea glass and natural beach finds";
    materialNote = "Each glass piece frosted, smooth, translucent with soft pastel color, like genuine ocean-tumbled sea glass.";
    negatives = "NO bamboo tubes, NO metal pipes — only sea glass and natural beach elements hanging from twine.";
  } else if (isWood) {
    materialDesc = "natural driftwood pieces and beach-found artisan elements";
    materialNote = "Each driftwood piece weathered, sun-bleached, with authentic grain.";
    negatives = "NO bamboo tubes, NO metal pipes, NO plastic.";
  } else {
    materialDesc = "natural handcrafted artisan elements";
    materialNote = "Each element clearly visible with rich realistic texture and authentic detail.";
    negatives = "NO generic bamboo tubes, NO metal pipes, NO mass-produced look.";
  }
  return `Professional product photograph of a handcrafted wind chime sculpture made entirely from ${materialDesc}: ${items}. Each piece is individually strung on natural jute twine, dangling vertically from a small piece of weathered driftwood at the top, with small knots between each piece. ${materialNote}${personal} ${scene}. Macro detail, sharp focus, soft warm golden hour light, shallow depth of field with creamy bokeh background. ${negatives} Vertical portrait composition, chime hangs on left side of frame, soft empty background on right side for text.`;
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
