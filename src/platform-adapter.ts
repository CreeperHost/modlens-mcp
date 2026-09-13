/** Hashes available for a mod JAR at ingest time. */
export type JarHashes = {
    sha1?: string | null;
    sha512:  string | null;
    murmur2: string | null;
};

/** Result from a successful platform lookup. */
export type PlatformHit =
    | { platform: "modrinth";   projectId: string; slug?: string; sourceUrl?: string | null }
    | { platform: "curseforge"; projectId: number; slug?: string; sourceUrl?: string };

/** An adapter that can identify a mod JAR on one platform. */
export type PlatformAdapter = {
    name: string;
    lookup: (hashes: JarHashes) => Promise<PlatformHit | null>;
};
