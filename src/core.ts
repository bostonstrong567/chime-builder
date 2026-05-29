import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Database } from "bun:sqlite";
import { createCanvas, loadImage, registerFont } from "canvas";
import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, extname } from "path";

const ROOT = join(import.meta.dir, "..");
const UPLOADS = join(ROOT, "uploads");
const RESULTS = join(ROOT, "results");
const DATA = join(ROOT, "data");
[UPLOADS, RESULTS, DATA].forEach(d => mkdirSync(d, { recursive: true }));

// Register pretty fonts (real TTFs in fonts/)
const F = join(ROOT, "fonts");
registerFont(join(F, "PinyonScript-Regular.ttf"), { family: "Pinyon" });
registerFont(join(F, "CormorantGaramond-Regular.ttf"), { family: "Cormorant", weight: "normal", style: "normal" });
registerFont(join(F, "CormorantGaramond-Italic.ttf"), { family: "Cormorant", weight: "normal", style: "italic" });
registerFont(join(F, "CormorantGaramond-Bold.ttf"), { family: "Cormorant", weight: "bold", style: "normal" });
registerFont(join(F, "CormorantGaramond-BoldItalic.ttf"), { family: "Cormorant", weight: "bold", style: "italic" });

const db = new Database(join(DATA, "chimes.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS chimes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    image_path TEXT NOT NULL,
    created INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS links (
    slug TEXT PRIMARY KEY,
    label TEXT,
    chime_ids TEXT NOT NULL,
    created INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_slug TEXT,
    picks TEXT,
    title TEXT,
    message TEXT,
    result_path TEXT,
    created INTEGER DEFAULT (strftime('%s','now'))
  );
`);

const app = new Hono();
const slug = () => randomBytes(4).toString("hex");

export { app, db, UPLOADS, RESULTS, DATA, ROOT, slug };
