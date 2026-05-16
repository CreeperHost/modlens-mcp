import { getBytecode } from "../java-tools.js";
import AdmZip from "adm-zip";
import { findModById, findModByModId, resolveModRef, updateMod, listMods } from "../repositories/mod.js";

function parseMixinTargetsFromJavap(output: string): string[] {
    const targets: string[] = [];

    // Locate the @Mixin annotation block in javap -verbose output
    const annotationIdx = output.indexOf("org.spongepowered.asm.mixin.Mixin(");
    if (annotationIdx === -1) return targets;

    // Grab a reasonable chunk after the annotation name
    const block = output.slice(annotationIdx, annotationIdx + 2000);

    /** Normalise a raw class token to internal slash-separated form, stripping
     *  bytecode descriptor prefix/suffix (e.g. "Lnet/minecraft/X;" → "net/minecraft/X"). */
    function normalise(raw: string): string {
        let s = raw;
        // Strip leading 'L' and trailing ';' (bytecode descriptor)
        if (s.startsWith("L") && s.endsWith(";")) s = s.slice(1, -1);
        else if (s.startsWith("L") && s.includes("/")) s = s.slice(1);
        // Dot-notation → slash-notation
        if (!s.includes("/")) s = s.replace(/\./g, "/");
        return s;
    }

    // value=[class net.minecraft.X] or value=[class net/minecraft/X] or value=[class Lnet/minecraft/X;]
    // Allow slashes and semicolons in addition to word chars and dots
    for (const m of block.matchAll(/class\s+([\w.$\\/;]+)/g)) {
        const cls = normalise(m[1]);
        if (cls.includes("/") && !targets.includes(cls)) targets.push(cls);
    }

    // targets=["net/minecraft/X"] or targets={"net/minecraft/X"}  (slash-separated strings)
    for (const m of block.matchAll(/"([\w/$]+)"/g)) {
        const cls = m[1];
        if (cls.includes("/") && !targets.includes(cls)) targets.push(cls);
    }

    return targets;
}

/** Read mixin class names fresh from the JAR's mixin config JSON files. */
function readMixinClassesFromJar(jarPath: string, mixinConfigs: string[]): string[] {
    const zip = new AdmZip(jarPath);
    const classes: string[] = [];
    for (const cfg of mixinConfigs) {
        const entry = zip.getEntry(cfg);
        if (!entry) continue;
        try {
            const json = JSON.parse(zip.readFile(entry)!.toString("utf8")) as {
                package?: string;
                mixins?: string[];
                client?: string[];
                server?: string[];
            };
            const pkg = json.package ? json.package + "." : "";
            const all = [...(json.mixins ?? []), ...(json.client ?? []), ...(json.server ?? [])];
            classes.push(...all.map((c) => pkg + c));
        } catch { /* malformed — skip */ }
    }
    return classes;
}

export async function resolveMixinTargets(dbId: number): Promise<{
    resolved: number; failed: number; skipped: number; targets: string[];
}> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);

    // Always re-read mixin class names from the JAR — never from DB mixinTargets
    // (DB value may already be resolved or stale)
    const mixinClasses = readMixinClassesFromJar(mod.jarPath, mod.mixinConfigs as string[]);
    if (!mixinClasses.length) return { resolved: 0, failed: 0, skipped: 0, targets: [] };

    const allTargets = new Set<string>();
    let resolved = 0, failed = 0, skipped = 0;

    for (const mixinClass of mixinClasses) {
        const className = mixinClass.replace(/\./g, "/");
        try {
            const bytecode = await getBytecode(mod.jarPath, className);
            const targets = parseMixinTargetsFromJavap(bytecode);
            if (targets.length === 0) { skipped++; continue; }
            targets.forEach((t) => allTargets.add(t));
            resolved++;
        } catch {
            failed++;
        }
    }

    const targetArray = [...allTargets];
    await updateMod(dbId, { mixinTargets: targetArray });

    return { resolved, failed, skipped, targets: targetArray };
}

export async function getMixinTargets(modId: string | number) {
    let mod;
    if (typeof modId === "number" || !isNaN(parseInt(String(modId), 10))) {
        mod = await findModById(Number(modId));
    }
    if (!mod) mod = await findModByModId(String(modId));
    if (!mod) throw new Error(`Mod not found: ${modId}`);

    return {
        modId: mod.modId,
        displayName: mod.displayName,
        mixinConfigs: mod.mixinConfigs,
        mixinTargets: mod.mixinTargets,
    };
}

export async function getMixinConflicts(targetClass: string) {
    const all = await listMods({ hasMixins: true, limit: 9999 });
    const mods = all.filter((m) => (m.mixinTargets as string[])?.includes(targetClass));

    return {
        targetClass,
        conflictingMods: mods,
        count: mods.length,
    };
}

