import { db } from "../db.js";
import { getBytecode } from "../java-tools.js";
import AdmZip from "adm-zip";

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
    const mod = await db().mod.findUnique({ where: { id: dbId } });
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
    await db().mod.update({
        where: { id: dbId },
        data: { mixinTargets: targetArray },
    });

    return { resolved, failed, skipped, targets: targetArray };
}

export async function getMixinTargets(modId: string | number) {
    let mod;
    if (typeof modId === "number" || !isNaN(parseInt(String(modId), 10))) {
        mod = await db().mod.findUnique({ where: { id: Number(modId) } });
    }
    if (!mod) mod = await db().mod.findFirst({ where: { modId: String(modId) } });
    if (!mod) throw new Error(`Mod not found: ${modId}`);

    return {
        modId: mod.modId,
        displayName: mod.displayName,
        mixinConfigs: mod.mixinConfigs,
        mixinTargets: mod.mixinTargets,
    };
}

export async function getMixinConflicts(targetClass: string) {
    // Find all mods whose mixinTargets array contains the target class
    const mods = await db().mod.findMany({
        where: {
            mixinTargets: {
                array_contains: [targetClass],
            },
        },
        select: {
            id: true,
            modId: true,
            displayName: true,
            version: true,
            mcVersion: true,
            loader: true,
            mixinTargets: true,
        },
    });

    return {
        targetClass,
        conflictingMods: mods,
        count: mods.length,
    };
}

export async function getAtEntries(dbId: number) {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    return {
        modId: mod.modId,
        hasAt: mod.hasAt,
        atEntries: mod.atEntries,
    };
}

export async function getAwEntries(dbId: number) {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    return {
        modId: mod.modId,
        hasAw: mod.hasAw,
        awEntries: mod.awEntries,
    };
}
