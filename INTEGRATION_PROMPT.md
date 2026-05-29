# Coastal Creations Chime Builder API — Integration Brief

Paste this entire document to ChatGPT/Claude/Cursor along with your site's tech stack. The agent should be able to plug the API into your site without further questions.

---

## 1 · What this API does

Generates a personalized **handcrafted-product preview card** for Coastal Creations. The customer picks materials from a catalog (uploaded by admin), chooses a product type (wind chime, earrings, necklace, bracelet, ornament, mobile, garland, wreath, keychain, magnet, ring, anklet), provides a title / message / footer / scene / "personal touches" keywords, and the API returns a finished composite image: AI-generated photoreal product on the left, custom calligraphic message card on the right.

Supported product types (live list at `GET /api/products`):

| `product` key | Output |
|---|---|
| `wind_chime` *(default)* | Vertical hanging chime on driftwood top |
| `earrings` | Matched dangle pair w/ French hook posts |
| `necklace` | Pendant on delicate chain |
| `bracelet` | Curved wire-linked bracelet w/ clasp |
| `ornament` | Single hanging ornament w/ jute loop |
| `mobile` | Horizontal crossbar w/ suspended elements |
| `garland` | Long horizontal strung garland |
| `wreath` | Circular driftwood-base wreath |
| `keychain` | Small charm on split ring |
| `magnet` | Element on cork-backed fridge magnet |
| `ring` | Wire-wrapped adjustable ring |
| `anklet` | Thin chain ankle bracelet |

Each product has its own AI scaffold (how the materials assemble), negatives (what NOT to render — earrings ≠ chime), QC vision check ("is this clearly a pair of earrings?"), and default scene. Pass the `product` key on `/api/generate`, `/api/preview`, and `/api/suggest`. Omit it to default to `wind_chime`.

Internally:
- **GPT-Image** (cx/gpt-5.5-image and fallbacks via the 9router gateway, 4 Codex accounts) generates a 1024×1024 photoreal wind chime image from the prompt.
- **Vision QC loop** (free LLM via 9router) scores each generation 0–10 and regenerates until score ≥ 7 or 8 attempts max. Bad outputs (bamboo tubes when shells were requested, distorted shapes, missing personal touches) are caught and retried automatically.
- **Server-side canvas compositor** lays the AI image into a 2048×1024 card with real TTF fonts (Pinyon Script for the title, Cormorant Garamond for the body).
- **Vision describe** runs on every uploaded chime photo so the AI prompt knows "two orange knobbly starfish" not just "Starfish.jpg".

End-to-end time: ~30–90 seconds per `/api/generate` request (image gen is the slow part).

## 2 · Base URL & Auth

```
BASE_URL = https://chime-builder.onrender.com
```

Two zones:

| Zone | Endpoints | Auth |
|------|-----------|------|
| **Public** | `GET /api/chimes`, `POST /api/suggest`, `POST /api/generate`, `POST /api/preview`, `GET /uploads/:f`, `GET /results/:f`, `GET /health` | None |
| **Admin** | `POST /api/chimes` (upload), `PUT /api/chimes/:id`, `DELETE /api/chimes/:id`, `POST /api/chimes/:id/describe`, `GET /api/orders` | `X-Admin-Key: <ADMIN_KEY>` header |

**Critical security rule:** The `ADMIN_KEY` is a server-side secret. **Never put it in client-side JavaScript, HTML, or mobile bundles.** Always proxy admin calls through your own backend.

```
ADMIN_KEY = 4fdeec3d87d472f8560884dc15de0c1193701f7fe58cab7c0eafd9e274217985
```

(Treat as a password. If it leaks, rotate via the Render dashboard env var settings.)

## 3 · Rate limits (per IP, per hour)

| Endpoint | Limit |
|----------|-------|
| `GET /api/chimes`, `GET /uploads/:f`, `GET /results/:f` | 600 / hr |
| `POST /api/suggest` | 120 / hr |
| `POST /api/preview` | 60 / hr |
| `POST /api/generate` | 30 / hr |
| `POST /api/chimes` (upload) | 60 / hr |

Every response includes:
```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 27
X-RateLimit-Reset: 1780095555    (unix seconds)
```

On 429: body is `{"error":"rate limit exceeded","retry_after_seconds":1234}` and `Retry-After` header is set.

If your site proxies all traffic through a single backend IP, all rate limits will count against that one IP. Either (a) forward the original `X-Forwarded-For` / `CF-Connecting-IP` header from the client, or (b) add your own per-user rate limit upstream.

## 4 · Endpoints

### `GET /health`

Returns `{ "ok": true, "ts": 1780093765592 }`. Use for uptime checks. No auth, not rate-limited.

