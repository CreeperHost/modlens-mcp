import { afterEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { licenseTemplates } from "./license-templates.js";
import { decideLicense, identifyLicense, inspectModLicense, licenseFetch, permittedOptions, type LicenseEvidence } from "./mod-license.js";

const mit = licenseTemplates.MIT.text.replace(/<year>/g, "2026").replace(/<copyright holders>/g, "Fixture Author");
const zero = licenseTemplates["0BSD"].text.replace(/<year>/g, "2026").replace(/<owner>/g, "Fixture Author");
const evidence = (origin: LicenseEvidence["origin"], expression: string, licenseText = mit, applicable = true): LicenseEvidence => ({
    origin, expression, applicable, location: "fixture", documents: [{ name: "LICENSE", licenseText }],
});
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function jar(files: Record<string, string | Buffer>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "modlens-license-")); roots.push(root);
    const zip = new AdmZip();
    for (const [name, contents] of Object.entries(files)) zip.addFile(name, typeof contents === "string" ? Buffer.from(contents) : contents);
    const file = join(root, "fixture.jar"); await writeFile(file, zip.toBuffer()); return file;
}

describe("license decisions", () => {
    it("allows NC-SA for this noncommercial service with complete attribution and no opt-in", () => {
        const e = evidence("github", "CC-BY-NC-SA-4.0", licenseTemplates["CC-BY-NC-SA-4.0"].text);
        const author = evidence("jar", "CC-BY-NC-SA-4.0", "Snownee; TehNut, ProfMobius, kalkafox"); author.documents[0].name = "ATTRIBUTION";
        const allowed = decideLicense("a", "b", [e, author], "2026-09-22");
        expect(allowed).toMatchObject({ disposition: "hosted_allowed", selectedLicense: "CC-BY-NC-SA-4.0",
            conditions: { noncommercialOnly: true, shareAlike: true, outputLicense: "CC-BY-NC-SA-4.0", attribution: [author.documents[0].licenseText] } });
        expect(decideLicense("a", "b", [e], "now").disposition).toBe("local_only");
    });
    it("requires both LGPL/GPL texts and corresponding source, then preserves downstream rights", () => {
        const e = evidence("github", "LGPL-3.0-only", licenseTemplates["LGPL-3.0-only"].text);
        e.documents.push({ name: "ATTRIBUTION", licenseText: "Library Authors" });
        expect(decideLicense("a", "b", [e]).disposition).toBe("local_only");
        e.documents.push({ name: "COPYING", licenseText: licenseTemplates["GPL-3.0-only"].text });
        expect(decideLicense("a", "b", [e]).disposition).toBe("local_only");
        e.sourceArchive = `https://github.com/owner/library/archive/${"a".repeat(40)}.zip`;
        expect(decideLicense("a", "b", [e])).toMatchObject({ disposition: "hosted_allowed", selectedLicense: "LGPL-3.0-only",
            conditions: { sourceArchive: e.sourceArchive, shareAlike: true, noncommercialOnly: false } });
        expect(decideLicense("a", "b", [e]).conditions?.downstreamRights).toContain("redistribution");
    });
    it("does not accept modified CC or GNU terms while recognising split LGPL notices", () => {
        for (const id of ["CC-BY-NC-SA-4.0", "GPL-3.0-only", "LGPL-3.0-only"]) {
            expect(identifyLicense(licenseTemplates[id].text)).toBe(id);
            expect(identifyLicense(licenseTemplates[id].text + "\nNo hosted source access is permitted.")).toBeUndefined();
        }
        expect(identifyLicense(licenseTemplates["LGPL-3.0-only"].text.split("GNU GENERAL PUBLIC LICENSE")[0])).toBe("LGPL-3.0-only");
    });
    it("recognizes complete standard text, not a mention or modified license", () => {
        expect(identifyLicense(mit)).toBe("MIT");
        expect(identifyLicense(zero)).toBe("0BSD");
        expect(identifyLicense("This dependency uses MIT. Our mod is all rights reserved.")).toBeUndefined();
        expect(identifyLicense(`${mit}\nYou may not redistribute this software.`)).toBeUndefined();
        expect(identifyLicense(mit.replace("MIT License", "MIT License, private use only"))).toBeUndefined();
        expect(identifyLicense(mit.replace("Fixture Author", "Fixture Author. No redistribution permitted"))).toBeUndefined();
    });
    it("handles explicit alternatives without weakening combined obligations", () => {
        expect(permittedOptions("GPL-3.0-only OR MIT")).toEqual(["MIT"]);
        expect(permittedOptions("(MIT OR 0BSD) AND MIT")).toEqual(["MIT"]);
        for (const value of ["MIT AND GPL-3.0-only", "MIT WITH custom-exception", "MIT; anything", "(MIT OR)", "MIT OR", "MIT AND BSD-3-Clause"]) {
            expect(permittedOptions(value), value).toEqual([]);
        }
    });
    it("recognizes the standard short BSD title without ignoring added restrictions", () => {
        const bsd = "BSD 3-Clause License\n\n" + licenseTemplates["BSD-3-Clause"].text
            .replace(/<year>/g, "2023").replace(/<owner>/g, "Fixture Author");
        expect(identifyLicense(bsd)).toBe("BSD-3-Clause");
        expect(decideLicense("a", "b", [evidence("jar", "BSD-3-Clause", bsd)]).disposition).toBe("hosted_allowed");
        expect(identifyLicense(bsd.replace("BSD 3-Clause License", "BSD 3-Clause License, private use only"))).toBeUndefined();
        expect(identifyLicense(bsd + "\nNo decompilation permitted.")).toBeUndefined();
        expect(identifyLicense(bsd.replace("Redistribution and use", "Redistribution but not use"))).toBeUndefined();
    });
    it("chooses the least restrictive supported explicit alternative", () => {
        const entry = evidence("jar", "MIT OR 0BSD"); entry.documents.push({ name: "LICENSE-0BSD", licenseText: zero });
        expect(decideLicense("sha1", "sha256", [entry]).selectedLicense).toBe("0BSD");
    });
    it("uses GitHub, then JAR, then CurseForge even when lower evidence is more permissive", () => {
        const gh = evidence("github", "GPL-3.0-only", "GPL license");
        const embedded = evidence("jar", "MIT");
        const cf = evidence("curseforge", "0BSD", zero);
        expect(decideLicense("a", "b", [cf, embedded, gh])).toMatchObject({ disposition: "local_only", selectedOrigin: "github" });
        expect(decideLicense("a", "b", [cf, embedded])).toMatchObject({ disposition: "hosted_allowed", selectedOrigin: "jar", selectedLicense: "MIT" });
        expect(decideLicense("a", "b", [cf])).toMatchObject({ disposition: "hosted_allowed", selectedOrigin: "curseforge", selectedLicense: "0BSD" });
        expect(decideLicense("a", "b", [evidence("github", "MIT"), evidence("jar", "All Rights Reserved", "All Rights Reserved")])).toMatchObject({ disposition: "hosted_allowed", selectedOrigin: "github" });
    });
    it("does not use current/unrelated GitHub evidence to override the artifact", () => {
        expect(decideLicense("a", "b", [evidence("github", "MIT", mit, false), evidence("jar", "All Rights Reserved", "All Rights Reserved")])).toMatchObject({ disposition: "local_only", selectedOrigin: "jar" });
    });
    it("uses matching current upstream notices while retaining the JAR's grant and attribution", () => {
        const embedded = evidence("jar", "MIT");
        embedded.documents = [{ name: "ATTRIBUTION", licenseText: "Artifact Author" }];
        const current = evidence("github", "MIT", mit, false);
        const decision = decideLicense("a", "b", [current, embedded]);
        expect(decision).toMatchObject({ disposition: "hosted_allowed", selectedOrigin: "jar", selectedLicense: "MIT" });
        expect(decision.notices).toContainEqual(current.documents[0]);
        expect(decision.notices).toContainEqual(embedded.documents[0]);
    });
    it("rejects mismatched or modified current notices for a JAR declaration", () => {
        const embedded = evidence("jar", "MIT"); embedded.documents = [];
        for (const current of [
            evidence("github", "0BSD", zero, false),
            evidence("github", "MIT", mit + "\nNo hosted source access is permitted.", false),
            { ...evidence("github", "MIT", mit, false), note: "REVIEW: conflicting upstream terms" },
        ]) {
            expect(decideLicense("a", "b", [current, embedded])).toMatchObject({ disposition: "local_only", selectedOrigin: "jar" });
        }
    });
    it("requires full notices; retains lower-tier attribution when GitHub wins", () => {
        expect(decideLicense("a", "b", [evidence("jar", "MIT", "MIT")]).disposition).toBe("local_only");
        const embedded = evidence("jar", "MIT"); embedded.documents.push({ name: "NOTICE", licenseText: "Additional author attribution" });
        expect(decideLicense("a", "b", [evidence("github", "MIT"), embedded]).notices).toContainEqual({ name: "NOTICE", licenseText: "Additional author attribution" });
        expect(decideLicense("a", "b", [evidence("jar", "MIT", licenseTemplates.MIT.text)]).disposition).toBe("local_only");
    });
    it("does not treat a dependency notice as the mod license", () => {
        const e = evidence("jar", "MIT"); e.documents[0].name = "NOTICE";
        expect(decideLicense("a", "b", [e]).disposition).toBe("local_only");
    });
    it("requires review for custom terms, copyleft, and conflicting declarations", () => {
        for (const expression of ["GPL-3.0-only", "MPL-2.0", "custom", "All Rights Reserved", ""]) {
            expect(decideLicense("a", "b", [evidence("jar", expression, "custom terms")]).disposition).toBe("local_only");
        }
        expect(decideLicense("a", "b", [evidence("github", "MIT"), evidence("github", "GPL-3.0-only", "GPL")]).disposition).toBe("local_only");
    });
});

