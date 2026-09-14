import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPrimerContent, primerHtmlToMarkdown, validatePrimerUrl, MAX_PRIMER_CONTENT } from "./primer-content.js";

const url = "https://docs.neoforged.net/primer/docs/1.21.5/";
const body = "# Migration guide\n\n" + "Detailed migration instructions for mod authors. ".repeat(5);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("primer content extraction", () => {
    it("preserves code, headings, tables and links without navigation or copy controls", () => {
        const text = primerHtmlToMarkdown(
            '<nav>Outside navigation</nav><article><h1>Migration<a class="hash-link" href="#migration">#</a></h1>' +
            '<p>See <a href="../1.21.4/">previous guide</a> &amp; details.</p>' +
            '<div class="language-java"><pre><code class="language-java">if (count &lt; 2) {\n    update();\n}</code></pre><button>Copy</button></div>' +
            '<table><thead><tr><th>Old</th><th>New</th></tr></thead><tbody><tr><td>before</td><td>after</td></tr></tbody></table>' +
            '<script>evil()</script><aside>Sidebar</aside></article><footer>Footer</footer>', url);
        expect(text).toContain("# Migration");
        expect(text).toContain("[previous guide](https://docs.neoforged.net/primer/docs/1.21.4/)");
        expect(text).toContain("if (count < 2) {\n    update();\n}");
        expect(text).toContain("```java");
        expect(text).toContain("| Old | New |");
        for (const unwanted of ["Outside navigation", "Copy", "evil()", "Sidebar", "Footer", "(#" , "# Migration#"]) {
            expect(text).not.toContain(unwanted);
        }
    });

    it("reads official embedded NeoForge release articles, including their final section", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('<article><h1>Neo Changes</h1><iframe src="https://neoforged.net/news/21.5release/"></iframe></article>', { headers: { "content-type": "text/html" } }))
            .mockResolvedValueOnce(new Response("<nav>Menu</nav><main><article><h1>NeoForge 21.5</h1><p>" + body + "</p><h2>Last section</h2></article></main>", { headers: { "content-type": "text/html" } }));
        vi.stubGlobal("fetch", fetchMock);
        const text = await fetchPrimerContent(url + "neo/");
        expect(text).toContain("# NeoForge 21.5");
        expect(text).toContain("## Last section");
        expect(text).toContain("Embedded source: https://neoforged.net/news/21.5release/");
        expect(text).not.toContain("Menu");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("preserves Docusaurus highlighted code lines, indentation, blank lines and language", () => {
        const text = primerHtmlToMarkdown('<article><pre class="prism-code language-java"><code class="codeBlockLines">' +
            '<div class="token-line"><span>if (ready) {</span><br></div>' +
            '<div class="token-line"><span>    // Keep this comment on its own line</span><br></div>' +
            '<div class="token-line"><br></div><div class="token-line"><span>    update();</span><br></div>' +
            '<div class="token-line"><span>}</span></div></code></pre></article>', url);
        expect(text).toBe("```java\nif (ready) {\n    // Keep this comment on its own line\n\n    update();\n}\n```");
    });

    it("reads GitHub Markdown via its raw endpoint without the old 50K truncation", async () => {
        const full = body.repeat(250) + "\n\n## Final migration step";
        const fetchMock = vi.fn(async () => new Response(full, { headers: { "content-type": "text/plain" } }));
        vi.stubGlobal("fetch", fetchMock);
        expect(await fetchPrimerContent("https://github.com/owner/repo/blob/main/guide.md")).toBe(full);
        expect(fetchMock.mock.calls[0][0]).toBe("https://raw.githubusercontent.com/owner/repo/main/guide.md");
    });

    it("does not replace a normal article with a supplementary iframe", async () => {
        const fetchMock = vi.fn(async () => new Response("<article><h1>Main guide</h1><p>" + body + '</p><iframe src="https://video.invalid/"></iframe></article>', { headers: { "content-type": "text/html" } }));
        vi.stubGlobal("fetch", fetchMock);
        expect(await fetchPrimerContent("https://neoforged.net/news/post/")).toContain("# Main guide");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("primer fetch failures", () => {
    it.each([
        [new Response("missing", { status: 404 }), "HTTP 404"],
        [new Response("<html><body>Page not found</body></html>", { headers: { "content-type": "text/html" } }), "No readable"],
        [new Response("binary", { headers: { "content-type": "image/png" } }), "Unsupported"],
        [new Response("too large", { headers: { "content-length": String(9 * 1024 * 1024) } }), "exceeds 8 MiB"],
        [new Response("x".repeat(MAX_PRIMER_CONTENT + 1), { headers: { "content-type": "text/plain" } }), "exceeds 2 MiB"],
    ])("rejects unusable content (%s)", async (response, error) => {
        vi.stubGlobal("fetch", vi.fn(async () => response));
        await expect(fetchPrimerContent(url)).rejects.toThrow(error);
    });

    it("validates redirected and embedded hosts before making requests", async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(fetchPrimerContent(url)).rejects.toThrow("not in allowed list");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockResolvedValue(new Response('<article><iframe src="http://neoforged.net/private"></iframe></article>', { headers: { "content-type": "text/html" } }));
        await expect(fetchPrimerContent(url)).rejects.toThrow("HTTPS");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("handles permitted redirects and rejects redirect loops", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/guide/" } }))
            .mockResolvedValueOnce(new Response(body));
        vi.stubGlobal("fetch", fetchMock);
        expect(await fetchPrimerContent(url)).toBe(body.trim());
        fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: url } }));
        await expect(fetchPrimerContent(url)).rejects.toThrow("loop");
    });

    it("keeps validation in effect for credentials, ports, and insecure URLs", () => {
        for (const target of ["http://neoforged.net/guide", "https://user:secret@neoforged.net/guide", "https://neoforged.net:8443/guide", "https://neoforged.net.attacker.invalid/guide"]) {
            expect(() => validatePrimerUrl(target)).toThrow();
        }
        vi.stubEnv("MODLENS_PRIMER_ALLOWED_HOSTS", " DOCS.EXAMPLE.COM ");
        expect(validatePrimerUrl("https://docs.example.com/guide").hostname).toBe("docs.example.com");
    });
});
