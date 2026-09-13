import { getDb } from "../db.js";

/** Exact JSON-array membership, including escaped strings, on SQLite. */
export async function sqliteArrayMemberIds(
    table: "mod_classes" | "doc_entries", column: "interfaces" | "tags", value: string,
): Promise<number[]> {
    const db = await getDb();
    const rows = await db.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT DISTINCT t.id FROM ${table} t, json_each(t.${column}) j WHERE j.value = $1`, value,
    );
    return rows.map(row => row.id);
}
