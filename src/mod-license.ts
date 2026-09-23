import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { licenseTemplates } from "./license-templates.js";
import { USER_AGENT } from "./modpacks-ch.js";
import { reviewedSourceReferences } from "./license-source-references.js";

export type LicenseOrigin = "github" | "jar" | "curseforge";
export interface LicenseEvidence {
    origin: LicenseOrigin;
    location: string;
    applicable: boolean;
    expression?: string;
    documents: Array<{ name: string; licenseText: string }>;
    note?: string;
    sourceArchive?: string;
}
export interface LicenseConditions {
    licenseUrl: string;
    outputLicense: string;
    noncommercialOnly: boolean;
    shareAlike: boolean;
    sourceArchive?: string;
    attribution: string[];
    downstreamRights: string;
}
export interface LicenseDecision {
    sha1: string;
    sha256: string;
    disposition: "hosted_allowed" | "local_only";
    selectedLicense?: string;
    selectedOrigin?: LicenseOrigin;
    reason: string;
    evidence: LicenseEvidence[];
    notices: Array<{ name: string; licenseText: string }>;
    checkedAt: string;
    sourceUrl?: string;
    conditions?: LicenseConditions;
}

// Prefer simpler obligations among explicit alternatives. Conditional licences
// must also satisfy their purpose, attribution and source-offer requirements.
const permissive = ["0BSD", "Unlicense", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"];
const supported = [...permissive, "LGPL-3.0-only", "CC-BY-NC-SA-4.0"];
const normalize = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const expressionName = (value: unknown): string | undefined => typeof value === "string"
    ? (/^(?:The )?MIT License \(MIT\)$/i.test(value.trim()) ? "MIT" :
        supported.find(id => normalize(value) === normalize(licenseTemplates[id].name) || normalize(value) === normalize(id)) ?? value)
    : undefined;
function body(text: string): string {
    // Copyright and title lines are variable SPDX fields; preserve them in output.
    // Only exact standard titles are removable: "MIT License, private use only"
    // must not accidentally become a match for the standard grant beneath it.
    const titles = new Set([...Object.values(licenseTemplates).map(t => normalize(t.name)), normalize("The MIT License (MIT)"), normalize("MIT License (MIT)"), normalize("BSD 3-Clause License")]);
    return normalize(text.replace(/\[([^\]]+)\]\((?:https?:\/\/[^\s)]+|#[^\s)]*)\)/g, "$1")
        // These GNU document URL variants have identical legal text.
        .replace(/https?:\/\/(?:www\.)?(?:gnu\.org|fsf\.org)\//g, "https://gnu.org/")
        .replace(/gnu\.org\/licenses\/why-not-lgpl/g, "gnu.org/philosophy/why-not-lgpl")
        .split(/\r\n|\n|\r/).filter(line => {
        if (titles.has(normalize(line))) return false;
        if (/^\s*Copyright\s+(?:\([cC]\)\s*)?(?:©\s*)?(?:\d{4}|<year>|YEAR\b|\[year\])/i.test(line) && !/\b(?:only|unless|except|prohibit\w*|restrict\w*|noncommercial|private|internal|decompil\w*|permission|redistribut\w*)\b/i.test(line)) return false;
        return true;
    }).join("\n"));
}
export function identifyLicense(text: string): string | undefined {
    const normalized = body(text);
    return Object.keys(licenseTemplates).find(id => {
        const template = licenseTemplates[id].text;
        // SPDX supplies LGPL plus the incorporated GPL in one document;
        // upstreams commonly ship them separately as COPYING.LESSER/COPYING.
        const lesser = id === "LGPL-3.0-only" ? template.split("GNU GENERAL PUBLIC LICENSE")[0] : undefined;
        // CC's Markdown rendering can renumber the final definition labels;
        // compare every word of each definition, ignoring only those labels.
        const ccDefinitions = (value: string) => value.replace(/^\s*[a-n]\.\s*(?=(?:__)?(?:Licensor|NonCommercial|Share|Sui Generis Database Rights|You)(?:__)? means)/gm, "");
        return body(template) === normalized || (lesser !== undefined && body(lesser) === normalized)
            || (id === "CC-BY-NC-SA-4.0" && body(ccDefinitions(template)) === body(ccDefinitions(text)));
    });
}

/** Small strict SPDX-expression reader: AND requires every obligation; OR offers a choice. */
export function permittedOptions(expression: string): string[] {
    const tokens = expression.match(/[A-Za-z0-9.+-]+|[()]/g) ?? [];
    if (tokens.join("") !== expression.replace(/\s/g, "") || tokens.length > 100) return [];
    let offset = 0;
    function term(): string[][] {
        if (tokens[offset] === "(") { offset++; const result = or(); if (tokens[offset++] !== ")") throw new Error(); return result; }
        const id = tokens[offset++];
        if (!id || ["AND", "OR", "WITH", ")"].includes(id)) throw new Error();
        return [[id]];
    }
    function and(): string[][] {
        let options = term();
        while (tokens[offset] === "AND") {
            offset++; const rhs = term();
            options = options.flatMap(a => rhs.map(b => [...a, ...b]));
            if (options.length > 100) throw new Error();
        }
        return options;
    }
    function or(): string[][] {
        let options = and();
        while (tokens[offset] === "OR") { offset++; options = [...options, ...and()]; }
        return options;
    }
    try {
        const options = or();
        if (offset !== tokens.length) return [];
        // Multiple distinct AND obligations are left for review; never weaken AND to OR.
        return [...new Set(options.filter(ids => ids.every(id => id === ids[0]) && supported.includes(ids[0])).map(ids => ids[0]))]
            .sort((a, b) => supported.indexOf(a) - supported.indexOf(b));
    } catch { return []; }
}

// The hosted service is operated for noncommercial mod development. Carry NC
// conditions through to recipients without requiring another operator opt-in.
export function decideLicense(sha1: string, sha256: string, evidence: LicenseEvidence[], checkedAt = new Date().toISOString()): LicenseDecision {
    const base: LicenseDecision = { sha1, sha256, disposition: "local_only", reason: "No applicable license with clear hosted-source permission and complete notices was found.", evidence, notices: [], checkedAt };
    const tier = (["github", "jar", "curseforge"] as const).find(origin => evidence.some(e => e.origin === origin && e.applicable));
    if (!tier) return base;
    const winners = evidence.filter(e => e.origin === tier && e.applicable);
    const corroborating = tier === "jar" ? evidence.filter(e => e.origin === "github" && !e.applicable && e.expression
        && permissive.includes(e.expression) && winners.some(w => expressionName(w.expression) === e.expression)
        && !e.note?.startsWith("REVIEW:")) : [];
    // The artifact's declaration supplies the grant. Matching upstream text can
    // supply its notices without making a current branch a historical grant.
    const documents = [...winners, ...corroborating].flatMap(e => e.documents);
    const declared = winners.map(e => expressionName(e.expression)).filter((e): e is string => !!e);
    const licenseDocuments = documents.filter(d => licenseFile.test(d.name) && !/(?:^|\/)NOTICE(?:\.|$)/i.test(d.name)
        && (declared.length > 0 || !/(?:^|\/)LICENSE[-_][\w-]+$/i.test(d.name) || /(?:^|\/)LICENSE[-_](?:MIT|APACHE|BSD|ISC|0BSD)$/i.test(d.name)));
    const recognized = licenseDocuments.map(d => identifyLicense(d.licenseText)).filter((id): id is string => !!id);
    const expressions = declared.length ? declared : recognized;
    base.selectedOrigin = tier;
    if (winners.some(e => e.note?.startsWith("REVIEW:"))) { base.reason = `The ${tier} evidence requires review; lower-priority sources cannot override it.`; return base; }
    // Conflicting declarations at the same tier are not an explicit dual-license offer.
    if (new Set(expressions).size > 1) { base.reason = `Multiple ${tier} licenses lack a single explicit alternative-license expression.`; return base; }
    const options = permittedOptions(expressions[0] ?? "");
    if (documents.some(d => /^(?:META-INF\/)?licenses\//i.test(d.name) && !permissive.includes(identifyLicense(d.licenseText) ?? ""))) {
        base.reason = "A separately licensed component has additional or unrecognised conditions requiring review."; return base;
    }
    for (const id of options) {
        const matched = licenseDocuments.find(d => identifyLicense(d.licenseText) === id);
        if (!matched) continue;
        const conditional = id === "LGPL-3.0-only" || id === "CC-BY-NC-SA-4.0";
        if (!conditional && !["0BSD", "Unlicense", "Apache-2.0"].includes(id) && !/copyright[^\n]*(?:\d{4}|©|\(c\))/i.test(matched.licenseText)) continue;
        // Do not replace absent author-specific notices with a generic template.
        if (!conditional && id !== "0BSD" && /<(?:year|owner|copyright holders)>|\[(?:year|fullname|name of copyright owner)\]/i.test(matched.licenseText)) continue;
        const allDocuments = [...documents, ...evidence.filter(e => e.origin === "jar").flatMap(e => e.documents)]
            .filter((d, i, all) => all.findIndex(other => other.licenseText === d.licenseText) === i);
        const attribution = allDocuments.filter(d => /(?:^|\/)(?:NOTICE|ATTRIBUTION)(?:\.|$)/i.test(d.name)).map(d => d.licenseText);
        const sourceArchive = winners.find(e => e.sourceArchive)?.sourceArchive;
        if (conditional && !attribution.length) { base.reason = `${id} requires the author's attribution information.`; continue; }
        if (id === "LGPL-3.0-only" && (!sourceArchive || !allDocuments.some(d => identifyLicense(d.licenseText) === "GPL-3.0-only"))) {
            return { ...base, selectedLicense: id, reason: "LGPL source access requires both GPL/LGPL notices and an artifact-matched complete corresponding-source offer." };
        }
        return { ...base, disposition: "hosted_allowed", selectedLicense: id,
            reason: `Selected ${id} from ${tier}; retain the supplied license/attribution notices and identify decompiled output.`,
            conditions: {
                licenseUrl: id === "CC-BY-NC-SA-4.0" ? "https://creativecommons.org/licenses/by-nc-sa/4.0/" : `https://spdx.org/licenses/${id}.html`,
                outputLicense: id, noncommercialOnly: id === "CC-BY-NC-SA-4.0", shareAlike: conditional, sourceArchive, attribution,
                downstreamRights: "Recipients retain all rights granted by the applicable licences. Service access limits do not restrict copying, modification or redistribution allowed by those licences.",
            }, notices: allDocuments };
    }
    base.reason = `The highest-priority applicable evidence (${tier}) has unsupported terms or incomplete license/attribution notices. Local consent is required.`;
    return base;
}

const licenseFile = /^(?:(?:META-INF)\/)?(?:LICENSE(?:[-_][\w.-]+|\.2\.0)?|LICENCE|COPYING(?:\.LESSER)?|NOTICE)(?:\.(?:txt|md))?$/i;
const MAX_DOCUMENT = 64 * 1024;
function jarEvidence(bytes: Buffer, artifactName?: string): { evidence: LicenseEvidence; sources: string[]; version?: string; specificationVersion?: string; nested: Array<{ name: string; bytes: Buffer }>; uncertainScope: boolean } {
    const zip = new AdmZip(bytes);
    const documents: LicenseEvidence["documents"] = [];
    let total = 0;
    for (const entry of zip.getEntries().filter(e => !e.isDirectory && (licenseFile.test(e.entryName) || /^(?:META-INF\/)?licenses\/[^/]+\.(?:txt|md)$/i.test(e.entryName)))) {
        total += entry.header.size;
        if (entry.header.size > MAX_DOCUMENT || total > 128 * 1024 || documents.length >= 12) throw new Error("License notices exceed review limit");
        documents.push({ name: entry.entryName, licenseText: entry.getData().toString("utf8") });
    }
    const read = (name: string) => {
        const e = zip.getEntry(name);
        if (!e) return undefined;
        if (e.header.size > MAX_DOCUMENT) throw new Error("Oversized mod manifest");
        return e.getData().toString("utf8");
    };
    const sources: string[] = [], declarations: string[] = [];
    const attribution: string[] = [];
    const attribute = (value: unknown) => { if (value) attribution.push(typeof value === "string" ? value : JSON.stringify(value)); };
    let version: string | undefined;
    const add = (license: unknown, source: unknown, v: unknown) => {
        // An array does not itself specify AND/OR: preserve ambiguity for review.
        if (typeof license === "string") declarations.push(expressionName(license)!);
        else if (Array.isArray(license)) declarations.push(...license.filter((l): l is string => typeof l === "string"));
        if (typeof source === "string") sources.push(source);
        if (typeof v === "string") version ??= v;
    };
    const fabric = read("fabric.mod.json");
    if (fabric) { const m = JSON.parse(fabric); add(m.license, m.contact?.sources, m.version); attribute(m.name); attribute(m.authors); attribute(m.contributors); }
    const quilt = read("quilt.mod.json");
    if (quilt) { const m = JSON.parse(quilt).quilt_loader; add(m?.metadata?.license, m?.metadata?.contact?.sources, m?.version); attribute(m?.metadata?.name); attribute(m?.metadata?.contributors); }
    for (const file of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
        const toml = read(file);
        if (toml) { const m = parseToml(toml) as any; add(m.license, m.issueTrackerURL?.replace(/\/issues(?:\/?(?:\?.*)?)?$/, ""), m.mods?.[0]?.version);
            for (const mod of m.mods ?? []) { attribute(mod.displayName); attribute(mod.authors); attribute(mod.credits); attribute(mod.displayURL); }
        }
    }
    const manifest = read("META-INF/MANIFEST.MF")?.replace(/\r?\n /g, "");
    if (manifest) {
        version = version === "${file.jarVersion}" || !version ? manifest.match(/^Implementation-Version:\s*(.+)$/im)?.[1]?.trim() : version;
        const scm = manifest.match(/^(?:Implementation-URL|Source-URL):\s*(.+)$/im)?.[1];
        if (scm) sources.push(scm.trim());
    }
    if (attribution.length) documents.push({ name: "ATTRIBUTION", licenseText: [...new Set(attribution)].join("\n") });
    // A library may carry LICENSE_LibraryName without a mod-loader manifest.
    // Accept that as its own licence only when the nested artifact name agrees;
    // unrelated suffixed dependency notices cannot license an unknown parent.
    if (!declarations.length && artifactName) for (const document of documents) {
        const owner = document.name.match(/^LICENSE[-_]([\w-]+?)(?:\.(?:txt|md))?$/i)?.[1];
        const filename = artifactName.split("/").at(-1)!;
        if (owner && filename.toLowerCase().startsWith(`${owner.toLowerCase()}-`)) {
            const id = identifyLicense(document.licenseText); if (id) declarations.push(id);
        }
    }
    const unique = [...new Set(declarations)];
    const nestedEntries = zip.getEntries().filter(e => /^META-INF\/(?:jars|jarjar)\/.*\.jar$/i.test(e.entryName));
    if (nestedEntries.length > 128 || nestedEntries.reduce((n, e) => n + e.header.size, 0) > 32 * 1024 * 1024) throw new Error("Bundled dependency review limit exceeded");
    const uncertainScope = documents.some(d => /^(?:META-INF\/)?licenses\//i.test(d.name) && !permissive.includes(identifyLicense(d.licenseText) ?? ""));
    return { evidence: { origin: "jar", location: "mod JAR", applicable: !!(documents.length || unique.length), documents,
        expression: unique.length === 1 ? unique[0] : undefined,
        ...(unique.length > 1 ? { note: "REVIEW: Conflicting embedded license declarations." } : {}) }, sources, version,
        specificationVersion: manifest?.match(/^Specification-Version:\s*(.+)$/im)?.[1]?.trim(),
        nested: nestedEntries.map(e => ({ name: e.entryName, bytes: e.getData() })), uncertainScope };
}

function bundledNotices(children: ReturnType<typeof jarEvidence>["nested"], depth = 0, budget = { count: 0, bytes: 0 }): LicenseDecision["notices"] {
    const notices: LicenseDecision["notices"] = [];
    for (const { name, bytes } of children) {
        budget.bytes += bytes.length;
        if (depth >= 4 || ++budget.count > 256 || budget.bytes > 64 * 1024 * 1024) throw new Error("Bundled dependency review limit exceeded");
        const nested = jarEvidence(bytes, name);
        const child = decideLicense(createHash("sha1").update(bytes).digest("hex"), createHash("sha256").update(bytes).digest("hex"), [nested.evidence]);
        if (child.disposition !== "hosted_allowed" || nested.uncertainScope || child.conditions?.shareAlike) throw new Error("Unresolved bundled licence");
        notices.push(...child.notices.map(d => ({ ...d, name: `dependency/${child.sha256}/${d.name}` })), ...bundledNotices(nested.nested, depth + 1, budget));
    }
    return notices;
}

export type JsonFetch = (url: string) => Promise<any | null>;
export async function licenseFetch(url: string): Promise<any | null> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || !["api.github.com", "api.modpacks.ch", "api.modrinth.com", "www.curseforge.com"].includes(parsed.hostname)) throw new Error("Unsupported license evidence host");
    // GitHub redirects renamed repositories to their stable numeric repository
    // endpoint. Follow only same-host HTTPS redirects, never arbitrary locations.
    let response: Response;
    let current = parsed;
    const signal = AbortSignal.timeout(8000);
    for (let redirects = 0; ; redirects++) {
        response = await fetch(current, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (parsed.hostname !== "api.github.com" || !location || redirects >= 3) throw new Error("Unsupported license evidence redirect");
        const target = new URL(location, current);
        if (target.protocol !== "https:" || target.hostname !== parsed.hostname || target.port || target.username || target.password) throw new Error("Unsupported license evidence redirect");
        current = target;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`License evidence unavailable (${response.status})`);
    if (Number(response.headers.get("content-length")) > 4 * 1024 * 1024) throw new Error("Oversized license response");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty license response");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4 * 1024 * 1024) throw new Error("Oversized license response"); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const text = Buffer.concat(chunks).toString("utf8");
    if (parsed.hostname === "www.curseforge.com") return text;
    const data = JSON.parse(text);
    if (parsed.hostname === "api.modpacks.ch" && data?.status === "error") throw new Error("modpacks.ch did not resolve this artifact");
    return data;
}

function githubRepo(url: string): { repository: string; pinned?: string } | undefined {
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" || u.hostname !== "github.com") return;
        const parts = u.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
        if (!parts.slice(0, 2).every(p => /^[\w.-]+$/.test(p)) || parts.length < 2) return;
        return { repository: parts.slice(0, 2).join("/"), pinned: ["tree", "commit"].includes(parts[2]) && /^[a-f0-9]{40}$/i.test(parts[3]) ? parts[3] : undefined };
    } catch { return; }
}

function releaseTags(version?: string, specificationVersion?: string): string[] {
    if (!version || !/^[\w.+-]{1,100}$/.test(version)) return [];
    const loaderVersion = version.match(/^(.+)\+(fabric|forge|neoforge|quilt)$/);
    const release = specificationVersion && version.startsWith(`${specificationVersion}.`) && /^[\w.+-]{1,100}$/.test(specificationVersion) ? specificationVersion : undefined;
    return [...new Set([...(release ? [release, `v${release}`] : []), ...(loaderVersion ? [`${loaderVersion[2]}-${loaderVersion[1]}`] : []), version, `v${version}`, `build-${version}`])];
}

// Public source archives are independent of GitHub's anonymous REST quota.
// The archive's ZIP comment contains the resolved commit; retain that immutable
// identity and inspect only licence files, without extracting or executing code.
async function githubArchiveEvidence(source: string, version?: string, specificationVersion?: string): Promise<LicenseEvidence | undefined> {
    const repo = githubRepo(source);
    if (!repo) return;
    for (const ref of repo.pinned ? [repo.pinned] : [...releaseTags(version, specificationVersion), "HEAD"]) {
        const response = await fetch(`https://codeload.github.com/${repo.repository}/zip/${encodeURIComponent(ref)}`, {
            redirect: "error", signal: AbortSignal.timeout(30_000), headers: { "User-Agent": USER_AGENT },
        });
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`GitHub source archive unavailable (${response.status})`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty GitHub source archive");
        const chunks: Uint8Array[] = []; let total = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length;
            if (total > 32 * 1024 * 1024) throw new Error("GitHub source archive exceeds review limit"); chunks.push(value); } }
        finally { await reader.cancel().catch(() => {}); }
        const zip = new AdmZip(Buffer.concat(chunks));
        const commit = zip.getZipComment().trim();
        if (!/^[a-f0-9]{40}$/.test(commit) || (repo.pinned && commit !== repo.pinned)) throw new Error("Archive commit identity unavailable");
        const documents: LicenseEvidence["documents"] = [];
        let noticeBytes = 0;
        for (const entry of zip.getEntries()) {
            const name = entry.entryName.replace(/^[^/]+\//, "");
            if (entry.isDirectory || !(licenseFile.test(name) || /^licenses\/[\w.-]+\.(?:txt|md)$/i.test(name))) continue;
            noticeBytes += entry.header.size;
            if (entry.header.size > MAX_DOCUMENT || noticeBytes > 128 * 1024 || documents.length >= 12) throw new Error("Archive notices exceed review limit");
            documents.push({ name, licenseText: entry.getData().toString("utf8") });
        }
        const ids = [...new Set(documents.filter(d => licenseFile.test(d.name) && !/^NOTICE/i.test(d.name)).map(d => identifyLicense(d.licenseText)).filter(Boolean))];
        const expression = ids.includes("LGPL-3.0-only") && ids.every(id => ["LGPL-3.0-only", "GPL-3.0-only"].includes(id!)) ? "LGPL-3.0-only" : ids.length === 1 ? ids[0] : undefined;
        return { origin: "github", applicable: ref !== "HEAD", expression, documents,
            location: `https://github.com/${repo.repository}/tree/${commit}`,
            sourceArchive: `https://github.com/${repo.repository}/archive/${commit}.zip`,
            note: ref === "HEAD" ? "Current upstream notices; not a version-specific grant." : `Resolved ${ref} through the public source archive; commit identity read from its ZIP comment.` };
    }
    return undefined;
}

async function githubEvidence(source: string, version: string | undefined, fetcher: JsonFetch, specificationVersion?: string): Promise<LicenseEvidence | undefined> {
    const repo = githubRepo(source);
    if (!repo) return;
    const base = `https://api.github.com/repos/${repo.repository}`;
    let commit = repo.pinned;
    if (!commit && version && /^[\w.+-]{1,100}$/.test(version)) {
        // Some loaders are encoded as SemVer build metadata in the JAR but
        // as a prefix on release tags (e.g. Jade 15.10.5+neoforge).
        // Only use a shorter release version when the artifact declares it;
        // stripping an arbitrary version suffix could select a different release.
        for (const tag of releaseTags(version, specificationVersion)) {
            let ref = await fetcher(`${base}/git/ref/tags/${encodeURIComponent(tag)}`);
            if (!ref) continue;
            if (ref.object?.type === "tag") ref = await fetcher(`${base}/git/tags/${ref.object.sha}`);
            if (ref?.object?.type === "commit" && /^[a-f0-9]{40}$/i.test(ref.object.sha)) { commit = ref.object.sha; break; }
        }
    }
    const applicable = !!commit;
    if (!commit) {
        const latest = await fetcher(`${base}/commits?per_page=1`);
        if (Array.isArray(latest) && /^[a-f0-9]{40}$/i.test(latest[0]?.sha)) commit = latest[0].sha;
    }
    if (!commit) return { origin: "github", location: source, applicable: false, documents: [], note: "No pinned commit or exact version tag; current-branch licensing cannot establish this version's permission." };
    const licensed = await fetcher(`${base}/license?ref=${commit}`);
    // GitHub sometimes recognises COPYING (GPL) instead of COPYING.LESSER.
    // Read the entire root inventory even when its licence classifier fails.
    const documents: LicenseEvidence["documents"] = [];
    if (licensed?.encoding === "base64" && typeof licensed.content === "string") {
        const bytes = Buffer.from(licensed.content, "base64");
        if (bytes.length > MAX_DOCUMENT) throw new Error("Oversized GitHub license");
        documents.push({ name: licensed.path ?? "LICENSE", licenseText: bytes.toString("utf8") });
    }
    // Inventory the version's root notices (including NOTICE.txt/NOTICE.md and
    // explicit alternative license files), not just GitHub's one detected file.
    const listing = await fetcher(`${base}/contents?ref=${commit}`);
    if (!Array.isArray(listing)) throw new Error("GitHub notice inventory unavailable");
    const extra = listing.filter((e: any) => e.type === "file" && typeof e.name === "string" && licenseFile.test(e.name) && !documents.some(d => d.name === e.name));
    for (const directory of listing.filter((e: any) => e.type === "dir" && e.name === "licenses")) {
        const children = await fetcher(`${base}/contents/${directory.name}?ref=${commit}`);
        if (!Array.isArray(children)) throw new Error("GitHub third-party notices unavailable");
        for (const entry of children) if (entry.type === "file" && /^[\w.-]+\.(?:txt|md)$/i.test(entry.name)) extra.push({ name: `licenses/${entry.name}` });
    }
    if (extra.length > 12) throw new Error("Too many GitHub license documents for automatic review");
    for (const entry of extra) {
        const notice = await fetcher(`${base}/contents/${encodeURIComponent(entry.name)}?ref=${commit}`);
        if (notice?.encoding !== "base64" || typeof notice.content !== "string") throw new Error("GitHub license document unavailable");
        const bytes = Buffer.from(notice.content, "base64");
        if (bytes.length > MAX_DOCUMENT) throw new Error("Oversized GitHub notice");
        documents.push({ name: entry.name, licenseText: bytes.toString("utf8") });
    }
    const id = licensed?.license?.spdx_id;
    const rootIds = documents.filter(d => licenseFile.test(d.name)).map(d => identifyLicense(d.licenseText)).filter(Boolean);
    const detected = rootIds.includes("LGPL-3.0-only") && rootIds.every(id => ["LGPL-3.0-only", "GPL-3.0-only"].includes(id!)) ? "LGPL-3.0-only"
        : [...new Set(rootIds)].length === 1 ? rootIds[0] : undefined;
    return { origin: "github", location: `https://github.com/${repo.repository}/tree/${commit}`, applicable,
        ...(!applicable ? { note: "Current upstream notices; not a version-specific grant." } : {}),
        sourceArchive: `https://github.com/${repo.repository}/archive/${commit}.zip`,
        expression: detected ?? (typeof id === "string" && id !== "NOASSERTION" ? id : documents.map(d => d.licenseText.match(/^SPDX-License-Identifier:\s*(.+)$/m)?.[1]).find(Boolean)), documents };
}

export async function inspectModLicense(jarPath: string, hints: { version?: string; sourceUrl?: string } = {}, fetcher: JsonFetch = licenseFetch): Promise<LicenseDecision> {
    const bytes = await readFile(jarPath);
    const sha1 = createHash("sha1").update(bytes).digest("hex"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const jar = jarEvidence(bytes);
    const evidence: LicenseEvidence[] = [jar.evidence];
    const sources = [...jar.sources, ...(hints.sourceUrl ? [hints.sourceUrl] : [])];
    const reviewed = reviewedSourceReferences[sha256];
    if (reviewed && reviewed.version === jar.version) sources.unshift(`https://github.com/${reviewed.repository}/tree/${reviewed.commit}`);
    try {
        const project = await fetcher(`https://api.modpacks.ch/public/mod/${sha1}`);
        if (project) {
            for (const link of project.links ?? []) if (["github", "source"].includes(String(link.type).toLowerCase())) sources.push(link.link);
            const matched = (project.versions ?? []).find((v: any) => v.sha1?.toLowerCase() === sha1);
            const license = matched?.license ?? project.license;
            const expression = expressionName(typeof license === "string" ? license : license?.spdx_id ?? license?.id ?? license?.name);
            const text = typeof license?.text === "string" ? license.text : undefined;
            const page = (project.links ?? []).find((l: any) => l.type === "curseforge")?.link;
            if (expression || text) evidence.push({ origin: "curseforge", location: page ?? `modpacks.ch/mod/${project.id}`,
                applicable: !!matched?.license, expression, documents: text ? [{ name: "platform license", licenseText: text }] : [],
                note: matched?.license ? "License associated with the hash-matched file." : "Current project license; applicability to this file is unconfirmed." });
            if (typeof page === "string" && /^https:\/\/www\.curseforge\.com\/minecraft\/mc-mods\/[\w-]+\/?$/.test(page)) {
                try {
                    const html = await fetcher(page);
                    if (typeof html === "string") {
                        const decoded = html.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/&amp;/g, "&");
                        // Only source-code fields/links, not arbitrary repository
                        // mentions in descriptions (which may refer to dependencies).
                        for (const m of decoded.matchAll(/"(?:sourceUrl|sourceCodeUrl)"\s*:\s*"(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)"/g)) sources.push(m[1]);
                        for (const m of decoded.matchAll(/<a\b[^>]*href="(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)"[^>]*>\s*(?:<[^>]+>\s*)*(?:Source|Source Code)\s*</gi)) sources.push(m[1]);
                        const name = decoded.match(/"(?:licenseName|license)"\s*:\s*"([^"<>]{1,150})"/)?.[1];
                        evidence.push({ origin: "curseforge", location: page, applicable: false, expression: name, documents: [], note: "Current project page; not a version-specific license grant." });
                        const licensePage = await fetcher(`${page.replace(/\/$/, "")}/license`);
                        if (typeof licensePage === "string") {
                            const pre = licensePage.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
                            const licenseText = pre?.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
                            if (licenseText) evidence.push({ origin: "curseforge", location: `${page}/license`,
                                applicable: !!matched?.license, expression: expressionName(name) ?? identifyLicense(licenseText),
                                documents: [{ name: "LICENSE", licenseText }],
                                note: matched?.license ? "License associated with the hash-matched platform file." : "Project license text found, but applicability to this exact version needs review." });
                        }
                    }
                } catch { evidence.push({ origin: "curseforge", location: page, applicable: false, documents: [], note: "Project page unavailable; no permission inferred." }); }
            }
        }
    } catch { evidence.push({ origin: "curseforge", location: "modpacks.ch SHA-1 lookup", applicable: false, documents: [], note: "Hash lookup unavailable; no permission inferred." }); }
    // Identity fallback only. Modrinth's current project licence does not enter
    // the user's GitHub -> JAR -> CurseForge priority order.
    if (!sources.some(s => githubRepo(s))) try {
        const version = await fetcher(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
        if (version?.files?.some((f: any) => f.hashes?.sha1 === sha1) && /^[\w-]+$/.test(version.project_id)) {
            const project = await fetcher(`https://api.modrinth.com/v2/project/${version.project_id}`);
            if (typeof project?.source_url === "string") sources.push(project.source_url);
        }
    } catch { /* Unavailable identity fallback is not a licence denial. */ }
    const seen = new Set<string>();
    for (const source of [...new Set(sources)].filter(s => typeof s === "string").slice(0, 4)) {
        const repo = githubRepo(source);
        if (!repo || seen.has(repo.repository.toLowerCase())) continue;
        seen.add(repo.repository.toLowerCase());
        try { const result = await githubEvidence(source, jar.version ?? hints.version, fetcher, jar.specificationVersion); if (result) evidence.push(result); }
        catch (error) {
            // Keep injected transports deterministic in unit tests. Production
            // falls back only on REST quota failures, not missing permissions.
            if (fetcher === licenseFetch && /\((?:403|429)\)/.test(String(error))) {
                try {
                    const result = await githubArchiveEvidence(source, jar.version ?? hints.version, jar.specificationVersion);
                    if (result) { evidence.push(result); continue; }
                } catch { /* Preserve the unresolved higher-priority evidence. */ }
            }
            evidence.push({ origin: "github", location: source, applicable: true, documents: [], note: "REVIEW: Linked repository evidence is unavailable; do not bypass a potentially higher-priority license." });
        }
    }
    const result = decideLicense(sha1, sha256, evidence);
    result.sourceUrl = sources.find(s => githubRepo(s));
    if (jar.uncertainScope) { result.disposition = "local_only"; result.reason = "Unrecognised third-party licence text requires a scope review."; }
    // A dependency's MIT notice never changes the parent mod's licence. It is
    // reviewed independently because whole-JAR decompilation includes JiJ code.
    try { result.notices.push(...bundledNotices(jar.nested)); }
    catch { result.disposition = "local_only"; result.reason = "A bundled dependency's licence conditions remain unresolved."; }
    return result;
}

const decisionCache = new Map<string, { expires: number; value: Promise<LicenseDecision> }>();
export async function cachedModLicense(jarPath: string, hints: { version?: string; sourceUrl?: string } = {}): Promise<LicenseDecision> {
    const s = await stat(jarPath);
    const key = JSON.stringify([jarPath, s.size, s.mtimeMs, s.ctimeMs, hints]);
    const cached = decisionCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = inspectModLicense(jarPath, hints);
    decisionCache.set(key, { expires: Date.now() + 10 * 60_000, value });
    if (decisionCache.size > 256) decisionCache.delete(decisionCache.keys().next().value!);
    try { return await value; } catch (error) { decisionCache.delete(key); throw error; }
}