### `GET /` 

Returns the API self-description (endpoint list + version). Use to discover the live endpoint set.

---

### `GET /api/products`

List the supported product types. Use to populate a product picker in the UI.

**Response:**
```json
{
  "products": [
    { "key": "wind_chime", "label": "Wind Chime", "default_scene": "hanging on a seaside porch..." },
    { "key": "earrings",   "label": "Earrings",   "default_scene": "displayed on soft cream linen..." },
    { "key": "necklace",   "label": "Necklace",   "default_scene": "draped gracefully on cream linen..." }
  ]
}
```

The `key` is what you send in the `product` field of `/api/generate`, `/api/preview`, and `/api/suggest`. The `default_scene` is used when the caller doesn't supply a `scene` value.

---

### `GET /api/chimes`

List the chime catalog the customer picks from.

**Response:**
```json
{
  "chimes": [
    {
      "id": 1,
      "name": "Pink Scallop Shells",
      "description": "Ribbed shells in pink, white, beige with smooth and ridged surfaces.",
      "image_path": "chime_1780093773997_cd52b5.jpg",
      "image_url": "https://chime-builder.onrender.com/uploads/chime_1780093773997_cd52b5.jpg",
      "created": 1780093773
    }
  ]
}
```

Notes:
- `description` is auto-generated by vision LLM seconds after upload (may be `null` immediately after).
- `image_url` is the absolute, publicly-cacheable thumbnail URL. Use in `<img>` tags directly.
- Sorted newest-first.

---

### `POST /api/chimes` (admin)

Upload one or more chime images. Multipart form.

**Headers:**
```
X-Admin-Key: <ADMIN_KEY>
Content-Type: multipart/form-data
```

**Form fields (repeatable):**
- `images` — file (JPEG/PNG/WebP/GIF, ≤ 8 MB each)
- `names` — string (optional; if omitted, derived from filename). Repeated alongside `images` in order.

**Example (curl):**
```bash
curl -X POST https://chime-builder.onrender.com/api/chimes \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -F "images=@shell.jpg" -F "names=Pink Scallop" \
  -F "images=@driftwood.png" -F "names=Driftwood Branch"
```

**Response:**
```json
{
  "ok": true,
  "created": [
    {"id": 1, "name": "Pink Scallop", "image_path": "chime_...jpg", "image_url": "https://..."}
  ],
  "skipped": []
}
```

Files rejected for size / type appear in `skipped` with a reason.

Vision description runs asynchronously after the response returns — it'll appear in `GET /api/chimes` within ~5 seconds.

---

### `PUT /api/chimes/:id` (admin)

Rename a chime. Body: `{"name":"New Name"}`. Returns `{"ok":true}`.

---

### `DELETE /api/chimes/:id` (admin)

Remove a chime from the catalog. The underlying file is left on disk (ephemeral storage cleans it up on next deploy anyway). Returns `{"ok":true}`.

---

### `POST /api/chimes/:id/describe` (admin)

