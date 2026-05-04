import AdmZip from "adm-zip";

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

/** List all .class file entry names. */
export function listClasses(jarPath: string): string[] {
    return listEntries(jarPath).filter((n) => n.endsWith(".class"));
}
