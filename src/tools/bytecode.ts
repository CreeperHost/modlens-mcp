import { db } from "../db.js";
import { indexJar, inspectClass, getBytecode } from "../java-tools.js";
import { searchClasses } from "../search.js";
import { listClasses } from "../jar.js";
import { accessStr, descriptorToSimpleType, Opcodes } from "../access-flags.js";

async function getModJar(dbId: number): Promise<string> {
    const mod = await db().mod.findUnique({ where: { id: dbId } });
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    return mod.jarPath;
}

export async function searchModClass(dbId: number, query: string): Promise<string[]> {
    const jarPath = await getModJar(dbId);
    const classes = listClasses(jarPath)
        .map((c) => c.replace(/\.class$/, ""))
        .filter((c) => !c.includes("$") || query.includes("$")); // hide inner classes unless explicitly searched
    return searchClasses(classes, query);
}

export async function getModClassMembers(dbId: number, className: string) {
    const jarPath = await getModJar(dbId);
    const internal = className.replace(/\./g, "/");
    const info = await inspectClass(jarPath, internal);

    const methods = info.methods.map((m) => {
        const access = accessStr(m.access);
        const isStatic = !!(m.access & Opcodes.ACC_STATIC);
        const isFinal = !!(m.access & Opcodes.ACC_FINAL);
        const isAbstract = !!(m.access & Opcodes.ACC_ABSTRACT);
        return {
            name: m.name,
            descriptor: m.descriptor,
            access,
            isStatic,
            isFinal,
            isAbstract,
            mixinTarget: `${m.name}${m.descriptor}`,
            atString: `accessible method ${info.name} ${m.name} ${m.descriptor}`,
        };
    });

    const fields = info.fields.map((f) => {
        const access = accessStr(f.access);
        const isStatic = !!(f.access & Opcodes.ACC_STATIC);
        const isFinal = !!(f.access & Opcodes.ACC_FINAL);
        const javaType = descriptorToSimpleType(f.descriptor);
        const atPrefix = isFinal ? "mutable" : "accessible";
        return {
            name: f.name,
            descriptor: f.descriptor,
            access,
            isStatic,
            isFinal,
            shadowAnnotation: `@Shadow ${access}${isStatic ? " static" : ""} ${javaType} ${f.name};`,
            atString: `${atPrefix} field ${info.name} ${f.name} ${f.descriptor}`,
        };
    });

    return {
        className: info.name,
        superClass: info.superName,
        interfaces: info.interfaces,
        atStrings: {
            accessible: `accessible class ${info.name}`,
            extendable: `extendable class ${info.name}`,
        },
        methods,
        fields,
    };
}

export async function getModClassBytecode(dbId: number, className: string): Promise<string> {
    const jarPath = await getModJar(dbId);
    return getBytecode(jarPath, className.replace(/\./g, "/"));
}

export async function findModReferences(dbId: number, target: string): Promise<string[]> {
    const jarPath = await getModJar(dbId);
    const index = await indexJar(jarPath);
    return index.references[target] ?? [];
}

export async function getModInheritance(dbId: number, className: string) {
    const jarPath = await getModJar(dbId);
    const internal = className.replace(/\./g, "/");
    const index = await indexJar(jarPath);
    const classes = Object.values(index.classes);
    const target = classes.find((c) => c.name === internal);
    if (!target) throw new Error(`Class not found: ${internal}`);

    const subclasses = classes
        .filter((c) => c.superName === internal)
        .map((c) => c.name);
    const implementors = classes
        .filter((c) => c.interfaces.includes(internal))
        .map((c) => c.name);

    return {
        className: internal,
        superClass: target.superName,
        interfaces: target.interfaces,
        subclasses,
        implementors,
    };
}

export async function diffModVersions(dbIdA: number, dbIdB: number) {
    const [a, b] = await Promise.all([
        db().mod.findUnique({ where: { id: dbIdA } }),
        db().mod.findUnique({ where: { id: dbIdB } }),
    ]);
    if (!a) throw new Error(`Mod #${dbIdA} not found`);
    if (!b) throw new Error(`Mod #${dbIdB} not found`);

    const classesA = new Set(
        listClasses(a.jarPath).map((c) => c.replace(/\.class$/, ""))
    );
    const classesB = new Set(
        listClasses(b.jarPath).map((c) => c.replace(/\.class$/, ""))
    );

    const added = [...classesB].filter((c) => !classesA.has(c));
    const removed = [...classesA].filter((c) => !classesB.has(c));
    const common = [...classesA].filter((c) => classesB.has(c));

    return {
        modA: { id: dbIdA, modId: a.modId, version: a.version },
        modB: { id: dbIdB, modId: b.modId, version: b.version },
        summary: { added: added.length, removed: removed.length, common: common.length },
        added,
        removed,
    };
}