describe("artifact and repository evidence", () => {
    it("uses a declared specification release version, never an arbitrarily stripped suffix", async () => {
        const path = await jar({ "META-INF/MANIFEST.MF": "Implementation-Version: 15.49.0.193\nSpecification-Version: 15.49.0\n", "META-INF/mods.toml": 'license="The MIT License (MIT)"\nissueTrackerURL="https://github.com/mezz/JustEnoughItems/issues?q=is%3Aissue"\n[[mods]]\nmodId="jei"\nversion="15.49.0.193"' });
        const commit = "c".repeat(40);
        const fetcher = vi.fn(async (url: string) => {
            if (url.endsWith("/git/ref/tags/v15.49.0")) return { object: { type: "commit", sha: commit } };
            if (url.endsWith(`/license?ref=${commit}`)) return { path: "LICENSE.txt", encoding: "base64", content: Buffer.from(mit).toString("base64"), license: { spdx_id: "MIT" } };
            if (url.endsWith(`/contents?ref=${commit}`)) return [{ type: "file", name: "LICENSE.txt" }];
            return null;
        });
        expect(await inspectModLicense(path, {}, fetcher)).toMatchObject({ disposition: "hosted_allowed", selectedOrigin: "github" });
    });
    it("clears independently licensed nested dependencies and keeps their notices", async () => {
        const grandchild = new AdmZip(); grandchild.addFile("LICENSE_MixinExtras", Buffer.from(mit));
        const child = new AdmZip();
        child.addFile("LICENSE_MixinExtras", Buffer.from(mit));
        child.addFile("META-INF/mods.toml", Buffer.from('license="MIT"\n[[mods]]\nmodId="mixinextras"\nversion="0.3.5"'));
        child.addFile("META-INF/jars/MixinExtras-0.3.5.jar", grandchild.toBuffer());
        const path = await jar({ "LICENSE": mit, "META-INF/jarjar/child.jar": child.toBuffer(), "licenses/other.txt": mit });
        const result = await inspectModLicense(path, {}, async () => null);
        expect(result.disposition).toBe("hosted_allowed");
        expect(result.notices.filter(n => n.name.endsWith("/LICENSE_MixinExtras"))).toHaveLength(2);
        child.addFile("LICENSE_MixinExtras", Buffer.from("All rights reserved"));
        const restricted = await jar({ "LICENSE": mit, "META-INF/jarjar/child.jar": child.toBuffer() });
        expect((await inspectModLicense(restricted, {}, async () => null)).disposition).toBe("local_only");
    });
    it("uses Modrinth solely for verified hash identity and source discovery", async () => {
        const path = await jar({ "LICENSE": "All rights reserved" });
        const fetcher = vi.fn(async (url: string) => {
            if (url.includes("/version_file/")) return { project_id: "project", files: [{ hashes: { sha1: "wrong-hash" } }] };
            return null;
        });
        const result = await inspectModLicense(path, {}, fetcher);
        expect(result.disposition).toBe("local_only");
        expect(fetcher.mock.calls.some(([url]) => url.includes("/v2/project/"))).toBe(false);
    });
    it("recognizes JEI's embedded MIT alias without weakening modified declarations", async () => {
        const path = await jar({ "META-INF/mods.toml": 'license="The MIT License (MIT)"\n[[mods]]\nmodId="jei"\nversion="15.49.0.193"', "LICENSE.txt": mit });
        expect(await inspectModLicense(path, {}, async () => null)).toMatchObject({ disposition: "hosted_allowed", selectedLicense: "MIT" });
        expect(decideLicense("a", "b", [evidence("jar", "The MIT License (MIT), noncommercial only")]).disposition).toBe("local_only");
    });
    it("resolves Jade-style loader release tags from the manifest version", async () => {
        const path = await jar({
            "META-INF/neoforge.mods.toml": 'license="CC-BY-NC-SA-4.0"\n[[mods]]\nmodId="jade"\nversion="${file.jarVersion}"',
            "META-INF/MANIFEST.MF": "Implementation-Version: 15.10.5+neoforge\r\n",
        });
        const commit = "b".repeat(40);
        const fetcher = vi.fn(async (url: string) => {
            if (url.endsWith("/git/ref/tags/neoforge-15.10.5")) return { object: { type: "commit", sha: commit } };
            if (url.endsWith(`/license?ref=${commit}`)) return { path: "LICENSE.md", encoding: "base64", content: Buffer.from("CC terms fixture").toString("base64"), license: { spdx_id: "CC-BY-NC-SA-4.0" } };
            if (url.endsWith(`/contents?ref=${commit}`)) return [{ type: "file", name: "LICENSE.md" }];
            return null;
        });
        const result = await inspectModLicense(path, { sourceUrl: "https://github.com/Snownee/Jade" }, fetcher);
        expect(result.evidence.find(e => e.origin === "github")).toMatchObject({ applicable: true, expression: "CC-BY-NC-SA-4.0" });
        expect(result.evidence.find(e => e.origin === "github")?.location).toContain(commit);
        // Retrieval succeeds; this does not pretend the hosting conditions have
        // been implemented merely because the license can now be identified.
        expect(result.disposition).toBe("local_only");
    });
    it("retains Embeddium-style COPYING.LESSER alongside COPYING", async () => {
        const path = await jar({ "COPYING": "GPL terms fixture", "COPYING.LESSER": "LGPL terms fixture" });
        const result = await inspectModLicense(path, {}, async () => null);
        expect(result.evidence[0].documents.map(d => d.name)).toEqual(expect.arrayContaining(["COPYING", "COPYING.LESSER"]));
    });
    it("looks up the actual JAR SHA-1 and resolves the exact version tag before GitHub licensing", async () => {
        const path = await jar({ "LICENSE": "All Rights Reserved", "fabric.mod.json": JSON.stringify({ version: "1.2.3", license: "All Rights Reserved" }) });
        const commit = "a".repeat(40);
        const fetcher = vi.fn(async (url: string) => {
            if (url.includes("api.modpacks.ch")) return { links: [{ type: "github", link: "https://github.com/fixture/mod" }] };
            if (url.endsWith("/git/ref/tags/1.2.3")) return null;
            if (url.endsWith("/git/ref/tags/v1.2.3")) return { object: { type: "commit", sha: commit } };
            if (url.endsWith(`/license?ref=${commit}`)) return { path: "LICENSE", encoding: "base64", content: Buffer.from(mit).toString("base64"), license: { spdx_id: "MIT" } };
            if (url.endsWith(`/contents?ref=${commit}`)) return [{ type: "file", name: "LICENSE" }];
            return null;
        });
        const result = await inspectModLicense(path, {}, fetcher);
        expect(fetcher).toHaveBeenCalledWith(`https://api.modpacks.ch/public/mod/${result.sha1}`);
        expect(result).toMatchObject({ disposition: "hosted_allowed", selectedOrigin: "github", selectedLicense: "MIT" });
        expect(result.evidence.find(e => e.origin === "github")?.location).toContain(commit);
    });
    it("extracts Fabric/Forge declarations and never assigns shaded dependency licensing to the mod", async () => {
        const forge = await jar({ "META-INF/mods.toml": 'license="MIT"\n[[mods]]\nmodId="fixture"\nversion="1.0.0"', "META-INF/LICENSE": mit });
        expect((await inspectModLicense(forge, {}, async () => null)).disposition).toBe("hosted_allowed");
        const dependency = await jar({ "META-INF/licenses/dependency.txt": mit });
        expect((await inspectModLicense(dependency, {}, async () => null)).disposition).toBe("local_only");
        const nested = await jar({ "LICENSE": mit, "META-INF/jars/dependency.jar": "fake" });
        expect((await inspectModLicense(nested, {}, async () => null)).disposition).toBe("local_only");
    });
    it("does not fall through a failed higher-priority GitHub lookup", async () => {
        const path = await jar({ "LICENSE": mit, "fabric.mod.json": JSON.stringify({ version: "1.0.0", license: "MIT", contact: { sources: "https://github.com/fixture/mod" } }) });
        const result = await inspectModLicense(path, {}, async url => { if (url.includes("github")) throw new Error("rate limited"); return null; });
        expect(result).toMatchObject({ disposition: "local_only", selectedOrigin: "github" });
    });
    it("rejects arbitrary linked hosts and does not fetch unpinned current-branch licensing", async () => {
        const path = await jar({ "LICENSE": mit });
        const fetcher = vi.fn(async () => null);
        const result = await inspectModLicense(path, { sourceUrl: "http://127.0.0.1/private" }, fetcher);
        expect(result.disposition).toBe("hosted_allowed");
        expect(fetcher.mock.calls.every(([url]) => url.startsWith("https://api.modpacks.ch/") || url.startsWith("https://api.modrinth.com/"))).toBe(true);
        const unpinned = await inspectModLicense(path, { sourceUrl: "https://github.com/fixture/mod" }, fetcher);
        expect(unpinned.evidence.find(e => e.origin === "github")).toMatchObject({ applicable: false });
    });
});

