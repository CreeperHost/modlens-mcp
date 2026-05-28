import AdmZip from "adm-zip";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";

/** Extract a single entry from a JAR/ZIP by its internal name. */
export function extractEntry(jarPath: string, entryName: string): Buffer | null {
    const zip = new AdmZip(jarPath);
    const entry = zip.getEntry(entryName);
    return entry ? zip.readFile(entry) : null;
}

/** List all entries matching a prefix (directory listing). */
export function listEntries(jarPath: string, prefix = ""): string[] {
    const zip = new AdmZip(jarPath);
    return zip
        .getEntries()
        .map((e) => e.entryName)
        .filter((n) => n.startsWith(prefix));
}

/** List all .class file entry names, recursing into Jar-in-Jar nested JARs. */
export function listClasses(jarPath: string, _depth = 0): string[] {
    if (_depth > 2) return []; // safety cap on nesting
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries();
    const classes: string[] = [];

    for (const entry of entries) {
        if (entry.entryName.endsWith(".class")) {
            classes.push(entry.entryName);
        } else if (
            (entry.entryName.startsWith("META-INF/jars/") || entry.entryName.startsWith("META-INF/jarjar/"))
            && entry.entryName.endsWith(".jar")
            && _depth < 2
        ) {
            // Jar-in-Jar: Fabric (META-INF/jars/) and NeoForge/Forge (META-INF/jarjar/)
            try {
                const buf = zip.readFile(entry);
                if (!buf) continue;
                const tmpDir = join(tmpdir(), "modlens-jij");
                mkdirSync(tmpDir, { recursive: true });
                const tmpJar = join(tmpDir, entry.entryName.replace(/\//g, "_"));
                writeFileSync(tmpJar, buf);
                const nested = listClasses(tmpJar, _depth + 1);
                classes.push(...nested);
            } catch {
                // ignore unreadable nested JARs
            }
        }
    }

    return classes;
}
