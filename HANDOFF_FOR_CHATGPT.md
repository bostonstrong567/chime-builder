# Chime Builder — Handoff Brief for ChatGPT / Codex / future AI agents

> Paste this entire document into your AI assistant. It explains what was built, where it lives, what changed recently, and how to keep working on it.

---

## 1 · What this project is

A small JSON HTTP API for **Coastal Creations** that generates AI preview images of handcrafted artisan products (wind chimes, earrings, necklaces, bracelets, ornaments, mobiles, garlands, wreaths, keychains, magnets, rings, anklets) made from natural beach materials (seashells, driftwood, sea glass, starfish, etc.).

The customer:

1. Picks one or more material photos from a catalog uploaded by the shop owner.
2. Optionally adds personal touches (colors, charms, memories — "grandfather loved yellow", "small brass anchor").
3. Receives a 2048×1024 keepsake card: AI-generated photoreal product on the left, calligraphic title + heartfelt message + italic footer on the right.

The image generation runs an **AI quality-control retry loop** — a vision model scores each image 0-10 and regenerates until either the score hits the pass threshold or a hard ceiling is reached. The client only gets the best-scoring attempt.

**Live URL:** https://chime-builder.onrender.com
**GitHub repo:** https://github.com/bostonstrong567/chime-builder
**Render dashboard:** https://dashboard.render.com/web/srv-d8d14t7avr4c73f79e30

---

## 2 · Stack & runtime

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | type safety, fast iteration |
| Runtime | Bun (1.x, Debian image) | fast, native fetch + sqlite, single binary |
| HTTP framework | Hono | tiny, OpenAI-style middleware, runs on bun |
| DB | bun:sqlite (in-memory effectively, file on `/app/data/chimes.db`) | zero ops |
| Image lib | node-canvas (`canvas` package) | server-side composition of AI image + text card |
| Fonts | Pinyon Script + Cormorant Garamond TTFs in `fonts/` | match the brand voice |
| Image generation | 9router (`route-9.duckdns.org`) → `cx/gpt-5.5-image` and fallbacks | free, uses 4 Codex accounts pool |
| Vision (describe + QC) + text (suggest) | 9router → Claude Haiku 4.5 / Gemini Flash Lite / GPT-5.5 | free, uses Cline/Codex/GitHub pools |
| Deploy | Render.com (free tier, Docker runtime, Oregon) | zero ops, auto-deploys from `main` |

**Only external dependency is the 9router gateway** (`https://route-9.duckdns.org/v1`). Everything else lives inside the Render container.

---

## 3 · Repo structure

```
chime-builder/
├── Dockerfile                  # bun base + canvas system deps (cairo, pango, jpeg, etc.)
├── render.yaml                 # Render Blueprint (declares the web service + env vars)
├── package.json                # bun deps: hono, @hono/node-server, canvas, better-sqlite3 (unused), sharp (unused)
├── tsconfig.json
├── .gitignore                  # excludes data/, uploads/, results/, *.log
├── .dockerignore
├── fonts/                      # 5 TTF font files
│   ├── PinyonScript-Regular.ttf
│   ├── CormorantGaramond-Regular.ttf
│   ├── CormorantGaramond-Bold.ttf
│   ├── CormorantGaramond-Italic.ttf
│   └── CormorantGaramond-BoldItalic.ttf
├── src/
│   ├── server.ts               # Bun.serve entry, static file serving, CORS, /, /health
│   ├── core.ts                 # Hono app, sqlite schema, font registration, paths
│   ├── routes.ts               # all /api/* handlers
│   ├── gen.ts                  # AI image gen + vision QC + text suggest + product registry
│   └── security.ts             # admin-key auth, rate limiter, CORS middleware, path safety
├── INTEGRATION_PROMPT.md       # the spec we hand to your site's dev
└── HANDOFF_FOR_CHATGPT.md      # this file
```

Ignored at runtime: `data/`, `uploads/`, `results/` (ephemeral storage on Render free tier — wiped every redeploy).

---

## 4 · The 12 product types

Implemented in `src/gen.ts` under `PRODUCTS: Record<ProductKey, ProductDef>`. Each product has:

