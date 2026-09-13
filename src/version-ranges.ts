/** Fabric's extended semver predicates and Forge/Maven interval declarations. */
export function normalizeVersionRange(value: unknown): string {
    return Array.isArray(value) ? value.filter(v => typeof v === "string").join(" || ")
        : typeof value === "string" ? value : "";
}

function compare(a: string, b: string): number {
    const parse = (v: string) => v.match(/^(\d+(?:\.\d+)*)(?:-([^+]*))?(?:\+.*)?$/);
    const left = parse(a), right = parse(b);
    if (!left || !right) return a === b ? 0 : NaN;
    const x = left[1].split(".").map(Number), y = right[1].split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    if (left[2] === right[2]) return 0;
    if (left[2] === undefined) return 1;
    if (right[2] === undefined) return -1;
    const xp = left[2].split("."), yp = right[2].split(".");
    for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
        if (xp[i] === yp[i]) continue;
        if (xp[i] === undefined || xp[i] === "") return -1;
        if (yp[i] === undefined || yp[i] === "") return 1;
        const xn = /^\d+$/.test(xp[i]), yn = /^\d+$/.test(yp[i]);
        return xn && yn ? Number(xp[i]) - Number(yp[i]) : xn ? -1 : yn ? 1 : xp[i] < yp[i] ? -1 : 1;
    }
    return 0;
}

export function matchesVersionRange(version: string, declaration: unknown): boolean {
    const range = normalizeVersionRange(declaration).trim();
    if (!range) return false;
    if (range === "*" || range === "any") return true;
    if (range.includes("||")) return range.split("||").some(part => matchesVersionRange(version, part));
    if (/^[[(]/.test(range)) {
        const intervals = [...range.matchAll(/([[(])([^()[\]]*)([)\]])/g)];
        if (!intervals.length || range.replace(/([[(])([^()[\]]*)([)\]])/g, "").replace(/[\s,]/g, "")) return false;
        return intervals.some(([, open, bounds, close]) => {
            if (!bounds.includes(",")) return open === "[" && close === "]" && compare(version, bounds.trim()) === 0;
            const [min, max] = bounds.split(",").map(v => v.trim());
            return (!min || (open === "[" ? compare(version, min) >= 0 : compare(version, min) > 0))
                && (!max || (close === "]" ? compare(version, max) <= 0 : compare(version, max) < 0));
        });
    }
    const predicates = [...range.matchAll(/\s*([<>]=?|=|~|\^)?\s*([^\s]+)/g)];
    return predicates.length > 0 && predicates.every(([, op = "=", target]) => {
        if (target === "*") return true;
        const wildcard = target.match(/^(\d+(?:\.\d+)*)(?:\.[xX*])+$/);
        if (wildcard) {
            const parts = wildcard[1].split(".").map(Number);
            const upper = [...parts]; upper[upper.length - 1]++;
            return compare(version, parts.join(".") + "-") >= 0 && compare(version, upper.join(".") + "-") < 0;
        }
        const cmp = compare(version, target);
        if (op === ">=") return cmp >= 0;
        if (op === ">") return cmp > 0;
        if (op === "<=") return cmp <= 0;
        if (op === "<") return cmp < 0;
        if (op === "^" || op === "~") {
            const core = target.match(/^\d+(?:\.\d+)*/)?.[0];
            if (!core) return false;
            const upper = core.split(".").map(Number);
            const index = op === "^" ? 0 : Math.min(1, upper.length - 1);
            upper[index]++;
            for (let i = index + 1; i < upper.length; i++) upper[i] = 0;
            return cmp >= 0 && compare(version, upper.join(".") + "-") < 0;
        }
        return cmp === 0;
    });
}

export function matchesMcVersion(declaration: string, version: string): boolean {
    return matchesVersionRange(version, declaration)
        || (/^\d+(?:\.\d+)*$/.test(declaration) && declaration.startsWith(version + "."));
}
