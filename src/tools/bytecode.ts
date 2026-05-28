import { indexJar, inspectClass, getBytecode } from "../java-tools.js";
import { searchClasses } from "../search.js";
import { listClasses } from "../jar.js";
import { accessStr, formatClassMembers, Opcodes } from "../access-flags.js";
import {
    findModById, resolveModRefSlim, listModsSlim, findModClassesForCrossModSearch,
} from "../repositories/mod.js";
import { validateDbId, validateClassName } from "../validate.js";
import { assertJarPath } from "../security.js";

async function getModJar(dbId: number): Promise<string> {
    const mod = await findModById(dbId);
    if (!mod) throw new Error(`Mod #${dbId} not found`);
    assertJarPath(mod.jarPath);
    return mod.jarPath;
}

export async function searchModClass(dbId: number, query: string): Promise<string[]> {
    validateDbId(dbId);
    const jarPath = await getModJar(dbId);
    const classes = listClasses(jarPath)
        .map((c) => c.replace(/\.class$/, ""))
        .filter((c) => !c.includes("$") || query.includes("$")); // hide inner classes unless explicitly searched
    return searchClasses(classes, query);
}

export async function getModClassMembers(dbId: number, className: string) {
    validateDbId(dbId);
    validateClassName(className);
    const jarPath = await getModJar(dbId);
    const internal = className.replace(/\./g, "/");
    const info = await inspectClass(jarPath, internal);
    return formatClassMembers(info);
}

export async function getModClassBytecode(dbId: number, className: string): Promise<string> {
    validateDbId(dbId);
    validateClassName(className);
    const jarPath = await getModJar(dbId);
    return getBytecode(jarPath, className.replace(/\./g, "/"));
}

export async function findModReferences(dbId: number, target: string): Promise<string[]> {
    validateDbId(dbId);
    const jarPath = await getModJar(dbId);
    const index = await indexJar(jarPath);
    return index.references[target] ?? [];
}

