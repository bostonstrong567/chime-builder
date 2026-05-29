import type { Context, Next } from "hono";

// ---------- ADMIN AUTH ----------
const ADMIN_KEY = process.env.ADMIN_KEY || "";

export async function requireAdmin(c: Context, next: Next) {
  if (!ADMIN_KEY) return c.json({ error: "server not configured (missing ADMIN_KEY)" }, 503);
  const provided = c.req.header("x-admin-key") || c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== ADMIN_KEY) return c.json({ error: "unauthorized" }, 401);
  return next();
}

// ---------- IN-MEMORY RATE LIMIT ----------
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 5 * 60_000).unref?.();

function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function rateLimit(opts: { limit: number; windowMs: number; key?: (c: Context) => string }) {
  return async (c: Context, next: Next) => {
    const key = (opts.key ? opts.key(c) : `${clientIp(c)}:${c.req.path}`);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    c.header("X-RateLimit-Limit", String(opts.limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, opts.limit - b.count)));
    c.header("X-RateLimit-Reset", String(Math.floor(b.resetAt / 1000)));
    if (b.count > opts.limit) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      c.header("Retry-After", String(retry));
      return c.json({ error: "rate limit exceeded", retry_after_seconds: retry }, 429);
    }
    return next();
  };
}

// Convenience presets — generous defaults
export const limits = {
  read:     { limit: 600, windowMs: 60 * 60_000 },  // 600/hr/ip per route
  suggest:  { limit: 120, windowMs: 60 * 60_000 },  // 120/hr/ip
  preview:  { limit:  60, windowMs: 60 * 60_000 },  // 60/hr/ip
  generate: { limit:  30, windowMs: 60 * 60_000 },  // 30/hr/ip (60s per call)
  upload:   { limit:  60, windowMs: 60 * 60_000 },  // 60/hr/ip
};

// ---------- CORS ----------
const ALLOW_ORIGINS = (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);

export function cors(c: Context, next: Next) {
  const origin = c.req.header("origin") || "";
  const allowed = ALLOW_ORIGINS.includes("*") || ALLOW_ORIGINS.includes(origin);
  if (allowed) c.header("Access-Control-Allow-Origin", ALLOW_ORIGINS.includes("*") ? "*" : origin);
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  c.header("Access-Control-Allow-Headers", "content-type,authorization,x-admin-key");
  c.header("Access-Control-Max-Age", "86400");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
}

// ---------- PATH SAFETY ----------
// Prevent traversal: only allow [A-Za-z0-9._-] in filename, no slashes/dots-only.
export function safeFilename(raw: string): string | null {
  if (!raw) return null;
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null;
  if (raw.length > 128) return null;
  return raw;
}

// ---------- UPLOAD VALIDATION ----------
export const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 8 * 1024 * 1024); // 8 MB
export const UPLOAD_ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);
