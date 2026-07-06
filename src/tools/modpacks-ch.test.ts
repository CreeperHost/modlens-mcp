import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cache.js", () => ({
    CACHE_ROOT: "/tmp/modlens-cache",
    ensureDir: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
}));

vi.mock("./ingest.js", () => ({
    ingestMod: vi.fn(),
}));

vi.mock("../repositories/packs.js", () => ({
    upsertPackVersion: vi.fn(),
    upsertPackFile: vi.fn(),
    listPackVersions: vi.fn(),
    listPackFiles: vi.fn(),
    findPacksForMod: vi.fn(),
    findPacksForCfProject: vi.fn(),
    findPackVersion: vi.fn(),
}));

vi.mock("../modpacks-ch.js", () => ({
    USER_AGENT: "modlens-test",
    searchPacks: vi.fn(),
    getFeaturedPacks: vi.fn(),
    getPack: vi.fn(),
    getPackManifest: vi.fn(),
    getCfPack: vi.fn(),
    getCfPackManifest: vi.fn(),
    searchMods: vi.fn(),
    getMod: vi.fn(),
    getModsBatch: vi.fn(),
    resolveModVersionUrl: vi.fn(),
    cfCdnUrl: vi.fn(),
    downloadManifestFile: vi.fn(),
    resolveFileUrl: vi.fn(),
}));

vi.mock("../modrinth.js", () => ({
    searchProjects: vi.fn(),
    getProject: vi.fn(),
    getProjectVersions: vi.fn(),
    getProjectVersion: vi.fn(),
    getVersion: vi.fn(),
    getPrimaryFile: vi.fn(),
}));

vi.mock("../feed-the-beast.js", () => ({
    searchOfficialFtbPacks: vi.fn(),
    getOfficialFtbPack: vi.fn(),
    getOfficialFtbPackManifest: vi.fn(),
}));

const { resolvePackAction, searchPacksAction, listRemotePackVersionsAction } = await import("./modpacks-ch.js");
const mpch = await import("../modpacks-ch.js");
const mr = await import("../modrinth.js");
const ftb = await import("../feed-the-beast.js");

const cfPack = {
    id: 925200,
    name: "All the Mods 10 - ATM10",
    synopsis: "ATM10",
    provider: "curseforge",
    installs: 1,
    tags: [],
    authors: [],
    links: [],
    versions: [
        {
            id: 8323938,
            name: "All the Mods 10-7.1",
            type: "Release",
            updated: 1,
            targets: [
                { id: 1, name: "minecraft", type: "game", version: "1.21.1", updated: 1 },
                { id: 2, name: "neoforge", type: "modloader", version: "21.1.200", updated: 1 },
            ],
        },
        {
            id: 123,
            name: "All the Mods 10-7.0",
            type: "Release",
            updated: 1,
            targets: [],
        },
    ],
};

const officialFtbPack = {
    id: 127,
    name: "FTB Presents Architect's Exodus",
    slug: "ftb-presents-architects-exodus",
    synopsis: "Architect's Exodus",
    provider: "ftb",
    installs: 1,
    plays: 1,
    tags: [],
    authors: [],
    links: [],
    versions: [
        {
            id: 100395,
            name: "1.1.0",
            type: "release",
            updated: 1782674102,
            targets: [
                { id: -1, name: "minecraft", type: "game", version: "1.20.1", updated: 0 },
                { id: -1, name: "forge", type: "modloader", version: "47.4.20", updated: 0 },
            ],
        },
    ],
};

