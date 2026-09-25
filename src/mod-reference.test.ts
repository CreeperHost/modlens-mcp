import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { stageModReference, resolveModReference } from "./mod-reference.js";
import { getMod, getModsBatch, providerVersions, searchMods } from "./modpacks-ch.js";
import { downloadModVersion } from "./mod-artifacts.js";
import { inspectJarLoaders, parseJar } from "./processor.js";
import { findModById, findModBySha1, findModsByExactModId, updateMod } from "./repositories/mod.js";
import { ingestMod } from "./tools/ingest.js";

vi.mock("./modpacks-ch.js", () => ({ getMod: vi.fn(), getModsBatch: vi.fn(), providerVersions: vi.fn(), searchMods: vi.fn() }));
vi.mock("./mod-artifacts.js", () => ({ downloadModVersion: vi.fn() }));
vi.mock("./processor.js", () => ({ parseJar: vi.fn(), inspectJarLoaders: vi.fn() }));
vi.mock("./repositories/mod.js", () => ({ findModById: vi.fn(), findModBySha1: vi.fn(), findModsByExactModId: vi.fn(), updateMod: vi.fn() }));
vi.mock("./tools/ingest.js", () => ({ ingestMod: vi.fn() }));

const directory = mkdtempSync(join(tmpdir(), "modlens-ref-"));
const jarPath = join(directory, "bewitchment.jar");
const zip = new AdmZip();
zip.addFile("moriyashiine/bewitchment/Poppet.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
zip.writeZip(jarPath);
const sha1 = createHash("sha1").update(readFileSync(jarPath)).digest("hex");
const release = { id: 22, name: "bewitchment.jar", version: "1.0", sha1, targets: [] };
afterAll(() => rmSync(directory, { recursive: true, force: true }));

beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findModsByExactModId).mockResolvedValue([]);
    vi.mocked(findModBySha1).mockResolvedValue(null);
    vi.mocked(getMod).mockResolvedValue({ id: 12, name: "Bewitchment" } as any);
    vi.mocked(providerVersions).mockResolvedValue([release] as any);
    vi.mocked(downloadModVersion).mockResolvedValue(jarPath);
    vi.mocked(parseJar).mockResolvedValue({ modId: "bewitchment" } as any);
    vi.mocked(inspectJarLoaders).mockResolvedValue(["fabric"]);
    vi.mocked(ingestMod).mockResolvedValue({ status: "ingested", mod: { id: 7, modId: "bewitchment", jarPath } } as any);
});

it("resolves the exact hash, verifies the class, and ingests once", async () => {
    const mod = await resolveModReference({ modId: "bewitchment", sha1, className: "moriyashiine.bewitchment.Poppet" });
    expect(mod.id).toBe(7);
    expect(getMod).toHaveBeenCalledWith(sha1);
    expect(downloadModVersion).toHaveBeenCalledWith(12, release);
    expect(ingestMod).toHaveBeenCalledWith(jarPath, true);
});

it("rejects a hash absent from the modpacks.ch version list", async () => {
    vi.mocked(providerVersions).mockResolvedValue([{ ...release, sha1: "f".repeat(40) }] as any);
    await expect(stageModReference({ modId: "bewitchment", sha1 })).rejects.toThrow("did not identify a file");
    expect(downloadModVersion).not.toHaveBeenCalled();
});

it("rejects downloaded bytes that disagree with the selected hash", async () => {
    const wrong = "f".repeat(40);
    vi.mocked(providerVersions).mockResolvedValue([{ ...release, sha1: wrong }] as any);
    await expect(stageModReference({ modId: "bewitchment", sha1: wrong })).rejects.toThrow("SHA-1 mismatch");
});

it("rejects a hash belonging to another mod ID", async () => {
    vi.mocked(parseJar).mockResolvedValue({ modId: "integration" } as any);
    await expect(stageModReference({ modId: "bewitchment", sha1 })).rejects.toThrow("declares mod ID integration");
});

