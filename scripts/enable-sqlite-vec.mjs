#!/usr/bin/env node
// scripts/enable-sqlite-vec.mjs
// Creates FTS5 virtual tables, sync triggers, and sqlite-vec vec0 tables.
// Run after: npm run db:push:sqlite

import Database from "better-sqlite3";
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

db.exec(`
-- FTS5 virtual table for Minecraft source files
CREATE VIRTUAL TABLE IF NOT EXISTS fts_mc_source (
  content,
  class_name,
  mc_version_id UNINDEXED
) USING fts5(content, class_name, mc_version_id UNINDEXED);

-- Sync triggers for mc_source_files
CREATE TRIGGER IF NOT EXISTS mc_source_fts_insert
AFTER INSERT ON mc_source_files BEGIN
  INSERT INTO fts_mc_source(rowid, content, class_name, mc_version_id)
  VALUES (new.id, new.content, new.class_name, new.mc_version_id);
END;

CREATE TRIGGER IF NOT EXISTS mc_source_fts_delete
AFTER DELETE ON mc_source_files BEGIN
  DELETE FROM fts_mc_source WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS mc_source_fts_update
AFTER UPDATE ON mc_source_files BEGIN
  DELETE FROM fts_mc_source WHERE rowid = old.id;
  INSERT INTO fts_mc_source(rowid, content, class_name, mc_version_id)
  VALUES (new.id, new.content, new.class_name, new.mc_version_id);
END;

-- FTS5 virtual table for doc entries
CREATE VIRTUAL TABLE IF NOT EXISTS fts_doc_entries (
  title,
  summary,
  url UNINDEXED,
  category UNINDEXED
) USING fts5(title, summary, url UNINDEXED, category UNINDEXED);

-- Sync triggers for doc_entries
CREATE TRIGGER IF NOT EXISTS doc_entries_fts_insert
AFTER INSERT ON doc_entries BEGIN
  INSERT INTO fts_doc_entries(rowid, title, summary, url, category)
  VALUES (new.id, new.title, new.summary, new.url, new.category);
END;

CREATE TRIGGER IF NOT EXISTS doc_entries_fts_delete
AFTER DELETE ON doc_entries BEGIN
  DELETE FROM fts_doc_entries WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS doc_entries_fts_update
AFTER UPDATE ON doc_entries BEGIN
  DELETE FROM fts_doc_entries WHERE rowid = old.id;
  INSERT INTO fts_doc_entries(rowid, title, summary, url, category)
  VALUES (new.id, new.title, new.summary, new.url, new.category);
END;

-- FTS5 virtual table for primers
CREATE VIRTUAL TABLE IF NOT EXISTS fts_primers (
  title,
  summary,
  content
) USING fts5(title, summary, content);

-- Sync triggers for primers
CREATE TRIGGER IF NOT EXISTS primers_fts_insert
AFTER INSERT ON primers BEGIN
  INSERT INTO fts_primers(rowid, title, summary, content)
  VALUES (new.id, new.title, new.summary, new.content);
END;

CREATE TRIGGER IF NOT EXISTS primers_fts_delete
AFTER DELETE ON primers BEGIN
  DELETE FROM fts_primers WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS primers_fts_update
AFTER UPDATE ON primers BEGIN
  DELETE FROM fts_primers WHERE rowid = old.id;
  INSERT INTO fts_primers(rowid, title, summary, content)
  VALUES (new.id, new.title, new.summary, new.content);
END;

-- FTS5 virtual table for mod source files (fabric / neoforge / forge / quilt)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_mod_source (
  content,
  class_name,
  mod_id UNINDEXED
) USING fts5(content, class_name, mod_id UNINDEXED);

-- Sync triggers for mod_source_files
CREATE TRIGGER IF NOT EXISTS mod_source_fts_insert
AFTER INSERT ON mod_source_files BEGIN
  INSERT INTO fts_mod_source(rowid, content, class_name, mod_id)
  VALUES (new.id, new.content, new.class_name, new.mod_id);
END;

CREATE TRIGGER IF NOT EXISTS mod_source_fts_delete
AFTER DELETE ON mod_source_files BEGIN
  DELETE FROM fts_mod_source WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS mod_source_fts_update
AFTER UPDATE ON mod_source_files BEGIN
  DELETE FROM fts_mod_source WHERE rowid = old.id;
  INSERT INTO fts_mod_source(rowid, content, class_name, mod_id)
  VALUES (new.id, new.content, new.class_name, new.mod_id);
END;
`);

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