describe("modpacks_ch pack resolution", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("resolves a CurseForge/modpacks.ch pack by name and version name", async () => {
        vi.mocked(mpch.searchPacks).mockResolvedValue({ packs: [], curseforge: [925200], total: 1, limit: 20 });
        vi.mocked(mpch.getCfPack).mockResolvedValue(cfPack as any);

        const resolved = await resolvePackAction({
            namespace: "curseforge",
            packRef: "All the Mods 10",
            versionRef: "All the Mods 10-7.1",
        });

        expect(resolved).toMatchObject({
            namespace: "curseforge",
            packId: 925200,
            versionId: 8323938,
            packName: "All the Mods 10 - ATM10",
            versionName: "All the Mods 10-7.1",
            mcVersion: "1.21.1",
            loader: "neoforge",
        });
    });

    it("resolves a CurseForge/modpacks.ch pack by numeric pack and version IDs", async () => {
        vi.mocked(mpch.getCfPack).mockResolvedValue(cfPack as any);

        const resolved = await resolvePackAction({
            namespace: "curseforge",
            packId: 925200,
            versionId: 8323938,
        });

        expect(mpch.searchPacks).not.toHaveBeenCalled();
        expect(resolved.packId).toBe(925200);
        expect(resolved.versionId).toBe(8323938);
    });

    it("resolves a short version ref against the full pack version name", async () => {
        vi.mocked(mpch.getCfPack).mockResolvedValue(cfPack as any);

        const resolved = await resolvePackAction({
            namespace: "curseforge",
            packId: 925200,
            versionRef: "7.1",
        });

        expect(resolved.versionId).toBe(8323938);
        expect(resolved.versionName).toBe("All the Mods 10-7.1");
    });

    it("lists remote CurseForge/modpacks.ch versions and marks versionRef matches", async () => {
        vi.mocked(mpch.getCfPack).mockResolvedValue(cfPack as any);

        const result = await listRemotePackVersionsAction({
            namespace: "curseforge",
            packId: 925200,
            versionRef: "7.1",
        }) as any;

        expect(result.total).toBe(2);
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
            id: 8323938,
            name: "All the Mods 10-7.1",
            matchesRef: true,
        });
    });

    it("surfaces Modrinth modpack search results", async () => {
        vi.mocked(mr.searchProjects).mockResolvedValue({
            hits: [{
                project_id: "mr-project",
                slug: "fabulously-optimized",
                title: "Fabulously Optimized",
                description: "Client optimization pack",
                categories: [],
                downloads: 42,
                follows: 10,
                latest_version: "1.0.0",
                versions: ["1.21.1"],
                loaders: ["fabric"],
                date_modified: "2026-01-01T00:00:00Z",
                license: "MIT",
                project_type: "modpack",
            }],
            offset: 0,
            limit: 20,
            total_hits: 1,
        });

        const result = await searchPacksAction("Fabulously Optimized", "modrinth", 20) as any;

        expect(result.total).toBe(1);
        expect(result.modrinthPacks[0]).toMatchObject({
            id: "mr-project",
            slug: "fabulously-optimized",
            name: "Fabulously Optimized",
        });
    });

    it("resolves a Modrinth pack by project search and version number", async () => {
        vi.mocked(mr.getProject).mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: "mr-project",
            slug: "fabulously-optimized",
            title: "Fabulously Optimized",
            description: "Client optimization pack",
            project_type: "modpack",
            source_url: null,
            issues_url: null,
        });
        vi.mocked(mr.searchProjects).mockResolvedValue({
            hits: [{
                project_id: "mr-project",
                slug: "fabulously-optimized",
                title: "Fabulously Optimized",
                description: "Client optimization pack",
                categories: [],
                downloads: 42,
                follows: 10,
                latest_version: "1.0.0",
                versions: ["1.21.1"],
                loaders: ["fabric"],
                date_modified: "2026-01-01T00:00:00Z",
                license: "MIT",
                project_type: "modpack",
            }],
            offset: 0,
            limit: 10,
            total_hits: 1,
        });
        vi.mocked(mr.getProjectVersion).mockResolvedValue(null);
        vi.mocked(mr.getProjectVersions).mockResolvedValue([{
            id: "mr-version",
            project_id: "mr-project",
            name: "Pack 1.0.0",
            version_number: "1.0.0",
            version_type: "release",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            date_published: "2026-01-01T00:00:00Z",
            downloads: 1,
            files: [],
        }]);

        const resolved = await resolvePackAction({
            namespace: "modrinth",
            packRef: "Fabulously Optimized",
            versionRef: "1.0.0",
        });

        expect(resolved).toMatchObject({
            namespace: "modrinth",
            packName: "Fabulously Optimized",
            versionName: "Pack 1.0.0",
            mcVersion: "1.21.1",
            loader: "fabric",
            sourcePackId: "mr-project",
            sourceVersionId: "mr-version",
        });
        expect(resolved.packId).toEqual(expect.any(Number));
        expect(resolved.versionId).toEqual(expect.any(Number));
    });

    it("resolves a Modrinth web URL with an embedded version ref", async () => {
        vi.mocked(mr.getProject).mockResolvedValue({
            id: "mr-project",
            slug: "fabulously-optimized",
            title: "Fabulously Optimized",
            description: "Client optimization pack",
            project_type: "modpack",
            source_url: null,
            issues_url: null,
        });
        vi.mocked(mr.getProjectVersion).mockResolvedValue({
            id: "mr-version",
            project_id: "mr-project",
            name: "Pack 1.0.0",
            version_number: "1.0.0",
            version_type: "release",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            date_published: "2026-01-01T00:00:00Z",
            downloads: 1,
            files: [],
        });

        const resolved = await resolvePackAction({
            namespace: "modrinth",
            packRef: "https://modrinth.com/modpack/fabulously-optimized/version/mr-version",
        });

        expect(mr.getProject).toHaveBeenCalledWith("fabulously-optimized");
        expect(mr.getProjectVersion).toHaveBeenCalledWith("fabulously-optimized", "mr-version");
        expect(resolved).toMatchObject({
            namespace: "modrinth",
            packName: "Fabulously Optimized",
            versionName: "Pack 1.0.0",
            sourcePackId: "mr-project",
            sourceVersionId: "mr-version",
        });
    });

    it("resolves a Modrinth API project/version URL", async () => {
        vi.mocked(mr.getProject).mockResolvedValue({
            id: "mr-project",
            slug: "fabulously-optimized",
            title: "Fabulously Optimized",
            description: "Client optimization pack",
            project_type: "modpack",
            source_url: null,
            issues_url: null,
        });
        vi.mocked(mr.getProjectVersion).mockResolvedValue({
            id: "mr-version",
            project_id: "mr-project",
            name: "Pack 1.0.0",
            version_number: "1.0.0",
            version_type: "release",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            date_published: "2026-01-01T00:00:00Z",
            downloads: 1,
            files: [],
        });

        const resolved = await resolvePackAction({
            namespace: "modrinth",
            packRef: "https://api.modrinth.com/v2/project/fabulously-optimized/version/mr-version",
        });

        expect(resolved.sourceVersionId).toBe("mr-version");
    });

    it("lists remote Modrinth versions and marks versionRef matches", async () => {
        vi.mocked(mr.getProject).mockResolvedValue({
            id: "mr-project",
            slug: "fabulously-optimized",
            title: "Fabulously Optimized",
            description: "Client optimization pack",
            project_type: "modpack",
            source_url: null,
            issues_url: null,
        });
        vi.mocked(mr.getProjectVersions).mockResolvedValue([{
            id: "mr-version",
            project_id: "mr-project",
            name: "Pack 1.0.0",
            version_number: "1.0.0",
            version_type: "release",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            date_published: "2026-01-01T00:00:00Z",
            downloads: 1,
            files: [],
        }]);

        const result = await listRemotePackVersionsAction({
            namespace: "modrinth",
            packRef: "fabulously-optimized",
            versionRef: "1.0",
        }) as any;

        expect(result.total).toBe(1);
        expect(result.matches[0]).toMatchObject({
            id: "mr-version",
            version: "1.0.0",
            matchesRef: true,
        });
    });

    it("resolves an official Feed The Beast pack by fuzzy name and version", async () => {
        vi.mocked(ftb.searchOfficialFtbPacks).mockResolvedValue({
            packs: [officialFtbPack as any],
            count: 1,
            limit: 20,
        });
        vi.mocked(ftb.getOfficialFtbPack).mockResolvedValue(officialFtbPack as any);

        const resolved = await resolvePackAction({
            namespace: "feedthebeast",
            packRef: "Architect's",
            versionRef: "1.1",
        });

        expect(resolved).toMatchObject({
            namespace: "feedthebeast",
            packId: 127,
            versionId: 100395,
            packName: "FTB Presents Architect's Exodus",
            versionName: "1.1.0",
            mcVersion: "1.20.1",
            loader: "forge",
        });
    });

    it("resolves a Modrinth API version URL by hydrating its project", async () => {
        vi.mocked(mr.getVersion).mockResolvedValue({
            id: "mr-version",
            project_id: "mr-project",
            name: "Pack 1.0.0",
            version_number: "1.0.0",
            version_type: "release",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            date_published: "2026-01-01T00:00:00Z",
            downloads: 1,
            files: [],
        });
        vi.mocked(mr.getProject).mockResolvedValue({
            id: "mr-project",
            slug: "fabulously-optimized",
            title: "Fabulously Optimized",
            description: "Client optimization pack",
            project_type: "modpack",
            source_url: null,
            issues_url: null,
        });

        const resolved = await resolvePackAction({
            namespace: "modrinth",
            packRef: "https://api.modrinth.com/v2/version/mr-version",
        });

        expect(mr.getVersion).toHaveBeenCalledWith("mr-version");
        expect(resolved).toMatchObject({
            namespace: "modrinth",
            packName: "Fabulously Optimized",
            sourcePackId: "mr-project",
            sourceVersionId: "mr-version",
        });
    });
});