/**
 * Find all mod classes in the DB that extend or implement a given class or interface.
 * Uses the modClass table (superClass + interfaces columns) — requires reindex_classes to have run.
 *
 * target: internal slash-separated name, e.g. "net/minecraft/world/entity/Entity"
 *         or dot-separated, e.g. "net.minecraft.world.entity.Entity"
 * modId: optional filter to a specific mod
 */
export async function findImplementors(
    target: string,
    modId?: string | number,
    limit = 100,
    transitive = false,
): Promise<object> {
    const internal = target.replace(/\./g, "/");

    let modDbId: number | undefined;
    if (modId !== undefined) {
        if (typeof modId === "number") {
            modDbId = modId;
        } else {
            const mod = await db().mod.findFirst({ where: { modId: { contains: modId } }, select: { id: true } });
            if (!mod) return { error: `Mod not found: ${modId}` };
            modDbId = mod.id;
        }
    }

    const where = (superClass?: string, iface?: string) => ({
        ...(superClass !== undefined ? { superClass } : {}),
        ...(iface !== undefined ? { interfaces: { has: iface } } : {}),
        ...(modDbId ? { modId: modDbId } : {}),
    });

    const fetchDirect = async (t: string) => {
        const [bySuper, byIface] = await Promise.all([
            db().modClass.findMany({ where: where(t, undefined), include: { mod: { select: { modId: true, displayName: true, version: true } } }, take: limit }),
            db().modClass.findMany({ where: where(undefined, t), include: { mod: { select: { modId: true, displayName: true, version: true } } }, take: limit }),
        ]);
        return [...bySuper, ...byIface];
    };

    const format = (cls: Awaited<ReturnType<typeof fetchDirect>>[0]) => ({
        className: cls.className,
        mod: cls.mod.modId,
        modDisplay: cls.mod.displayName,
        version: cls.mod.version,
    });

    if (!transitive) {
        const direct = await fetchDirect(internal);
        const bySuper = direct.filter(c => c.superClass === internal);
        const byIface = direct.filter(c => c.interfaces.includes(internal));
        return {
            target: internal,
            transitive: false,
            directSubclasses: { count: bySuper.length, classes: bySuper.map(format) },
            implementors:     { count: byIface.length, classes: byIface.map(format) },
        };
    }

    // BFS transitive walk
    const visited = new Set<string>([internal]);
    const queue = [internal];
    const allFound: Awaited<ReturnType<typeof fetchDirect>> = [];

    while (queue.length > 0 && allFound.length < limit) {
        const current = queue.shift()!;
        const found = await fetchDirect(current);
        for (const cls of found) {
            if (!visited.has(cls.className)) {
                visited.add(cls.className);
                allFound.push(cls);
                queue.push(cls.className);
            }
        }
    }

    return {
        target: internal,
        transitive: true,
        count: allFound.length,
        note: allFound.length >= limit ? `Capped at ${limit}. Use filter or increase limit.` : undefined,
        classes: allFound.map(format),
    };
}

// ── Annotation search ──────────────────────────────────────────────────────────

/**
 * Find all classes across the DB annotated with a given annotation.
 * Annotations appear in the JAR index references map the same way class references do —
 * any class that uses @MyAnnotation will have the annotation class in its reference list.
 * This works without decompilation.
 *
 * annotation: internal slash-separated name, e.g. "net/neoforged/bus/api/SubscribeEvent"
 *             or dot-separated: "net.neoforged.bus.api.SubscribeEvent"
 * modId: optional — limit to one mod
 * limit: max results per mod (default 200 total)
 */
export async function findAnnotatedClasses(
    annotation: string,
    modId?: string | number,
    limit = 200,
): Promise<object> {
    const internal = annotation.replace(/\./g, "/");

    let mods;
    if (modId !== undefined) {
        const mod = typeof modId === "number"
            ? await db().mod.findUnique({ where: { id: modId }, select: { id: true, modId: true, displayName: true, version: true, jarPath: true } })
            : await db().mod.findFirst({ where: { modId: { contains: String(modId) } }, select: { id: true, modId: true, displayName: true, version: true, jarPath: true } });
        if (!mod) return { error: `Mod not found: ${modId}` };
        mods = [mod];
    } else {
        mods = await db().mod.findMany({ select: { id: true, modId: true, displayName: true, version: true, jarPath: true } });
    }

    const results: Array<{ mod: string; modDisplay: string; version: string; classes: string[] }> = [];
    let total = 0;

    for (const mod of mods) {
        if (total >= limit) break;
        try {
            const index = await indexJar(mod.jarPath);
            const refs = index.references[internal] ?? [];
            if (refs.length > 0) {
                results.push({ mod: mod.modId, modDisplay: mod.displayName, version: mod.version, classes: refs });
                total += refs.length;
            }
        } catch {
            // skip mods whose JARs can't be indexed
        }
    }

    return {
        annotation: internal,
        totalMods: results.length,
        totalClasses: total,
        note: total >= limit ? `Capped at ${limit} total. Narrow with modId.` : undefined,
        results,
    };
}