export async function getAtEntries(dbId: number) {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    return {
        modId: mod.modId,
        hasAt: mod.hasAt,
        atEntries: mod.atEntries,
    };
}

export async function getAwEntries(dbId: number) {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    return {
        modId: mod.modId,
        hasAw: mod.hasAw,
        awEntries: mod.awEntries,
    };
}

/**
 * Find all mods whose mixinTargets contain a class in the given package (or subpackage).
 * packagePrefix: slash-separated, e.g. "net/minecraft/world/level" or "net/minecraft/world/entity"
 * mcVersion: optional filter
 */
export async function getMixinsTargetingPackage(packagePrefix: string, mcVersion?: string) {
    const prefix = packagePrefix.replace(/\./g, "/").replace(/\/$/, "");

    const mods = await listMods({
        hasMixins: true,
        mcVersion,
    });

    const results: Array<{ modId: string; displayName: string; version: string; mcVersion: string; loader: string; matchingTargets: string[] }> = [];

    for (const mod of mods) {
        const targets = mod.mixinTargets as string[];
        const matching = targets.filter(t => t === prefix || t.startsWith(prefix + "/"));
        if (matching.length > 0) {
            results.push({
                modId: mod.modId,
                displayName: mod.displayName,
                version: mod.version,
                mcVersion: mod.mcVersion,
                loader: mod.loader,
                matchingTargets: matching,
            });
        }
    }

    return {
        packagePrefix: prefix,
        mcVersion: mcVersion ?? "(all)",
        totalMods: results.length,
        totalTargets: results.reduce((n, r) => n + r.matchingTargets.length, 0),
        mods: results,
    };
}

// ── AT/AW conflict detection ───────────────────────────────────────────────────

/**
 * Find Access Transformer / Access Widener entries where two or more mods
 * target the same class member. Returns entries grouped by target signature so
 * you can see at a glance who's AT-ing what.
 *
 * mcVersion: optional filter
 * loader: optional filter ("neoforge" | "forge" | "fabric" | "quilt")
 */
export async function findAtAwConflicts(mcVersion?: string, loader?: string): Promise<object> {
    const mods = await listMods({
        ...(mcVersion ? { mcVersion } : {}),
        ...(loader ? { loader } : {}),
    });

    // Map: canonical target signature → [{mod, access}]
    const atMap = new Map<string, Array<{ mod: string; display: string; version: string; loader: string; access: string }>>();

    for (const mod of mods) {
        const addEntry = (sig: string, access: string) => {
            if (!atMap.has(sig)) atMap.set(sig, []);
            atMap.get(sig)!.push({ mod: mod.modId, display: mod.displayName, version: mod.version, loader: mod.loader, access });
        };

        // AT entries: "accessible method net/minecraft/Foo bar (I)V"
        for (const entry of (mod.atEntries as string[]) ?? []) {
            const clean = (typeof entry === "string" ? entry : JSON.stringify(entry)).trim();
            // Canonical signature = everything after the access modifier word
            const parts = clean.split(/\s+/);
            if (parts.length >= 2) {
                const sig = parts.slice(1).join(" ");
                addEntry(`AT:${sig}`, parts[0]);
            }
        }

        // AW entries: "accessible class net/minecraft/Foo" or "accessible method net/minecraft/Foo bar (I)V"
        for (const entry of (mod.awEntries as string[]) ?? []) {
            const clean = (typeof entry === "string" ? entry : JSON.stringify(entry)).trim();
            const parts = clean.split(/\s+/);
            if (parts.length >= 2) {
                const sig = parts.slice(1).join(" ");
                addEntry(`AW:${sig}`, parts[0]);
            }
        }
    }

    const conflicts = [...atMap.entries()]
        .filter(([, users]) => users.length >= 2)
        .map(([sig, users]) => {
            const accessValues = new Set(users.map(u => u.access));
            return { target: sig, modCount: users.length, accessConflict: accessValues.size > 1, users };
        })
        .sort((a, b) => b.modCount - a.modCount);

    const accessConflicts = conflicts.filter(c => c.accessConflict);
    const sharedTargets   = conflicts.filter(c => !c.accessConflict);

    return {
        mcVersion: mcVersion ?? "(all)",
        loader: loader ?? "(all)",
        totalModsWithAt: mods.filter(m => m.hasAt).length,
        totalModsWithAw: mods.filter(m => m.hasAw).length,
        summary: {
            sharedTargets: sharedTargets.length,
            accessConflicts: accessConflicts.length,
        },
        note: accessConflicts.length > 0
            ? "accessConflict=true means mods target the same member but request different access levels — last-loaded wins."
            : "No access-level conflicts found; all shared targets request the same access.",
        accessConflicts,
        sharedTargets,
    };
}