it("rejects a JAR without the requested class", async () => {
    await expect(stageModReference({ modId: "bewitchment", sha1, className: "missing.Class" }))
        .rejects.toThrow("absent from the resolved JAR");
});

it("checks the requested loader against all declarations in a JAR", async () => {
    await expect(stageModReference({ modId: "bewitchment", sha1, loader: "neoforge" })).rejects.toThrow("requested loader");
    vi.mocked(inspectJarLoaders).mockResolvedValue(["fabric", "neoforge"]);
    expect((await stageModReference({ modId: "bewitchment", sha1, loader: "neoforge" })).jarPath).toBe(jarPath);
});

it("reports ambiguous mod ID searches without selecting the latest release", async () => {
    vi.mocked(searchMods).mockResolvedValue({ mods: [12] } as any);
    vi.mocked(getModsBatch).mockResolvedValue([{ id: 12, name: "Bewitchment", slug: "bewitchment" }] as any);
    vi.mocked(providerVersions).mockResolvedValue([release, { ...release, id: 23, version: "2.0", sha1: "a".repeat(40) }] as any);
    await expect(stageModReference({ modId: "bewitchment" })).rejects.toThrow("Ambiguous mod");
    expect(downloadModVersion).not.toHaveBeenCalled();
});

it("shares simultaneous lookups for the same hash", async () => {
    await Promise.all([stageModReference({ modId: "bewitchment", sha1 }), stageModReference({ modId: "bewitchment", sha1 })]);
    expect(downloadModVersion).toHaveBeenCalledOnce();
});

it("shares ingestion when simultaneous readers need the same new JAR", async () => {
    await Promise.all([resolveModReference({ modId: "bewitchment", sha1 }), resolveModReference({ modId: "bewitchment", sha1 })]);
    expect(ingestMod).toHaveBeenCalledOnce();
});

it("backfills SHA-1 for an older local record", async () => {
    const local = { id: 8, modId: "bewitchment", version: "1.0", loader: "fabric", mcVersion: "1.20.1", sha1: null, jarPath };
    vi.mocked(findModsByExactModId).mockResolvedValue([local] as any);
    const staged = await stageModReference({ modId: "bewitchment", sha1 });
    expect(staged.mod?.id).toBe(8);
    expect(updateMod).toHaveBeenCalledWith(8, { sha1 });
    expect(downloadModVersion).not.toHaveBeenCalled();
});

it("checks current local bytes even when a stored SHA-1 matches", async () => {
    const local = { id: 8, modId: "bewitchment", version: "1.0", loader: "fabric", mcVersion: "1.20.1",
        sha1: "f".repeat(40), jarPath };
    vi.mocked(findModById).mockResolvedValue(local as any);
    await expect(stageModReference({ dbId: 8, sha1: "f".repeat(40) })).rejects.toThrow("SHA-1 does not match");
    expect(updateMod).toHaveBeenCalledWith(8, { sha1 });
});

it("rejects conflicting database and mod IDs", async () => {
    vi.mocked(findModById).mockResolvedValue({ id: 8, modId: "integration", jarPath } as any);
    await expect(stageModReference({ dbId: 8, modId: "bewitchment" })).rejects.toThrow("not bewitchment");
});

it("requires a hash or version hint when local releases are ambiguous", async () => {
    vi.mocked(findModsByExactModId).mockResolvedValue([
        { id: 8, modId: "bewitchment", version: "1.0", loader: "fabric", mcVersion: "1.20.1", sha1, jarPath },
        { id: 9, modId: "bewitchment", version: "2.0", loader: "fabric", mcVersion: "1.20.1", sha1: "a".repeat(40), jarPath },
    ] as any);
    await expect(stageModReference({ modId: "bewitchment" })).rejects.toThrow("Ambiguous mod");
    expect((await stageModReference({ modId: "bewitchment", modVersion: "1.0" })).mod?.id).toBe(8);
});
