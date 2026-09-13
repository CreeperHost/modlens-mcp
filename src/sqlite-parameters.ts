/** SQLite's native adapter binds positional '?' parameters, not PostgreSQL '$n' names. */
export function sqliteRawArgs(args: unknown[]): unknown[] {
    if (typeof args[0] !== "string") return args;
    const values: unknown[] = [];
    let changed = false;
    const sql = args[0].replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\$(\d+)/g, (token, index: string | undefined) => {
        if (index === undefined) return token;
        const n = Number(index);
        if (n < 1 || n >= args.length) throw new Error(`Missing SQL parameter $${index}`);
        values.push(args[n]);
        changed = true;
        return "?";
    });
    return changed ? [sql,...values] : args;
}
