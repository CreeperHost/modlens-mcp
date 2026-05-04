/**
 * Class name search — CamelCase acronym, prefix, and substring matching.
 * Ported from the mcsrc web app search algorithm.
 */
export function searchClasses(classes: string[], query: string): string[] {
    const q = query.trim();
    if (!q) return [];

    const simpleNames = classes.map((c) => {
        const parts = c.split("/");
        return parts[parts.length - 1];
    });

    type Scored = { score: number; name: string; };
    const results: Scored[] = [];

    const upperQ = q.toUpperCase();
    const lowerQ = q.toLowerCase();

    for (let i = 0; i < classes.length; i++) {
        const simple = simpleNames[i];
        const simpleUpper = simple.toUpperCase();

        if (simple === q) {
            results.push({ score: 0, name: classes[i] });
            continue;
        }
        if (simple.startsWith(q)) {
            results.push({ score: 1, name: classes[i] });
            continue;
        }
        // CamelCase acronym match
        if (camelMatch(simple, q)) {
            results.push({ score: 2, name: classes[i] });
            continue;
        }
        // Case-insensitive prefix
        if (simpleUpper.startsWith(upperQ)) {
            results.push({ score: 3, name: classes[i] });
            continue;
        }
        // Substring
        if (simple.toLowerCase().includes(lowerQ)) {
            results.push({ score: 4 + simple.toLowerCase().indexOf(lowerQ), name: classes[i] });
        }
    }

    return results
        .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
        .slice(0, 100)
        .map((r) => r.name);
}

function camelMatch(className: string, query: string): boolean {
    const uppers = className.match(/[A-Z]/g);
    if (!uppers) return false;
    const acronym = uppers.join("");
    return acronym.toUpperCase().includes(query.toUpperCase());
}
