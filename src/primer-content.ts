import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export const DEFAULT_PRIMER_HOSTS = [
    "github.com", "raw.githubusercontent.com", "neoforged.net", "docs.neoforged.net",
    "fabricmc.net", "wiki.fabricmc.net", "modrinth.com", "curseforge.com", "minecraft.wiki",
    "docs.minecraftforge.net", "minecraftforge.net", "quiltmc.org", "wiki.quiltmc.org",
    "linuxcafe.net", "gist.github.com", "gitlab.com", "codeberg.org",
];
export const MAX_PRIMER_CONTENT = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function validatePrimerUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Invalid primer URL"); }
    if (url.protocol !== "https:") throw new Error("Primer URL must use HTTPS");
    if (url.username || url.password) throw new Error("Primer URLs must not contain credentials");
    if (url.port && url.port !== "443") throw new Error("Primer URLs must use the HTTPS port");
    if (process.env.MODLENS_PRIMER_ALLOW_ANY_HTTPS !== "1") {
        const extra = (process.env.MODLENS_PRIMER_ALLOWED_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
        if (![...DEFAULT_PRIMER_HOSTS, ...extra].some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
            throw new Error(`Primer URL hostname "${url.hostname}" not in allowed list. Add it via MODLENS_PRIMER_ALLOWED_HOSTS.`);
        }
    }
    return url;
}

/** GitHub's blob UI contains navigation and scripts; the raw endpoint is the document. */
function fetchUrl(value: string): string {
    const url = validatePrimerUrl(value);
    const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (url.hostname === "github.com" && match) return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
    url.hash = "";
    return url.href;
}

async function readResponse(response: Response): Promise<string> {
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error("Primer response exceeds 8 MiB");
    }
    if (!response.body) throw new Error("Empty primer response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new Error("Primer response exceeds 8 MiB");
            chunks.push(next.value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
}

function articleHtml(html: string): string {
    return /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]
        ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1]
        ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
}

/** Highlighted Docusaurus code uses token-line elements and <br>, which textContent drops. */
function codeText(node: Node): string {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType !== 1) return "";
    const element = node as HTMLElement;
    if (element.nodeName === "BR") return "\n";
    if (element.getAttribute("aria-hidden") === "true") return "";
    const text = Array.from(node.childNodes).map(codeText).join("");
    return /(?:^|\s)token-line(?:\s|$)/.test(element.className ?? "") && !text.endsWith("\n") ? text + "\n" : text;
}

export function primerHtmlToMarkdown(html: string, url: string): string {
    const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", preformattedCode: true });
    converter.use(gfm);
    converter.addRule("highlighted-code-lines", {
        filter: "pre",
        replacement: (_content, node) => {
            const code = node.querySelector("code") ?? node;
            const language = /(?:^|\s)language-([\w-]+)/.exec(code.className + " " + node.className)?.[1] ?? "";
            const text = codeText(code).replace(/\n$/, "");
            const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/^`{3,}/gm), match => match[0].length + 1)));
            return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
        },
    });
    converter.addRule("page-chrome", {
        filter: node => ["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "ASIDE", "BUTTON", "FORM", "SVG", "IFRAME"].includes(node.nodeName) ||
            node.getAttribute("aria-hidden") === "true" || /(?:^|\s)(?:hash-link|breadcrumbs|theme-edit-this-page)(?:\s|$)/.test(node.className ?? ""),
        replacement: () => "",
    });
    converter.addRule("absolute-links", {
        filter: node => node.nodeName === "A" && node.getAttribute("aria-hidden") !== "true" &&
            !/(?:^|\s)(?:hash-link|theme-edit-this-page)(?:\s|$)/.test(node.className ?? ""),
        replacement: (content, node) => {
            const href = node.getAttribute("href");
            if (!href || !content.trim()) return content;
            try {
                const resolved = new URL(href, url);
                if (!["http:", "https:"].includes(resolved.protocol)) return content;
                return `[${content}](${resolved.href})`;
            } catch { return content; }
        },
    });
    return converter.turndown(articleHtml(html)).trim();
}

/** Fetch content with bounded redirects, body size and a single timeout for the whole operation. */
export async function fetchPrimerContent(value: string): Promise<string> {
    const signal = AbortSignal.timeout(30_000);
    const visited = new Set<string>();
    const load = async (input: string, depth = 0): Promise<string> => {
        if (depth > 5) throw new Error("Too many primer redirects or embedded pages");
        const url = fetchUrl(input);
        validatePrimerUrl(url); // including rewritten GitHub URLs and every redirect/iframe target
        if (visited.has(url)) throw new Error("Primer redirect/iframe loop");
        visited.add(url);
        const response = await fetch(url, { redirect: "manual", signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location) throw new Error(`HTTP ${response.status} without a redirect location`);
            return load(new URL(location, url).href, depth + 1);
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status} fetching ${url}`);
        }
        const type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (type && !/text\/|application\/(?:xhtml\+xml|octet-stream)/.test(type)) {
            await response.body?.cancel();
            throw new Error(`Unsupported primer content type: ${type}`);
        }
        const raw = await readResponse(response);
        const html = /html/.test(type) || /^\s*(?:<!doctype html|<html|<article|<main|<body)\b/i.test(raw);
        let content: string;
        if (html) {
            const body = articleHtml(raw);
            // The official loader-specific pages embed their release post instead of containing the guide.
            const embedded = /^https:\/\/docs\.neoforged\.net\/primer\//.test(url)
                ? /<iframe\b[^>]*\bsrc=["']([^"']+)["']/i.exec(body) : null;
            if (embedded) {
                const source = new URL(embedded[1].replace(/&amp;/g, "&"), url).href;
                content = `${await load(source, depth + 1)}\n\nEmbedded source: ${source}`;
            } else content = primerHtmlToMarkdown(raw, url);
        } else content = raw.replace(/^\uFEFF/, "").trim();
        if (!content || content.length < 80 || /^(?:#\s*)?(?:404|page not found|not found)(?:\s|$)/i.test(content)) throw new Error(`No readable primer content at ${url}`);
        if (Buffer.byteLength(content, "utf8") > MAX_PRIMER_CONTENT) throw new Error("Primer content exceeds 2 MiB; it was not truncated or cached");
        return content;
    };
    try { return await load(value); }
    catch (e) { throw new Error(`Primer content fetch failed: ${e instanceof Error ? e.message : String(e)}`); }
}