- `label` — display name
- `scaffold` — how the materials are physically assembled (e.g. "matched pair of dangle earrings, French hook posts, wire-wrapped")
- `negatives` — what the model must NOT draw (e.g. earrings prompt forbids "long strands, chime structure")
- `qcSubject` — phrasing fed to the QC vision check (e.g. "matched pair of dangle earrings")
- `defaultScene` — fallback if caller doesn't supply a scene
- `framing` — composition guidance (left-half subject, right-half empty for text overlay)

Supported keys: `wind_chime` (default), `earrings`, `necklace`, `bracelet`, `ornament`, `mobile`, `garland`, `wreath`, `keychain`, `magnet`, `ring`, `anklet`.

`GET /api/products` returns the list with `key`, `label`, `default_scene`.

**To add a new product type** (e.g. `pin`, `brooch`, `bookmark`):

1. Open `src/gen.ts`.
2. Add a new entry to `PRODUCTS`.
3. Add the key to the `ProductKey` type union.
4. Commit + push — Render auto-deploys.

No other file needs to change. The same routes/QC/suggest pipeline automatically picks it up.

---

## 5 · API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | none | Endpoint index + version |
| GET | `/health` | none | Liveness probe |
| GET | `/api/products` | none, rate-limited | List supported product types |
| GET | `/api/chimes` | none, rate-limited | List catalog (chime/material photos) |
| POST | `/api/chimes` | `X-Admin-Key` | Upload chime image(s) (multipart) |
| PUT | `/api/chimes/:id` | `X-Admin-Key` | Rename |
| DELETE | `/api/chimes/:id` | `X-Admin-Key` | Delete |
| POST | `/api/chimes/:id/describe` | `X-Admin-Key` | Re-run vision auto-description |
| POST | `/api/suggest` | none, rate-limited | AI text suggestion for title/message/footer/scene |
| POST | `/api/generate` | none, rate-limited | Full card with QC retry loop |
| POST | `/api/preview` | none, rate-limited | Raw AI image, no card overlay |
| GET | `/api/orders` | `X-Admin-Key` | Order history |
| GET | `/uploads/:f` | none, rate-limited | Serve chime thumbnail (filename validated) |
| GET | `/results/:f` | none, rate-limited | Serve generated card |

All endpoints accept the `product` field (in body or query) to switch product type. Defaults to `wind_chime` for back-compat.

`/api/generate` and `/api/preview` also accept `return_b64: true` → response includes inline base64 PNG, useful when the host site wants to upload the image to its own storage immediately (Render free tier `/results/` URLs are ephemeral).

Full spec lives in `INTEGRATION_PROMPT.md` — that's what we hand to the team integrating the API into their site.

---

## 6 · Environment variables (set in Render dashboard, NOT in repo)

| Var | Required | Purpose | Current value |
|---|---|---|---|
| `ROUTE9_API_KEY` | yes | 9router gateway auth | (set in Render) |
| `ROUTE9_URL` | yes | gateway base URL | `https://route-9.duckdns.org/v1` |
| `ROUTE9_MODELS` | yes | chat/vision fallback chain (comma-separated) | `cl/google/gemini-3.1-flash-lite-preview,smart-worker,gh/claude-haiku-4.5` |
| `ROUTE9_IMG_MODELS` | yes | image-gen fallback chain | `cx/gpt-5.5-image,cx/gpt-5.4-image,cx/gpt-5.3-image,cx/gpt-5.2-image` |
| `ADMIN_KEY` | yes | required header for write endpoints | (long random hex) |
| `CORS_ORIGINS` | no | `*` or comma-separated allowlist | `*` |
| `UPLOAD_MAX_BYTES` | no | per-upload size cap | `8388608` (8 MB) |
| `QC_MAX_ATTEMPTS` | no | regen retry ceiling | `8` |
| `QC_PASS_SCORE` | no | vision score threshold to ship | `7` |

All other settings live in code.

**To rotate a secret**: Render dashboard → service → Environment → edit value → save → service auto-restarts.

---

## 7 · What we built / changed recently (chronological)