// ── Registration scanner ───────────────────────────────────────────────────────

/** Known class paths for each registration category, covering NeoForge, Forge, Fabric. */
const REGISTRATION_TARGETS = {
    deferredRegister: [
        "net/neoforged/neoforge/registries/DeferredRegister",
        "net/minecraftforge/registries/DeferredRegister",
        "net/fabricmc/fabric/api/object/builder/v1/registry/FabricRegistryBuilder",
    ],
    eventHandlers: [
        "net/neoforged/bus/api/SubscribeEvent",
        "net/neoforged/fml/common/EventBusSubscriber",
        "net/minecraftforge/eventbus/api/SubscribeEvent",
        "net/minecraftforge/fml/common/Mod$EventBusSubscriber",
    ],
    commands: [
        "net/minecraft/commands/Commands",
        "net/minecraft/commands/CommandSourceStack",
        "com/mojang/brigadier/CommandDispatcher",
    ],
    keybindings: [
        "net/minecraft/client/KeyMapping",
        "com/mojang/blaze3d/platform/InputConstants",
    ],
    network: [
        "net/neoforged/neoforge/network/registration/PayloadRegistrar",
        "net/neoforged/neoforge/network/event/RegisterPayloadHandlersEvent",
        "net/minecraftforge/network/simple/SimpleChannel",
        "net/fabricmc/fabric/api/networking/v1/PayloadTypeRegistry",
    ],
    config: [
        "net/neoforged/neoforge/common/ModConfigSpec",
        "net/minecraftforge/common/ForgeConfigSpec",
        "me/shedaniel/autoconfig/AutoConfig",
    ],
    capabilities: [
        "net/neoforged/neoforge/capabilities/RegisterCapabilitiesEvent",
        "net/minecraftforge/event/AttachCapabilitiesEvent",
        "net/fabricmc/fabric/api/lookup/v1/block/BlockApiLookup",
    ],
    lootModifiers: [
        "net/neoforged/neoforge/common/loot/IGlobalLootModifier",
        "net/minecraftforge/common/loot/IGlobalLootModifier",
        "net/fabricmc/fabric/api/loot/v2/LootTableEvents",
    ],
    datapackRegistries: [
        "net/neoforged/neoforge/registries/DataPackRegistriesHooks",
        "net/neoforged/neoforge/registries/NeoForgeRegistries",
        "net/neoforged/fml/common/registry/GameRegistry",
    ],
};

/**
 * Scan a mod JAR's class index for registration patterns: DeferredRegister usage,
 * event handlers, command registrars, keybindings, network payloads, config builders,
 * capabilities, loot modifiers, and datapack registries.
 * Uses the JAR index (no decompilation required). Results name the classes involved;
 * use class_members or get_source to drill down into any of them.
 */
export async function scanModRegistrations(dbId: number): Promise<object> {
    const jarPath = await getModJar(dbId);
    const index = await indexJar(jarPath);

    const findClasses = (targets: string[]): string[] => {
        const found = new Set<string>();
        for (const t of targets) {
            for (const c of (index.references[t] ?? [])) {
                found.add(c);
            }
        }
        // Filter out inner classes of the same name (reduce noise; keep if no parent)
        return [...found].sort();
    };

    const results: Record<string, { count: number; classes: string[] }> = {};
    for (const [category, targets] of Object.entries(REGISTRATION_TARGETS)) {
        const classes = findClasses(targets);
        if (classes.length > 0) {
            results[category] = { count: classes.length, classes };
        }
    }

    const totalClasses = Object.values(results).reduce((n, r) => n + r.count, 0);
    return {
        mod: dbId,
        totalMatchingClasses: totalClasses,
        note: "Classes listed reference the registration APIs. Use mod_bytecode class_members or mod source to inspect them further.",
        registrations: results,
    };
}

// ── Cross-mod reference search ─────────────────────────────────────────────────

/**
 * Find which mods in the DB reference a given class, method, or field.
 * Unlike find_refs (single JAR), this scans every ingested mod's index.
 *
 * target: slash-separated class/method/field, e.g. "net/minecraft/world/entity/LivingEntity"
 *         or "mymod/SomeClass:myMethod:(I)V"
 * mcVersion: optional filter
 * loader: optional filter
 */
