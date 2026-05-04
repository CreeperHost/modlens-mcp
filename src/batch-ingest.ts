/**
 * Batch ingest all JARs from a directory into modlens.
 * Usage: node dist/batch-ingest.js <directory> [--index]
 *   --index  Also run class indexing after ingest (slower but populates mod_classes table)
 */
import { ingestMod, reindexClasses } from "./tools/ingest.js";
import { disconnect } from "./db.js";
import { readdir } from "fs/promises";
import { join, resolve } from "path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const doIndex = args.includes("--index");

if (!dir) {
    console.error("Usage: node dist/batch-ingest.js <directory> [--index]");
    process.exit(1);
}

const absDir = resolve(dir);
const entries = await readdir(absDir);
const jars = entries.filter((f) => f.endsWith(".jar")).sort();

console.log(`Found ${jars.length} JARs in ${absDir}\n`);

let ok = 0, skip = 0, fail = 0;

for (let i = 0; i < jars.length; i++) {
    const jar = jars[i];
    const jarPath = join(absDir, jar);
    const prefix = `[${String(i + 1).padStart(3, " ")}/${jars.length}]`;
    process.stdout.write(`${prefix} ${jar.padEnd(70)} `);
    try {
        const result = await ingestMod(jarPath, true); // skipSource=true for speed
        if (result.status === "already_ingested") {
            console.log("SKIP");
            skip++;
        } else {
            const mod = result.mod as { modId: string; loader: string; version: string; };
            console.log(`OK   ${mod?.modId ?? "?"} (${mod?.loader ?? "?"} ${mod?.version ?? "?"})`);
            ok++;
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`FAIL ${msg.slice(0, 80)}`);
        fail++;
    }
}

console.log(`\n✓ ingested: ${ok}  skipped: ${skip}  failed: ${fail}`);

if (doIndex) {
    console.log("\nIndexing classes for all mods (this may take a while)...");
    const result = await reindexClasses();
    console.log(`✓ indexed: ${result.indexed}  already had classes: ${result.skipped}  failed: ${result.failed}`);
}

await disconnect();