1. **Stripped UI** — deleted `public/admin.html`, `public/pick.html`, all JS. This is API-only now. (Old UI flow was a single-machine self-hosted setup; we converted it to a service the brand's website calls.)
2. **Slimmed routes.ts** — dropped the `/api/admin/*` prefix; everything is just `/api/<resource>`. Added `/health`.
3. **Added `result_url` + `b64`** — generate response now returns both an absolute URL and (optionally) inline base64 PNG so clients can pick.
4. **Wrote `Dockerfile`** — bun base image + apt deps for `canvas` (cairo, pango, giflib, librsvg, jpeg, pixman, liberation fonts).
5. **Wrote `render.yaml`** — declarative Blueprint so Render knows how to build/deploy.
6. **Pushed to GitHub** — `bostonstrong567/chime-builder`, public.
7. **Deployed to Render** — free tier, Oregon region, auto-deploys from `main` branch.
8. **Built `security.ts`** — admin-key middleware, per-IP rate limiter (in-memory Map, generous defaults), CORS, path traversal blocker, upload size/MIME validation.
9. **Threaded security middleware** through all routes; sanitized `/uploads/:f` and `/results/:f` filenames against `[A-Za-z0-9._-]` only.
10. **Added `ADMIN_KEY` env var** on Render (long random hex). All write/admin endpoints now require `X-Admin-Key` or `Authorization: Bearer` header.
11. **Diagnosed and fixed** an initial gen failure where the Render container couldn't reach the local 9router (`localhost:20128`); switched `ROUTE9_URL` to the public DuckDNS `route-9.duckdns.org` URL. End-to-end verified working: gen call returns score 9, first attempt, ~90 s.
12. **Wrote `INTEGRATION_PROMPT.md`** — full spec, examples, security rules, TypeScript snippets, failure modes. Paste to ChatGPT/Cursor/Codex along with the host site's stack and they produce working integration code.
13. **Added 12-product registry** (`PRODUCTS` in `src/gen.ts`) — `wind_chime`, `earrings`, `necklace`, `bracelet`, `ornament`, `mobile`, `garland`, `wreath`, `keychain`, `magnet`, `ring`, `anklet`. Each with its own scaffold prompt, negatives, QC subject, default scene, and framing.
14. **Wired `product` param** through `buildPrompt` (image prompt), `qcImage` (vision check phrasing), `suggestText` (title/message/footer copy adapts to product type). All product-aware.
15. **Added `GET /api/products`** — lists supported product keys + labels + default scenes.
16. **Deleted default seeded chimes** — the catalog now starts empty on every deploy; the shop owner re-uploads their materials post-deploy (Render free tier has ephemeral storage).
17. **Removed "Square composition" framing** from the earrings product (`src/gen.ts`). The AI image gen always returns 1024×1024 regardless of prompt wording; the explicit "Square composition" phrasing was confusing the model. All products now use plain "subject on left, empty right for text overlay" framing.

---

## 8 · How to make changes (the editing workflow)

The repo is at https://github.com/bostonstrong567/chime-builder. Render auto-deploys any push to `main`.

### Option A — clone + edit + push (most flexible)

```bash
gh repo clone bostonstrong567/chime-builder
cd chime-builder

# make changes in src/, fonts/, Dockerfile, etc.

git add .
git commit -m "describe your change"
git push origin main
```

Render notices the push within a few seconds and triggers a build. Build → live in ~3-5 minutes (the Dockerfile installs node-canvas system deps which is the slow part — it's cached so subsequent builds are faster).

You can watch the deploy at https://dashboard.render.com/web/srv-d8d14t7avr4c73f79e30 → "Logs" tab.

### Option B — GitHub web UI (single file edits)

1. Open https://github.com/bostonstrong567/chime-builder.
2. Navigate to the file (e.g. `src/gen.ts`).
3. Click the pencil icon (top right).
4. Edit.
5. Scroll down → "Commit changes" → commit directly to `main`.
6. Render auto-deploys.

Good for tiny fixes — env var tweaks, prompt tweaks, copy fixes.

### Option C — Codex CLI / Claude Code

Same as Option A but you give the AI agent shell access and it does the clone/edit/commit/push for you. The agent should use `gh` (already authenticated) and standard git commands.

### Option D — Render dashboard env var only (no code change)

For changing prompt verbosity, rate limits via env, the admin key, allowed CORS origins, or the model chain: Render dashboard → Environment → edit value → save. No git push needed; the service restarts automatically (~10 s).

---

## 9 · How to test changes

### Health check

```bash
curl https://chime-builder.onrender.com/health
# {"ok":true,"ts":1780...}
```

### List products

```bash
curl https://chime-builder.onrender.com/api/products
```

### Generate (full flow — needs at least one chime in catalog)

```bash
ADMIN_KEY=<value>

# 1. upload a chime
curl -X POST https://chime-builder.onrender.com/api/chimes \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -F "images=@shell.jpg" -F "names=Pink Scallop"

# 2. generate a card (earrings example)
curl -X POST https://chime-builder.onrender.com/api/generate \
  -H "Content-Type: application/json" \
  --max-time 300 \
  -d '{
    "picks": [1],
    "product": "earrings",
    "title": "Made With Love",
    "keywords": "pearl accent",
    "seed": 42
  }'
```

### Local development

```bash
cd chime-builder
bun install
ROUTE9_API_KEY=... ROUTE9_URL=https://route-9.duckdns.org/v1 \
  ROUTE9_MODELS=cl/google/gemini-3.1-flash-lite-preview,smart-worker \
  ROUTE9_IMG_MODELS=cx/gpt-5.5-image \
  ADMIN_KEY=test \
  bun src/server.ts
# listens on http://localhost:4711
```

You can also run `bun -e '...'` snippets to exercise individual functions — `buildPrompt`, `qcImage`, etc.

---

## 10 · Operational notes / gotchas

- **Render free tier cold starts.** After ~15 minutes of inactivity the instance suspends. First request after suspension takes ~30 seconds to warm up. Subsequent requests are fast. Upgrade to **Render Starter** ($7/mo) to keep the instance always-on.
- **Ephemeral filesystem.** `data/chimes.db`, `uploads/`, and `results/` all wipe on every redeploy (and on every instance restart). For permanent storage: add a Render persistent disk (~$1/mo for 1 GB), and move blobs to S3/R2 if you want CDN delivery. The catalog (`chimes` table) is the main thing affected — the shop owner has to re-upload chime photos after every redeploy until persistence is added.
- **Result URL expiration.** `/results/<file>.png` URLs work until the next redeploy. If the host site needs permanent images, it should request `return_b64: true` and persist the base64 to its own storage immediately on receipt.
- **Single instance.** No horizontal scaling on free tier. The in-memory rate limit Map is fine on a single instance. If you scale out, swap for a Redis-backed limiter.
- **9router dependency.** All AI calls go through `route-9.duckdns.org`. If that gateway is down, all generation fails. To add a backup: edit `src/gen.ts`, add a fallback provider in `try9RouterImage` (e.g. a direct OpenAI call with your own key), then add the key as a Render env var.
- **Image generation takes 30–120 seconds.** This is normal — GPT-Image runs server-side. The QC loop may add more attempts if the first image is poor. Always set HTTP timeout to at least 180 seconds on `/api/generate` from the client side.
- **No persistent admin UI.** Admins use either curl/Postman or a custom internal panel that proxies through their backend (which holds the admin key). There is no `/admin` web page in this service.

---

## 11 · Common upcoming tasks (with hints)

| Task | Where to change | Hint |
|---|---|---|
| Add a new product type | `src/gen.ts` → `PRODUCTS` | Add scaffold/negatives/qcSubject/defaultScene/framing |
| Add a new card font | `fonts/` (TTF file) + `src/core.ts` (`registerFont`) + `src/gen.ts` (`buildCard` font name) | Copy a TTF into `fonts/`, commit, push |
| Change card layout / dimensions | `src/gen.ts` → `buildCard()` | Currently 2048×1024, AI image left half, text right half |
| Adjust QC retry strictness | Render env vars `QC_MAX_ATTEMPTS` and `QC_PASS_SCORE` | No code change needed |
| Add a new AI model to the chain | `ROUTE9_MODELS` or `ROUTE9_IMG_MODELS` env var | Comma-separated; first model tried first |
| Tighten CORS to specific domains | `CORS_ORIGINS` env var | Comma-separated; no spaces |
| Add a new admin endpoint | `src/routes.ts` | Wrap with `requireAdmin` middleware |
| Add a new public endpoint | `src/routes.ts` | Wrap with `rateLimit(limits.read)` or appropriate preset |
| Add persistent storage (post-MVP) | New Render disk + change `core.ts` paths + adjust Dockerfile to mount | See Render docs for disks |
| Add background-job mode (async generate) | New table `jobs`, queue worker, `GET /api/jobs/:id` | Not implemented yet |

---

## 12 · Quick FAQ for ChatGPT

**Q: Where are the AI model API keys?**
A: Inside the Render container, as env vars. Not in the repo. The frontend never sees them. The only key exposed to the host site is the `ADMIN_KEY` for admin endpoints, which lives on the host site's backend.

**Q: Can the host site call `/api/generate` directly from the browser?**
A: Yes — that endpoint requires no auth. CORS allows `*` by default (tighten via `CORS_ORIGINS` env var for production). Rate limited per-IP at 30/hour.

**Q: How do we add an admin UI to upload chimes?**
A: Build it on the host site (e.g. inside their Shopify admin / Next.js admin panel). The host site's backend holds `ADMIN_KEY` and proxies the multipart upload to `POST /api/chimes`. Do NOT ship `ADMIN_KEY` to a browser.

**Q: What happens if 9router goes down?**
A: All AI calls fail (image gen, vision describe, QC, text suggest). The API itself stays up (`/health` returns 200) but `/api/generate` returns 500. To add resilience: layer a direct OpenAI / Anthropic key as fallback in `src/gen.ts` (see `try9RouterImage` and `chatComplete`).

**Q: Why isn't there a database besides sqlite?**
A: Simplicity. The catalog is small. The product is ephemeral by design on free tier. If/when the shop wants persistent catalog + order history, migrate to Render Postgres (free 1 month, then $7/mo) — change `core.ts` from `bun:sqlite` to `Bun.sql` and update the schema in the constructor.

**Q: How do we deploy our changes?**
A: `git push origin main`. Render auto-deploys. Watch the dashboard for build progress. No CLI command needed beyond the push.

**Q: How do we roll back a bad deploy?**
A: Render dashboard → service → Deploys tab → find the previous good deploy → "Redeploy". Or `git revert` the bad commit and push.

**Q: Where are uploaded chime photos stored?**
A: `/app/uploads/` inside the container. Wiped on every redeploy (free tier). Future: persistent disk or S3.

**Q: What's the `route-9.duckdns.org` thing?**
A: An LLM gateway running on a separate machine (account ID: `7083df782d38cc96b40cdaf3ac65c6bf`). It aggregates a pool of free-tier AI accounts (GitHub Copilot, Codex, Claude Code, Cline, etc.) and exposes them as OpenAI-compatible endpoints. The Render service hits it for all AI work. This is the one external dependency.

---

## 13 · Files you'll most often edit

- `src/gen.ts` — prompts, product registry, AI call wrappers, card composition, QC vision check
- `src/routes.ts` — adding/removing endpoints, adjusting auth/rate limits per route
- `src/server.ts` — static file serving, root index, CORS setup
- `src/security.ts` — auth middleware, rate limit presets, file validation rules
- `render.yaml` — Render deployment config (env vars, build settings)
- `INTEGRATION_PROMPT.md` — keep this in sync when API surface changes

Files you rarely touch: `Dockerfile`, `package.json`, `tsconfig.json`, `fonts/`, `src/core.ts`.

---

## 14 · How to brief ChatGPT for a specific change

Paste this whole document, then say something like:

> "Here's the chime-builder handoff. I want to **{describe the change in plain English}**. Show me:
> 1. Which files to edit and exactly what to change.
> 2. The commit message.
> 3. How to test it locally with bun (if applicable).
> 4. Any env var changes I need to make on Render.
> 5. The git commands to push.
>
> If the change requires updating `INTEGRATION_PROMPT.md`, do that too."

ChatGPT (with this brief) should produce diffs you can apply, test, and push without asking follow-ups.

---

**Live URL:** https://chime-builder.onrender.com
**Repo:** https://github.com/bostonstrong567/chime-builder
**Render dashboard:** https://dashboard.render.com/web/srv-d8d14t7avr4c73f79e30
**9router gateway:** https://route-9.duckdns.org/v1 (account ID `7083df782d38cc96b40cdaf3ac65c6bf`)
