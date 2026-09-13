#!/usr/bin/env node
// scripts/enable-sqlite-vec.mjs
// Creates FTS5 virtual tables, sync triggers, and sqlite-vec vec0 tables.
// Run after: npm run db:push:sqlite

import Database from "better-sqlite3";
import { initializeSqliteDatabase } from "../dist/sqlite-schema.js";
import { createRequire } from "module";

const url = process.env.DATABASE_URL ?? "";
const dbPath = url.replace(/^file:\/\//, "").replace(/^file:/, "");
if (!dbPath) {
  console.error("DATABASE_URL must be set to a file: path");
  process.exit(1);
}

const db = new Database(dbPath);

// Load sqlite-vec extension
const require = createRequire(import.meta.url);
try {
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(db);
  console.log("sqlite-vec loaded");
} catch (e) {
  console.warn("sqlite-vec not available — vector search disabled:", e.message);
}

initializeSqliteDatabase(dbPath);

console.log("FTS5 virtual tables and triggers created");

// sqlite-vec tables (created only if the extension loaded)
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_mc_source
      USING vec0(embedding float[768]);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_mod_source
      USING vec0(embedding float[768]);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_doc_entries
      USING vec0(embedding float[768]);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_primers
      USING vec0(embedding float[768]);
  `);
  console.log("sqlite-vec vec0 tables created (dim=768)");
} catch (e) {
  console.warn("Skipping vec0 tables (sqlite-vec unavailable):", e.message);
}

db.close();
console.log("Done.");
