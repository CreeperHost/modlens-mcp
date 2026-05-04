import { db } from "../db.js";

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
