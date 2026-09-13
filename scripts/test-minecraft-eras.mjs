/** Live MCP compatibility checks. Uses public downloads and an isolated database/cache. */
import assert from "node:assert/strict";
import { appendFile, copyFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const runMods = !arguments_.length || arguments_.includes("--mods");
const selectedVersions = arguments_.filter(arg => arg !== "--mods");
const versions = selectedVersions.length ? selectedVersions : runMods && arguments_.length ? [] : [
    "b1.7.3", "1.2.5", "1.5.2", "1.6.4", "1.7.10", "1.8.9", "1.12.2",
    "1.13.2", "1.16.5", "1.18.2", "1.20.1", "1.20.6", "1.21.1", "26.1.2",
];
const root = await mkdtemp(join(tmpdir(), "modlens-minecraft-eras-"));
const cache = join(root, "cache");
await mkdir(cache, { recursive: true });
if (process.env.MODLENS_TEST_ARTIFACT_CACHE) {
    for (const directory of ["mc-jars", "mappings", "tools", "jdk"]) {
        await cp(join(process.env.MODLENS_TEST_ARTIFACT_CACHE, directory), join(cache, directory), { recursive: true }).catch(error => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}
await copyFile(join(repository, "prisma/backends/template.db"), join(root, "database.db"));

// An explicit read-only seed can avoid re-downloading the analysis tools.
if (process.env.MODLENS_TEST_TOOL_CACHE) {
    await mkdir(join(cache, "tools"), { recursive: true });
    for (const name of ["mcsrc-indexer.jar", "vineflower.jar", "tiny-remapper.jar", "SpecialSource.jar"]) {
        await copyFile(join(process.env.MODLENS_TEST_TOOL_CACHE, name), join(cache, "tools", name)).catch(error => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    typeof value === "string" && !/TOKEN|API_KEY|SECRET|^(MCP_|DATABASE_URL$|MODLENS_|OLLAMA_|AUTO_)/i.test(key),
));
Object.assign(environment, {
    DATABASE_URL: `file:${join(root, "database.db").replaceAll("\\", "/")}`,
    MODLENS_HOME: join(root, "home"), MODLENS_CACHE_ROOT: cache,
    MODLENS_AUTO_EMBED: "0", MODLENS_AUTO_GRAPH: "0", OLLAMA_URL: "http://127.0.0.1:1",
});
const client = new Client({ name: "minecraft-era-validation", version: "1.0" });
const transport = new StdioClientTransport({
    command: process.execPath, args: [join(repository, "dist/server.js")],
    cwd: root, env: environment, stderr: "pipe",
});
const errors = [];
const results = [];
let serverLog = "";
transport.stderr?.on("data", data => { serverLog += data; });
console.log(`Evidence: ${root}`);

async function call(name, args, validate, expectError = false) {
    const start = Date.now();
    const result = { name, args };
    try {
        const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
        const text = response.content.filter(item => item.type === "text").map(item => item.text).join("\n");
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (args.action === "search_class" && typeof data === "string") data = data.split("\n").filter(Boolean);
        assert.equal(response.isError === true, expectError, text);
        validate?.(data);
        result.passed = true;
        return data;
    } catch (error) {
        result.passed = false;
        result.error = error.message;
        throw error;
    } finally {
        result.elapsedMs = Date.now() - start;
        results.push(result);
        await appendFile(join(root, "results.jsonl"), JSON.stringify(result) + "\n");
        console.log(`${result.passed ? "PASS" : "FAIL"} ${args.version ?? ""} ${name}.${args.action} (${result.elapsedMs}ms)${result.error ? `: ${result.error.slice(0, 220)}` : ""}`);
    }
}

try {
    await client.connect(transport);
    await call("mc_versions", { action: "list_mc", type: "all" }, rows => {
        for (const version of versions) assert.ok(rows.some(row => row.id === version), `Version list omits ${version}`);
    }).catch(error => errors.push({ version: "catalog", error: error.message }));
    for (const version of versions) {
        try {
            const classes = await call("mc_source", { action: "search_class", version, query: "Minecraft" }, rows => {
                assert.ok(rows.some(name => /(?:^|\/)Minecraft$/.test(name)), "No named Minecraft class found");
            });
            const className = classes.find(name => /(?:^|\/)Minecraft$/.test(name));
            await call("mc_source", { action: "get_source", version, className, maxLines: 20 }, text => {
                assert.equal(typeof text, "string");
                assert.match(text, /(?:package|import) net\.minecraft\./);
            });
            await call("mc_source", { action: "class_members", version, className }, data => {
                assert.ok(data.methods.length > 5, "Missing class methods");
                assert.ok(data.fields.length > 5, "Missing class fields");
            });
            await call("mc_source", { action: "bytecode", version, className }, text => {
                assert.equal(typeof text, "string");
                assert.match(text, /Minecraft/);
                assert.match(text, /descriptor:/);
            });
            await call("mc_source", { action: "inheritance", version, className }, data => {
                assert.equal(data.className, className);
                assert.ok(data.superClass);
            });
            if (version === "1.5.2") {
                for (const [className, method] of [
                    ["net/minecraft/server/MinecraftServer", "tick"],
                    ["net/minecraft/src/IntegratedServer", "tickIntegrated"],
                ]) await call("mc_source", { action: "class_members", version, className }, data => {
                    assert.ok(data.methods.some(entry => entry.name === method), `Lost explicit mapping for ${className}.${method}`);
                });
            }
        } catch (error) {
            errors.push({ version, error: error.message });
        }
    }
    if (runMods) {
        await call("mod", { action: "get" }, text => assert.match(text, /modId or dbId is required/), true);
        const mods = [
            { project: 73488, version: "1.6.4", loader: "forge", name: "Waila" },
            { project: 73488, version: "1.7.10", loader: "forge", name: "Waila" },
            { project: 238222, version: "1.8.9", loader: "forge", name: "JEI" },
            { project: 238222, version: "1.12.2", loader: "forge", name: "JEI" },
            { project: 238222, version: "1.16.5", loader: "forge", name: "JEI" },
            { project: "AANobbMI", version: "1.16.5", loader: "fabric", name: "Sodium" },
            { project: 238222, version: "1.20.1", loader: "forge", name: "JEI" },
            { project: 238222, version: "1.21.1", loader: "neoforge", name: "JEI" },
        ];
        for (const mod of mods) {
            try {
                const infoArgs = { modId: mod.project, mcVersionFilter: mod.version, loader: mod.loader };
                const before = await call("mod", { action: "stats" });
                const info = await call("modpacks_ch", { action: "mod_info", ...infoArgs }, data => {
                    assert.ok(data.versions.length, `No ${mod.name} versions for ${mod.version}/${mod.loader}`);
                    assert.equal(data.versionLimit, 20);
                    assert.ok(data.versions.length <= data.versionLimit);
                    assert.ok(data.versions.every(version => version.loaders.includes(mod.loader)), "Accepted an unverified loader");
                });
                const compatibilityAlias = await call("modpacks_ch", { action: "ftb_mod_info", ...infoArgs });
                assert.deepEqual(compatibilityAlias, info);
                if (mod.name === "Waila" && mod.version === "1.7.10") {
                    await call("platform", { action: "search", query: "Waila", mcVersion: mod.version, loader: "forge", limit: 5 }, data => {
                        assert.ok(data.results.some(hit => String(hit.projectId) === String(mod.project)), "Loader-filtered search omitted Waila");
                        assert.ok(data.results.every(hit => hit.loaders.includes("forge")), "Search returned an unverified loader");
                    });
                    await call("modpacks_ch", { action: "mod_info", ...infoArgs, loader: "fabric", limit: 1 }, data => {
                        assert.deepEqual(data.versions, [], "Accepted a Forge-only release for Fabric");
                    });
                }
                await call("mod", { action: "stats" }, data => assert.equal(data.total, before.total, "Metadata inspection ingested candidate files"));
                const downloaded = await call("modpacks_ch", { action: "download_mod", ...infoArgs }, data => {
                    assert.ok(data.modId > 0, "Download did not produce an ingested mod");
                });
                const dbId = downloaded.modId;
                await call("mod", { action: "get", dbId }, data => {
                    assert.equal(data.id, dbId, "Returned the wrong database record");
                    assert.equal(data.loader, mod.loader);
                    assert.ok(data.modId && data.modId !== "unknown");
                    assert.ok(data.version && !data.version.includes("${"), "Unresolved version placeholder");
                });
                const files = await call("mod_jar", { action: "list_files", modId: dbId });
                const englishPath = files.entries.find(path => /(?:^|\/)lang\/en_us\.(json|lang)$/i.test(path));
                const languageFile = englishPath ? await call("mod_jar", { action: "get_file", modId: dbId, path: englishPath }) : undefined;
                const emptyLanguage = languageFile && (languageFile.data
                    ? Object.keys(languageFile.data).length === 0 : !languageFile.raw?.trim());
                await call("mod_jar", { action: "lang", modId: dbId }, data => {
                    if (emptyLanguage) assert.equal(data.total, 0, "Invented translations for an empty language file");
                    else if (englishPath) assert.ok(data.total > 0, "Existing language file was not read");
                    else assert.equal(data.found, false, "Reported language entries for a JAR without English translations");
                });
                await call("mod", { action: "reindex", dbId });
                const query = mod.name === "JEI" ? "JustEnoughItems" : mod.name;
                const classes = await call("mod_bytecode", { action: "search_class", dbId, query });
                const className = classes.find(name => !name.includes("$"));
                assert.ok(className, "No matching mod class found");
                await call("mod_bytecode", { action: "class_members", dbId, className }, data => {
                    assert.equal(data.className, className);
                    assert.ok(data.methods.length, "No methods returned for mod class");
                });
                await call("mod_bytecode", { action: "bytecode", dbId, className }, text => assert.match(text, /descriptor:/));
                await call("mod", { action: "decompile_class", dbId, className }, text => {
                    assert.match(text, /package /);
                    assert.ok(text.includes(className.split("/").at(-1)), "Decompiled the wrong class");
                });
            } catch (error) {
                errors.push({ version: `${mod.name} ${mod.version}/${mod.loader}`, error: error.message });
            }
        }
    }
} finally {
    await client.close();
    await writeFile(join(root, "server.log"), serverLog);
    await writeFile(join(root, "summary.json"), JSON.stringify({ versions, results, errors }, null, 2));
}
console.log(`${results.filter(row => row.passed).length}/${results.length} checks passed; ${errors.length} failing versions/catalogs. Evidence: ${root}`);
if (errors.length) process.exitCode = 1;