export async function getModInheritance(dbId: number, className: string) {
    validateDbId(dbId);
    validateClassName(className);
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
    validateDbId(dbIdA);
    validateDbId(dbIdB);
    const [jarA, jarB] = await Promise.all([
        getModJar(dbIdA),
        getModJar(dbIdB),
    ]);
    const [a, b] = await Promise.all([
        findModById(dbIdA),
        findModById(dbIdB),
    ]);
    if (!a) throw new Error(`Mod #${dbIdA} not found`);
    if (!b) throw new Error(`Mod #${dbIdB} not found`);

    const classesA = new Set(
        listClasses(jarA).map((c) => c.replace(/\.class$/, ""))
    );
    const classesB = new Set(
        listClasses(jarB).map((c) => c.replace(/\.class$/, ""))
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
            const mod = await resolveModRefSlim(modId);
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
        const [bySuper, byIface] = await findModClassesForCrossModSearch(where(t, undefined), where(undefined, t), limit);
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
        const mod = await resolveModRefSlim(modId);
        if (!mod) return { error: `Mod not found: ${modId}` };
        mods = [mod];
    } else {
        mods = await listModsSlim();
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

    const mods = await listModsSlim({ mcVersion, loader });

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
        const mod = await resolveModRefSlim(modId);
        if (!mod) return { error: `Mod not found: ${modId}` };
        mods = [mod];
    } else {
        mods = await listModsSlim();
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

// ── Optional mod integration detection ────────────────────────────────────────

// Patterns that indicate conditional/optional mod integrations in bytecode
const OPTIONAL_INTEGRATION_PATTERNS: Record<string, string[]> = {
    "modloaded_check": [
        "net/neoforged/fml/ModList",
        "net/minecraftforge/fml/ModList",
        "net/fabricmc/loader/api/FabricLoader",
    ],
    "optional_interface": [
        "net/minecraftforge/fml/common/Optional$Interface",
        "net/minecraftforge/fml/common/Optional$Method",
    ],
    "services_integration": [
        "java/util/ServiceLoader",
    ],
    "capability_integration": [
        "net/neoforged/neoforge/capabilities/Capabilities",
        "net/minecraftforge/common/capabilities/ForgeCapabilities",
    ],
    "curios_integration": [
        "top/theillusivec4/curios/api/CuriosApi",
        "top/theillusivec4/curios/api/SlotContext",
    ],
    "jei_integration": [
        "mezz/jei/api/IModPlugin",
        "mezz/jei/api/registration/IRecipeRegistration",
    ],
    "jade_integration": [
        "snownee/jade/api/IWailaPlugin",
        "snownee/jade/api/BlockAccessor",
    ],
    "rei_integration": [
        "me/shedaniel/rei/api/common/plugins/REIPlugin",
    ],
    "jmapfrontiers_integration": [
        "journeymap/client/api/IClientPlugin",
    ],
    "waila_integration": [
        "mcp/mobius/waila/api/IWailaPlugin",
    ],
    "top_integration": [
        "mcjty/theoneprobe/api/IProbeProvider",
    ],
    "patchouli_integration": [
        "vazkii/patchouli/api/PatchouliAPI",
    ],
};

/**
 * Scan a mod JAR for optional/conditional mod integration patterns.
 * Detects: ModList.isLoaded() calls, @OptionalInterface, capability hooks,
 * and hard-coded integration checks for popular mods (JEI, Jade, REI, etc.)
 * Works from JAR index — no decompilation needed.
 */
export async function findOptionalIntegrations(
    dbId: number,
): Promise<object> {
    const jarPath = await getModJar(dbId);
    const index   = await indexJar(jarPath);

    const detected: Record<string, { pattern: string; classes: string[] }> = {};

    for (const [category, targets] of Object.entries(OPTIONAL_INTEGRATION_PATTERNS)) {
        const found = new Set<string>();
        for (const target of targets) {
            for (const cls of (index.references[target] ?? [])) found.add(cls);
        }
        if (found.size > 0) {
            detected[category] = { pattern: targets[0], classes: [...found].sort() };
        }
    }

    // Also look for string constants referencing known modIds (heuristic via field refs)
    // by scanning for classes with many external-mod package references
    const externalPackages = new Set<string>();
    for (const refKey of Object.keys(index.references)) {
        const pkg = refKey.split("/").slice(0, 3).join("/");
        const modPkg = refKey.split("/")[0];
        if (!["net", "com", "org", "java", "javax"].includes(modPkg)) {
            externalPackages.add(pkg);
        }
    }

    return {
        mod: dbId,
        totalIntegrationCategories: Object.keys(detected).length,
        note: "Detected via bytecode reference analysis. A category being absent does not mean no integration — some mods use reflection.",
        integrations: detected,
        externalTopPackages: [...externalPackages].sort().slice(0, 30),
    };
}

// ── Network payload inventory ──────────────────────────────────────────────────

// Classes that indicate network packet/payload registration across loaders
const NETWORK_PAYLOAD_TARGETS: Record<string, string[]> = {
    "neoforge_payload": [
        "net/neoforged/neoforge/network/handling/IPayloadContext",
        "net/neoforged/neoforge/network/codec/NetworkCodecBuf",
        "net/neoforged/neoforge/network/registration/NetworkRegistry",
    ],
    "custom_packet_payload": [
        "net/minecraft/network/protocol/common/custom/CustomPacketPayload",
    ],
    "stream_codec": [
        "net/minecraft/network/codec/StreamCodec",
        "net/minecraft/network/codec/ByteBufCodecs",
    ],
    "forge_channel": [
        "net/minecraftforge/network/Channel",
        "net/minecraftforge/network/NetworkRegistry",
        "net/minecraftforge/network/simple/SimpleChannel",
    ],
    "fabric_packet": [
        "net/fabricmc/fabric/api/networking/v1/ServerPlayNetworking",
        "net/fabricmc/fabric/api/networking/v1/PayloadTypeRegistry",
    ],
};

/**
 * Inventory all network packet/payload classes a mod ships.
 * Identifies classes implementing CustomPacketPayload, StreamCodec types,
 * and loader-specific network channel patterns.
 * No decompilation needed — works from JAR index + class inspection.
 */
export async function findNetworkPayloads(
    dbId: number,
): Promise<object> {
    const jarPath = await getModJar(dbId);
    const index   = await indexJar(jarPath);

    // Gather all candidate classes by pattern category
    const byCategory: Record<string, Set<string>> = {};
    for (const [cat, targets] of Object.entries(NETWORK_PAYLOAD_TARGETS)) {
        const found = new Set<string>();
        for (const target of targets) {
            for (const cls of (index.references[target] ?? [])) found.add(cls);
        }
        if (found.size > 0) byCategory[cat] = found;
    }

    // Also find CustomPacketPayload implementors via inheritance index
    const payloadImpls: string[] = [];
    const payloadInterface = "net/minecraft/network/protocol/common/custom/CustomPacketPayload";
    for (const [cls, info] of Object.entries(index.classes ?? {})) {
        if ((info.interfaces ?? []).includes(payloadInterface)) payloadImpls.push(cls);
    }

    // Collect unique payload classes and inspect them for TYPE field (packet id)
    const allCandidates = new Set<string>([
        ...payloadImpls,
        ...Object.values(byCategory).flatMap(s => [...s]),
    ]);

    const payloads: Array<{ className: string; fields: string[]; methods: string[]; category: string }> = [];
    for (const cls of allCandidates) {
        // Determine which category it falls in
        let cat = "unknown";
        if (payloadImpls.includes(cls)) cat = "custom_packet_payload";
        else {
            for (const [c, s] of Object.entries(byCategory)) {
                if (s.has(cls)) { cat = c; break; }
            }
        }
        try {
            const info = await inspectClass(jarPath, cls);
            const typeFields = info.fields.filter(f =>
                f.name === "TYPE" || f.name === "ID" || f.name === "PACKET_ID" ||
                f.descriptor.includes("ResourceLocation") || f.descriptor.includes("CustomPacketPayload$Type")
            ).map(f => `${f.name}: ${f.descriptor}`);
            const handleMethods = info.methods.filter(m =>
                m.name === "handle" || m.name === "write" || m.name === "codec" || m.name === "type"
            ).map(m => `${m.name}${m.descriptor}`);
            payloads.push({ className: cls, fields: typeFields, methods: handleMethods, category: cat });
        } catch {
            payloads.push({ className: cls, fields: [], methods: [], category: cat });
        }
    }

    return {
        mod: dbId,
        totalPayloadClasses: payloads.length,
        note: "Payload classes identified via bytecode reference analysis. Use mod_bytecode class_members for full detail on any class.",
        byCategory: Object.fromEntries(
            Object.entries(byCategory).map(([k, v]) => [k, [...v]])
        ),
        payloads: payloads.sort((a, b) => a.className.localeCompare(b.className)),
    };
}

// ── Config schema extraction ───────────────────────────────────────────────────

const CONFIG_BUILDER_TARGETS: Record<string, string[]> = {
    "neoforge_config": [
        "net/neoforged/neoforge/common/ModConfigSpec$Builder",
        "net/neoforged/neoforge/common/ModConfigSpec",
    ],
    "forge_config": [
        "net/minecraftforge/common/ForgeConfigSpec$Builder",
        "net/minecraftforge/common/ForgeConfigSpec",
    ],
    "cloth_config": [
        "me/shedaniel/clothconfig2/api/ConfigBuilder",
        "me/shedaniel/clothconfig2/api/ConfigCategory",
    ],
    "auto_config": [
        "me/shedaniel/autoconfig/AutoConfig",
        "me/shedaniel/autoconfig/annotation/Config",
    ],
    "night_config": [
        "com/electronwill/nightconfig/core/Config",
        "com/electronwill/nightconfig/toml/TomlFormat",
    ],
};

/**
 * Extract the config schema from a mod's JAR by analysing which classes use
 * config builder APIs. Works without decompilation — identifies the classes
 * that define config keys, then uses class inspection to surface field names.
 *
 * For NeoForge/Forge ModConfigSpec the builder class typically has string
 * define/defineInRange/defineEnum calls; field names are the best proxy.
 */
export async function extractConfigSchema(
    dbId: number,
): Promise<object> {
    const jarPath = await getModJar(dbId);
    const index   = await indexJar(jarPath);

    const detected: Record<string, string[]> = {};
    for (const [system, targets] of Object.entries(CONFIG_BUILDER_TARGETS)) {
        const found = new Set<string>();
        for (const t of targets) {
            for (const cls of (index.references[t] ?? [])) found.add(cls);
        }
        if (found.size > 0) detected[system] = [...found].sort();
    }

    if (Object.keys(detected).length === 0) {
        return { mod: dbId, note: "No known config builder patterns found in this JAR.", configSystems: [] };
    }

    // Inspect each config class to surface field names as proxies for config keys
    const schemas: Array<{ system: string; className: string; candidateKeys: string[] }> = [];
    for (const [system, classes] of Object.entries(detected)) {
        for (const cls of classes.slice(0, 10)) { // cap per system
            try {
                const info = await inspectClass(jarPath, cls);
                // Heuristic: static final fields of type ConfigValue / BooleanValue / IntValue / String / etc.
                const keyFields = info.fields.filter(f =>
                    f.descriptor.includes("ConfigValue") ||
                    f.descriptor.includes("BooleanValue") ||
                    f.descriptor.includes("IntValue") ||
                    f.descriptor.includes("DoubleValue") ||
                    f.descriptor.includes("LongValue") ||
                    f.descriptor.includes("EnumValue") ||
                    // static String fields often hold key names
                    (f.descriptor === "Ljava/lang/String;" && f.name === f.name.toUpperCase())
                ).map(f => `${f.name}: ${f.descriptor}`);
                schemas.push({ system, className: cls, candidateKeys: keyFields });
            } catch {
                schemas.push({ system, className: cls, candidateKeys: [] });
            }
        }
    }

    return {
        mod: dbId,
        note: "Config keys inferred from builder class fields. Not all field names map 1:1 to config keys — use mod_bytecode class_members for full detail.",
        configSystems: Object.keys(detected),
        schemas,
    };
}