describe("license evidence transport", () => {
    it("uses a real archive layout on API quota failure and rejects a mismatched pinned commit", async () => {
        const commit = "d".repeat(40);
        const path = await jar({ "fabric.mod.json": JSON.stringify({ version: "1.0.0", license: "MIT" }) });
        const archive = new AdmZip();
        archive.addFile("mod-release/LICENSE", Buffer.from(mit));
        archive.addZipComment(commit);
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url.startsWith("https://api.github.com/")) return new Response("quota", { status: 429 });
            if (url.startsWith("https://codeload.github.com/")) return new Response(new Uint8Array(archive.toBuffer()));
            return new Response(null, { status: 404 });
        }));
        const sourceUrl = `https://github.com/fixture/mod/tree/${commit}`;
        const result = await inspectModLicense(path, { sourceUrl });
        expect(result).toMatchObject({ disposition: "hosted_allowed", selectedOrigin: "github", selectedLicense: "MIT" });
        expect(result.evidence.find(e => e.origin === "github")?.location).toContain(commit);
        archive.addZipComment("e".repeat(40));
        expect((await inspectModLicense(path, { sourceUrl })).disposition).toBe("local_only");
    });
    it("follows renamed GitHub repositories but rejects cross-host redirects", async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/123/license" } }))
            .mockResolvedValueOnce(new Response('{"license":{"spdx_id":"MIT"}}'));
        vi.stubGlobal("fetch", fetcher);
        expect(await licenseFetch("https://api.github.com/repos/old/mod/license")).toMatchObject({ license: { spdx_id: "MIT" } });
        expect(String(fetcher.mock.calls[1][0])).toBe("https://api.github.com/repositories/123/license");
        fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://untrusted.example/license" } }));
        await expect(licenseFetch("https://api.github.com/repos/old/mod/license")).rejects.toThrow("Unsupported license evidence redirect");
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it("does not mistake an HTTP-200 hash lookup error for project evidence", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"status":"error","message":"Unable to find mod with this checksum"}')));
        await expect(licenseFetch(`https://api.modpacks.ch/public/mod/${"a".repeat(40)}`)).rejects.toThrow("did not resolve");
    });
});
