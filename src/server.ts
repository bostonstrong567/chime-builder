import { serve } from "@hono/node-server";
import { app, ROOT } from "./core.js";
import "./routes.js";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

// Static: serve uploaded chime thumbs + generated results (ephemeral on Render).
app.get("/uploads/:f", (c) => {
  const p = join(ROOT, "uploads", c.req.param("f"));
  if (!existsSync(p)) return c.notFound();
  const b = readFileSync(p);
  const ext = p.split(".").pop()?.toLowerCase();
  const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return new Response(b, { headers: { "content-type": ct } });
});

app.get("/results/:f", (c) => {
  const p = join(ROOT, "results", c.req.param("f"));
  if (!existsSync(p)) return c.notFound();
  const b = readFileSync(p);
  const ct = p.endsWith(".png") ? "image/png" : "image/jpeg";
  return new Response(b, { headers: { "content-type": ct } });
});

// API root + health check
app.get("/", (c) => c.json({
  name: "Coastal Creations Chime Builder API",
  version: "1.0.0",
  endpoints: [
    "GET  /health",
    "GET  /api/chimes",
    "POST /api/chimes (multipart: images, names)",
    "PUT  /api/chimes/:id",
    "DELETE /api/chimes/:id",
    "POST /api/chimes/:id/describe",
    "POST /api/suggest",
    "POST /api/generate",
    "POST /api/preview",
    "GET  /api/orders",
    "GET  /uploads/:f",
    "GET  /results/:f",
  ],
}));

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

const PORT = Number(process.env.PORT || 4711);
serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" });
console.log(`chime-builder API up on http://0.0.0.0:${PORT}`);
