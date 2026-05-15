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

    // Find classes that directly extend the target
    const bySuper = await db().modClass.findMany({
        where: {
            superClass: internal,
            ...(modDbId ? { modId: modDbId } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true, version: true } } },
        take: limit,
    });

    // Find classes that implement the target as an interface
    const byInterface = await db().modClass.findMany({
        where: {
            interfaces: { has: internal },
            ...(modDbId ? { modId: modDbId } : {}),
        },
        include: { mod: { select: { modId: true, displayName: true, version: true } } },
        take: limit,
    });

    const format = (cls: typeof bySuper[0]) => ({
        className: cls.className,
        mod: cls.mod.modId,
        modDisplay: cls.mod.displayName,
        version: cls.mod.version,
    });

    return {
        target: internal,
        directSubclasses: { count: bySuper.length, classes: bySuper.map(format) },
        implementors:     { count: byInterface.length, classes: byInterface.map(format) },
    };
}