Re-run the vision describe on a chime (useful if the auto-describe didn't fire). Returns `{"ok":true,"description":"..."}`.

---

### `POST /api/suggest`

Get an AI-suggested title / message / footer / scene for the card, conditioned on the picked materials, product type, and any context already filled.

**Body:**
```json
{
  "field": "title",                // "title" | "message" | "footer" | "scene"
  "product": "earrings",           // optional, defaults to "wind_chime"
  "picks": [1, 2],                 // material IDs (optional but recommended)
  "title": "Forever In Our Hearts", // existing values for OTHER fields (context)
  "message": "...",
  "footer": "...",
  "scene": "cream linen with sand",
  "keywords": "grandfather loved yellow, sailboat charm"
}
```

The `product` value steers the brand voice toward that item — message text for `earrings` mentions wearing, for `wind_chime` mentions breezes.

**Response:**
```json
{
  "ok": true,
  "text": "Whispers From The Shore"
}
```

Each suggest call costs nothing (free LLM via 9router). Use freely.

---

### `POST /api/generate` 

The main event. Returns a finished composite card.

**Body:**
```json
{
  "picks": [1, 2],                  // material IDs — required, at least one
  "product": "wind_chime",          // optional, default "wind_chime"; see GET /api/products
  "title": "Forever In Our Hearts",
  "message": "Like the ocean's gentle whisper...",
  "footer": "May this chime bring comfort.",
  "scene": "hanging on a seaside porch overlooking the ocean at sunset",
  "keywords": "grandfather loved yellow, brass anchor charm",
  "seed": 42,                       // optional integer; same seed + picks + scene → deterministic
  "return_b64": false               // if true, response includes base64 PNG inline
}
```

When `product` is set to a non-chime value (e.g. `"earrings"`), the AI prompt switches to the matching scaffold (matched dangle pair, French hook posts, etc.), the QC vision check asks "is this clearly a pair of earrings?", and the default `scene` becomes that product's display setting (cream linen, soft morning light). If `scene` is supplied it overrides the default.

**Response (default):**
```json
{
  "ok": true,
  "result": "card_1780093773997_x7w9.png",
  "result_url": "https://chime-builder.onrender.com/results/card_1780093773997_x7w9.png",
  "prompt": "Professional product photograph of...",
  "qc": {
    "score": 9,
    "issues": ["minor rope clipping"],
    "attempts": 3,
    "seed": 908334269
  }
}
```

**Response (with `return_b64: true`):**
Same as above plus `"b64": "<base64 PNG>"`. Skip the round trip to `/results/` if you want to render or save the image immediately.

**Errors:**
- `400` — `picks` missing/empty
- `429` — rate limited
- `500` — `{"error":"image generation failed"}` — all upstream image providers down; retry with backoff

**Important:**
- Set HTTP timeout to **at least 120 seconds** on this endpoint. Default Render free tier compute is slow.
- `/results/:f` URLs are **ephemeral** (free Render plan resets each deploy). Either:
  - Render the card immediately and save it to your own storage, OR
  - Pass `return_b64: true` and persist the base64 to your CMS.

---

### `POST /api/preview`

Same shape as `/generate` but skips the QC loop and the canvas card overlay — returns the raw 1024×1024 AI image only. Use for fast iteration ("change the keywords, see new image").

Response: `{ok, result, result_url, prompt}` (+ `b64` if `return_b64`).

---

### `GET /api/orders` (admin)

List recent generation history (last N orders).

**Response:**
```json
{
  "orders": [
    {
      "id": 1,
      "title": "Forever In Our Hearts",
      "message": "...",
      "picks": [1, 2],
      "result_path": "card_...png",
      "result_url": "https://chime-builder.onrender.com/results/card_...png",
      "created": 1780093773
    }
  ]
}
```

## 5 · Suggested integration flow

### A. Customer-facing flow (no auth needed from browser)

```
1. Page load:
   GET /api/chimes → render thumbnail grid

2. Customer clicks chimes → tracks `picks: number[]` in state.

3. Customer types keywords / clicks "✨ Suggest" buttons:
   POST /api/suggest with {field, picks, title, message, footer, scene, keywords}
   → fill the field with response.text

4. Customer clicks "Generate Preview":
   POST /api/generate with full body, return_b64: true
   Show a loading state (30-90 seconds)
   Render <img src="data:image/png;base64,{b64}"> or save to your CDN

5. Customer can re-roll by changing seed or keywords and hitting Generate again.
```

The browser hits the API directly (CORS allows `*` — restrict via `CORS_ORIGINS` env var when going to prod). No `ADMIN_KEY` required.

### B. Admin flow (your team)

Upload chimes via an internal admin panel that proxies through your backend:

```
[Your team's admin UI]
       ↓ (your own auth, e.g. session cookie)
[Your backend]
       ↓ adds X-Admin-Key header
[Chime API]
```

**Never** ship the admin key to a browser. If you must show a direct admin UI, host a private CMS that hits the API server-side.

## 6 · CORS

CORS is currently wide-open (`CORS_ORIGINS=*`). Tighten when going to prod:

Set env var on the Render service:
```
CORS_ORIGINS=https://www.coastalcreations.com,https://staging.coastalcreations.com
```

Restart the service.

## 7 · Security checklist (already done)

- [x] All write/admin endpoints require `X-Admin-Key` header (401 if missing/wrong)
- [x] Per-IP rate limits on all POST endpoints
- [x] Path traversal blocked on `/uploads/:f` and `/results/:f` (regex-validated filename)
- [x] Upload MIME type allowlist (JPEG/PNG/WebP/GIF only)
- [x] Upload size cap (8 MB per file, configurable via `UPLOAD_MAX_BYTES`)
- [x] All DB queries use prepared statements (no SQL injection)
- [x] No HTML/script content rendered by the server (no XSS attack surface)
- [x] CORS configurable per-origin
- [x] HTTPS enforced by Render edge
- [x] LLM API keys held in Render env vars (not in repo, not in client)
- [x] 9router gateway acts as auth boundary for the underlying model accounts

### What's not protected (yet)

- **Replay attacks**: no request signing. If the API URL leaks, anyone can spam `/generate` and burn the rate limit. Mitigation: tight `CORS_ORIGINS`.
- **Bot scraping**: no CAPTCHA. Easy to script. Mitigation: front with Cloudflare Turnstile if abuse arises.
- **Inventory enumeration**: `/api/chimes` is fully public — anyone can list the catalog. By design.

## 8 · Production-readiness next steps (when traffic grows)

| Concern | Now (Render free) | Upgrade |
|---------|--------------------|---------|
| Cold start (15 min idle → ~30s wake-up) | OK for low traffic | Render Starter ($7/mo, always-on) |
| Ephemeral storage (catalog resets on deploy) | Re-upload after each deploy | Persistent disk ($1/mo, 1GB) or move catalog to Postgres |
| Result URLs expire on deploy | Pass `return_b64:true` and save client-side | Persistent disk + CDN for `/results/` |
| Single instance | OK for ≤ 10 concurrent generates | Scale to N instances + Redis-backed rate limit |
| Free 9router pools (Codex × 4, Cline × 8 vision) | Plenty for low traffic | Add your own OpenAI key as fallback |

## 9 · Environment variables (Render dashboard)

| Var | Required | Value |
|-----|----------|-------|
| `ROUTE9_API_KEY` | yes | 9router gateway key (already set) |
| `ROUTE9_URL` | yes | `https://route-9.duckdns.org/v1` |
| `ROUTE9_MODELS` | yes | Comma-separated chat models (LLM chain for text + vision) |
| `ROUTE9_IMG_MODELS` | yes | Comma-separated image models (`cx/gpt-5.5-image,...`) |
| `ADMIN_KEY` | yes | Long random hex for admin endpoints |
| `CORS_ORIGINS` | no | `*` or comma-separated allowed origins |
| `UPLOAD_MAX_BYTES` | no | Default `8388608` (8 MB) |
| `QC_MAX_ATTEMPTS` | no | Default `8` (max regen attempts on bad image) |
| `QC_PASS_SCORE` | no | Default `7` (vision score threshold to ship) |

## 10 · Quick-start TypeScript snippet

```ts
const API = "https://chime-builder.onrender.com";

// Public — call from browser
export async function listChimes() {
  const r = await fetch(`${API}/api/chimes`);
  if (!r.ok) throw new Error(`chimes ${r.status}`);
  const { chimes } = await r.json();
  return chimes;
}

export async function suggest(field: "title"|"message"|"footer"|"scene", ctx: {
  picks?: number[];
  title?: string;
  message?: string;
  footer?: string;
  scene?: string;
  keywords?: string;
}) {
  const r = await fetch(`${API}/api/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ field, ...ctx }),
  });
  if (!r.ok) throw new Error(`suggest ${r.status}`);
  return (await r.json()).text as string;
}

