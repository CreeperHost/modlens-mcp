/** Verified against https://docs.neoforged.net/primer/docs/ (2026-09-13). */
export interface PrimerSeed {
    fromVersion: string;
    toVersion: string;
    modloader: string;
    title: string;
    summary: string;
    url: string;
    tags: string[];
    source: "seed";
}

const ROOT = "https://docs.neoforged.net/primer/docs/";
// The early guides combine vanilla and Forge; later loader changes have their own pages.
const STEPS: Array<[from: string, to: string, loader?: "forge" | "neoforge" | "combined-forge"]> = [
    ["1.12", "1.14", "combined-forge"], ["1.14", "1.15", "combined-forge"],
    ["1.15.2", "1.16.5", "combined-forge"], ["1.16.5", "1.17", "combined-forge"],
    ["1.19.2", "1.19.3", "forge"], ["1.19.3", "1.19.4", "forge"], ["1.19.4", "1.20", "forge"],
    ["1.20.4", "1.20.5", "neoforge"], ["1.20.5", "1.20.6"], ["1.20.6", "1.21", "neoforge"],
    ["1.21", "1.21.1"], ["1.21.1", "1.21.2", "neoforge"], ["1.21.2", "1.21.4", "neoforge"],
    ["1.21.4", "1.21.5", "neoforge"], ["1.21.5", "1.21.6", "neoforge"],
    ["1.21.6", "1.21.7"], ["1.21.7", "1.21.8"], ["1.21.8", "1.21.9", "neoforge"],
    ["1.21.9", "1.21.10"], ["1.21.10", "1.21.11", "neoforge"],
    ["1.21.11", "26.1", "neoforge"], ["26.1", "26.2"],
];

export const SEED_PRIMERS: PrimerSeed[] = STEPS.flatMap(([fromVersion, toVersion, loader]) => {
    const label = `${fromVersion} → ${toVersion}`;
    const base: PrimerSeed = {
        fromVersion, toVersion, modloader: loader === "combined-forge" ? "forge" : "vanilla",
        title: `Minecraft${loader === "combined-forge" ? " / Forge" : ""} migration primer — ${label}`,
        summary: `Migration notes for ${label}, covering ${loader === "combined-forge" ? "vanilla and Forge" : "vanilla"} API changes.`,
        url: `${ROOT}${toVersion}/`, tags: ["migration", fromVersion, toVersion], source: "seed",
    };
    if (!loader || loader === "combined-forge") return [base];
    return [base, { ...base, modloader: loader,
        title: `${loader === "forge" ? "Forge" : "NeoForge"} changes — ${label}`,
        summary: `Loader-specific migration notes for ${label}; read alongside the vanilla primer.`,
        url: `${ROOT}${toVersion}/${loader === "forge" ? "forge" : "neo"}/`,
        tags: [...base.tags, loader],
    }];
});

/** Only exact known seed URLs are eligible for repair. Null means a catalogue placeholder, not a guide. */
export const LEGACY_PRIMER_URLS: Record<string, string | null> = {
    "https://docs.neoforged.net/docs/1.21.x/migrationguide/": `${ROOT}1.20.5/`,
    "https://docs.neoforged.net/docs/1.20.4/migrationguide/": null,
    "https://docs.neoforged.net/docs/1.21.5/migrationguide/": `${ROOT}1.21.5/`,
    "https://docs.neoforged.net/docs/current/migrationguide/": `${ROOT}1.21.6/`,
    "https://docs.neoforged.net/docs/gettingstarted/": null,
    "https://github.com/MinecraftForge/MinecraftForge/blob/1.20.1/Changelog.md": `${ROOT}1.20/forge/`,
    "https://github.com/MinecraftForge/MinecraftForge/blob/1.19.4/Changelog.md": `${ROOT}1.19.4/forge/`,
    "https://fabricmc.net/wiki/tutorial:migration": `${ROOT}1.21.1/`,
    "https://github.com/neoforged/NeoForge/blob/main/CHANGELOG.md": null,
};
