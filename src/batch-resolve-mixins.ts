/**
 * Resolve actual MC mixin targets for all mods that have mixin configs.
 * Reads @Mixin annotations from bytecode and updates the mixinTargets column.
 * Usage: node dist/batch-resolve-mixins.js
 */
import { getDb, disconnect } from "./db.js";
import { resolveMixinTargets } from "./tools/mixins.js";

const mods = await (await getDb()).mod.findMany({
    where: { hasMixins: true },
    select: { id: true, modId: true, mixinConfigs: true },
    orderBy: { id: "asc" },
});

console.log(`Resolving mixin targets for ${mods.length} mods...\n`);

let ok = 0, none = 0, fail = 0;

for (const mod of mods) {
    process.stdout.write(`[${String(mod.id).padStart(3, " ")}] ${mod.modId.padEnd(50)} `);
    try {
        const result = await resolveMixinTargets(mod.id);
        if (result.targets.length === 0) {
            console.log(`NONE  (${result.skipped} skipped, ${result.failed} failed)`);
            none++;
        } else {
            console.log(`OK    ${result.targets.length} targets (${result.resolved} resolved, ${result.failed} failed)`);
            ok++;
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`FAIL  ${msg.slice(0, 60)}`);
        fail++;
    }
}

console.log(`\n✓ resolved: ${ok}  no targets found: ${none}  failed: ${fail}`);
await disconnect();