export async function generate(req: {
  picks: number[];
  title?: string;
  message?: string;
  footer?: string;
  scene?: string;
  keywords?: string;
  seed?: number;
}) {
  const r = await fetch(`${API}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...req, return_b64: true }),
    signal: AbortSignal.timeout(180_000), // 3 min
  });
  if (!r.ok) throw new Error(`generate ${r.status}`);
  const out = await r.json();
  // out.b64 is the finished card PNG as base64 — render directly or upload to your storage
  return out;
}

// Server-only — admin
export async function uploadChimes(files: { name: string; blob: Blob }[]) {
  const fd = new FormData();
  for (const { name, blob } of files) {
    fd.append("images", blob);
    fd.append("names", name);
  }
  const r = await fetch(`${API}/api/chimes`, {
    method: "POST",
    headers: { "X-Admin-Key": process.env.CHIME_ADMIN_KEY! },
    body: fd,
  });
  if (!r.ok) throw new Error(`upload ${r.status}`);
  return r.json();
}
```

## 11 · Failure modes to handle

| Symptom | Cause | Handle |
|---------|-------|--------|
| `429` from any endpoint | Rate limit | Wait `Retry-After` seconds, retry |
| `500` from `/api/generate` | All image providers down | Show "AI is busy, try again in a minute" |
| `/generate` returns image but `qc.score < 7` | Couldn't find a perfect render in `QC_MAX_ATTEMPTS` tries | Image still usable; show qc.issues to internal team or let customer accept/reject |
| First request after idle takes 30+ seconds longer than normal | Render free tier cold start | Show a "warming up..." spinner |
| `image_url` / `result_url` returns 404 | Ephemeral storage was reset on a redeploy | Use `return_b64` or store images in your own CDN immediately |

## 12 · Done. Build it.

Plug the snippets in section 10 into your site's checkout / personalization flow. Use section 5 as the UX outline. Tell the agent: "implement this against my [Next.js / Astro / Rails / WordPress / Shopify Hydrogen / etc.] site using the patterns in section 5 and the security rules in section 2."
