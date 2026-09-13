import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function sqliteDatabasePath(url: string): string {
    return url.startsWith("file://") ? fileURLToPath(url)
        : decodeURIComponent(url.replace(/^file:/, ""));
}

const indexes = [
    { table: "fts_mod_source", source: "mod_source_files", trigger: "mod_source_fts", columns: ["content", "class_name", "mod_id"], unindexed: ["mod_id"] },
    { table: "fts_mc_source", source: "mc_source_files", trigger: "mc_source_fts", columns: ["content", "class_name", "mc_version_id"], unindexed: ["mc_version_id"] },
    { table: "fts_doc_entries", source: "doc_entries", trigger: "doc_entries_fts", columns: ["title", "summary", "url", "category"], unindexed: ["url", "category"] },
    { table: "fts_primers", source: "primers", trigger: "primers_fts", columns: ["title", "summary", "content"], unindexed: [] },
];

/** Add missing tables and FTS indexes without replacing existing user data. */
export function initializeSqliteDatabase(
    path: string,
    templatePath = fileURLToPath(new URL("../prisma/backends/template.db", import.meta.url)),
): void {
    if (!path || path === ":memory:") return;
    const db = new Database(path);
    try {
        db.pragma("busy_timeout = 10000");
        const schema: Array<{ name: string; tbl_name: string; type: string; sql: string }> = [];
        if (resolve(path) !== resolve(templatePath) && existsSync(templatePath)) {
            const template = new Database(templatePath, { readonly: true });
            try {
                schema.push(...template.prepare(`SELECT name, tbl_name, type, sql FROM sqlite_master
                    WHERE type IN ('table', 'index') AND sql IS NOT NULL
                    AND name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'fts_%'
                    ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`).all() as typeof schema);
            } finally { template.close(); }
        }
        const has = (type: string, name: string) => !!db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?",
        ).get(type, name);
        db.transaction(() => {
            const addedTables = new Set<string>();
            for (const entry of schema) {
                if (entry.type === "table" && !has("table", entry.name)) {
                    db.exec(entry.sql);
                    addedTables.add(entry.name);
                } else if (entry.type === "index" && addedTables.has(entry.tbl_name) && !has("index", entry.name)) {
                    db.exec(entry.sql);
                }
            }
            for (const index of indexes) {
                if (!has("table", index.source)) continue;
                const backfill = !has("table", index.table)
                    || ["insert", "update", "delete"].some(op => !has("trigger", `${index.trigger}_${op}`));
                const columns = index.columns.join(", ");
                const values = index.columns.map(column => `new.${column}`).join(", ");
                db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${index.table} USING fts5(${index.columns
                    .map(column => column + (index.unindexed.includes(column) ? " UNINDEXED" : "")).join(", ")});
                    CREATE TRIGGER IF NOT EXISTS ${index.trigger}_insert AFTER INSERT ON ${index.source} BEGIN
                        INSERT INTO ${index.table}(rowid, ${columns}) VALUES (new.id, ${values});
                    END;
                    CREATE TRIGGER IF NOT EXISTS ${index.trigger}_delete AFTER DELETE ON ${index.source} BEGIN
                        DELETE FROM ${index.table} WHERE rowid = old.id;
                    END;
                    CREATE TRIGGER IF NOT EXISTS ${index.trigger}_update AFTER UPDATE ON ${index.source} BEGIN
                        DELETE FROM ${index.table} WHERE rowid = old.id;
                        INSERT INTO ${index.table}(rowid, ${columns}) VALUES (new.id, ${values});
                    END;`);
                if (backfill) db.exec(`DELETE FROM ${index.table};
                    INSERT INTO ${index.table}(rowid, ${columns}) SELECT id, ${columns} FROM ${index.source};`);
            }
        }).immediate();
    } finally { db.close(); }
}
