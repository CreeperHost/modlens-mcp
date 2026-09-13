/** Preserve the public Prisma model shapes when SQLite stores JSON as TEXT. */
const fields: Record<string, Record<string, "array" | "object">> = {
    Mod: { mixinConfigs: "array", mixinTargets: "array", atEntries: "array", awEntries: "array", dependencies: "array", tags: "array", metadata: "object" },
    ModClass: { interfaces: "array" },
    ModTag: { entries: "array" },
    DocEntry: { tags: "array" },
    Primer: { tags: "array" },
};

const relations: Record<string, Record<string, string>> = {
    Mod: { classes: "ModClass", modTags: "ModTag", sourceFiles: "ModSourceFile", packFiles: "PackFile" },
    ModClass: { mod: "Mod" }, ModTag: { mod: "Mod" }, ModSourceFile: { mod: "Mod" },
    PackFile: { mod: "Mod", packVersion: "PackVersion" }, PackVersion: { files: "PackFile" },
};

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && !(value instanceof Date) && !ArrayBuffer.isView(value);
}

export function decodeSqliteResult(model: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map(row => decodeSqliteResult(model, row));
    if (!record(value)) return value;
    const result = { ...value };
    for (const [key, kind] of Object.entries(fields[model] ?? {})) {
        if (typeof result[key] !== "string") continue;
        const parsed: unknown = JSON.parse(result[key] as string);
        if (kind === "array" ? !Array.isArray(parsed) : !record(parsed)) {
            throw new Error(`Invalid stored JSON in ${model}.${key}: expected ${kind}`);
        }
        result[key] = parsed;
    }
    for (const [key, relatedModel] of Object.entries(relations[model] ?? {})) {
        if (key in result) result[key] = decodeSqliteResult(relatedModel, result[key]);
    }
    return result;
}

function encodeData(model: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map(row => encodeData(model, row));
    if (!record(value)) return value;
    const result = { ...value };
    for (const key of Object.keys(fields[model] ?? {})) {
        const entry = result[key];
        if (entry === undefined || entry === null || typeof entry === "string") continue;
        result[key] = record(entry) && "set" in entry
            ? { ...entry, set: typeof entry.set === "string" ? entry.set : JSON.stringify(entry.set) }
            : JSON.stringify(entry);
    }
    for (const [key, relatedModel] of Object.entries(relations[model] ?? {})) {
        if (record(result[key])) result[key] = encodeSqliteArgs(relatedModel, result[key]);
    }
    return result;
}

export function encodeSqliteArgs(model: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map(row => encodeSqliteArgs(model, row));
    if (!record(value)) return value;
    const result = { ...value };
    for (const key of ["data", "create", "update"]) {
        if (key in result) {
            const encode = (entry: unknown): unknown => record(entry) && "data" in entry
                ? encodeSqliteArgs(model, entry) : encodeData(model, entry);
            result[key] = Array.isArray(result[key]) ? result[key].map(encode) : encode(result[key]);
        }
    }
    for (const key of ["createMany", "updateMany", "upsert", "connectOrCreate"]) {
        if (key in result) result[key] = encodeSqliteArgs(model, result[key]);
    }
    return result;
}