export async function crossModRefs(
    target: string,
    mcVersion?: string,
    loader?: string,
    limit = 500,
): Promise<object> {
    const internal = target.replace(/\./g, "/");

    const mods = await db().mod.findMany({
        where: {
            ...(mcVersion ? { mcVersion } : {}),
            ...(loader ? { loader } : {}),
        },
        select: { id: true, modId: true, displayName: true, version: true, mcVersion: true, loader: true, jarPath: true },
    });

    const results: Array<{ mod: string; modDisplay: string; version: string; loader: string; referencingClasses: string[] }> = [];
    let total = 0;

    for (const mod of mods) {
        if (total >= limit) break;
        try {
            const index = await indexJar(mod.jarPath);
            const refs = index.references[internal] ?? [];
            if (refs.length > 0) {
                results.push({ mod: mod.modId, modDisplay: mod.displayName, version: mod.version, loader: mod.loader, referencingClasses: refs });
                total += refs.length;
            }
        } catch { /* skip unindexable JARs */ }
    }

    return {
        target: internal,
        mcVersion: mcVersion ?? "(all)",
        loader: loader ?? "(all)",
        totalMods: results.length,
        totalReferences: total,
        note: total >= limit ? `Capped at ${limit} total references. Use mcVersion/loader to narrow.` : undefined,
        results,
    };
}

// ── Event listener search ──────────────────────────────────────────────────────

// Known @SubscribeEvent annotation paths across loaders
const SUBSCRIBE_EVENT_ANNOTATIONS = [
    "net/neoforged/bus/api/SubscribeEvent",
    "net/minecraftforge/eventbus/api/SubscribeEvent",
];

/**
 * Find all @SubscribeEvent (or equivalent) methods across the DB that listen
 * to a specific event class. Scans JAR indexes — no decompilation needed.
 *
 * event: internal class name of the event, e.g. "net/neoforged/neoforge/event/entity/living/LivingDeathEvent"
 *        or partial name match, e.g. "LivingDeathEvent"
 * modId: optional — limit to one mod
 */
export async function findEventListeners(
    event: string,
    modId?: string | number,
    limit = 300,
): Promise<object> {
    const eventInternal = event.replace(/\./g, "/");

    let mods;
    if (modId !== undefined) {
        const mod = typeof modId === "number"
            ? await db().mod.findUnique({ where: { id: modId }, select: { id: true, modId: true, displayName: true, version: true, jarPath: true } })
            : await db().mod.findFirst({ where: { modId: { contains: String(modId) } }, select: { id: true, modId: true, displayName: true, version: true, jarPath: true } });
        if (!mod) return { error: `Mod not found: ${modId}` };
        mods = [mod];
    } else {
        mods = await db().mod.findMany({ select: { id: true, modId: true, displayName: true, version: true, jarPath: true } });
    }

    const results: Array<{
        mod: string; modDisplay: string; version: string;
        listeners: Array<{ className: string; methods: string[] }>;
    }> = [];
    let total = 0;

    for (const mod of mods) {
        if (total >= limit) break;
        try {
            const index = await indexJar(mod.jarPath);

            // Find classes that reference the event AND any @SubscribeEvent annotation
            const eventRefs = new Set(index.references[eventInternal] ?? []);
            // Also check partial name match across the reference keys
            if (eventRefs.size === 0) {
                for (const [key, classes] of Object.entries(index.references)) {
                    if (key.includes(eventInternal) || key.endsWith("/" + eventInternal)) {
                        for (const c of classes) eventRefs.add(c);
                    }
                }
            }
            if (eventRefs.size === 0) continue;

            const subscriberClasses = new Set<string>();
            for (const ann of SUBSCRIBE_EVENT_ANNOTATIONS) {
                for (const c of (index.references[ann] ?? [])) subscriberClasses.add(c);
            }

            // Intersection: classes that reference the event AND have @SubscribeEvent methods
            const candidates = [...eventRefs].filter(c => subscriberClasses.has(c));
            if (candidates.length === 0) continue;

            // For each candidate, find which methods take this event via inspectClass
            const listeners: Array<{ className: string; methods: string[] }> = [];
            for (const cls of candidates) {
                try {
                    const info = await inspectClass(mod.jarPath, cls);
                    // Methods whose descriptor contains the event class
                    const matching = info.methods
                        .filter(m => m.descriptor.includes(eventInternal.replace(/\//g, "/")) ||
                                     m.descriptor.includes(eventInternal.split("/").pop()!))
                        .map(m => `${m.name}${m.descriptor}`);
                    if (matching.length > 0) {
                        listeners.push({ className: cls, methods: matching });
                    } else {
                        // Can't narrow to method — include class anyway
                        listeners.push({ className: cls, methods: [] });
                    }
                } catch { listeners.push({ className: cls, methods: [] }); }
            }

            results.push({ mod: mod.modId, modDisplay: mod.displayName, version: mod.version, listeners });
            total += candidates.length;
        } catch { /* skip */ }
    }

    return {
        event: eventInternal,
        totalMods: results.length,
        totalListeners: total,
        note: total >= limit ? `Capped at ${limit}. Use modId to narrow.` : undefined,
        results,
    };
}
