# modlens-mcp

MCP server and CLI for browsing, decompiling, and analyzing Minecraft mod JARs.

Store mod metadata, class indexes, mixin targets, AT/AW entries, and decompiled source in a local database — **embedded SQLite by default** (zero setup), or PostgreSQL/PGlite if you want them. Query everything via AI (MCP) or command line (CLI).

## Optional live development client

The `runtime` MCP tool can prepare and launch a Minecraft development client,
detect IntelliJ launches, monitor JVM failures and memory pressure, capture
screenshots, and control game input. It uses SDL on Minecraft 26.3, GLFW on
1.13–1.21, and LWJGL2 on 1.7.10–1.12.2. Ask the AI
to call `runtime` with `action:"help"` or set it up
for your mod project. With remote MCP, Codex runs the local `--runtime` helper;
with local stdio MCP, the tools execute directly. No second MCP connection is needed.
See [runtime setup, examples, and compatibility limits](RUNTIME.md).

## Reporting an issue from your coding agent

Ask your agent to **report a ModLens issue on GitHub**. The `report_issue` MCP tool
works locally and remotely: `action:"help"` explains the workflow, and
`action:"prepare"` produces a draft from a title, summary, reproduction steps,
expected/actual behavior, environment and an optional sanitized diagnostic excerpt.
It includes the ModLens server version automatically.

The tool directs the agent to check for duplicates and submit to
[CreeperHost/modlens-mcp](https://github.com/CreeperHost/modlens-mcp/issues) using
its existing GitHub connector or `gh issue create --body-file`. Without GitHub
access, it returns a draft and a manual submission link. ModLens needs no GitHub
credentials and does not publish the report itself; `executed:false` means only
the draft was prepared. Remove credentials, private source and personal details
before supplying diagnostic excerpts. Reports are submitted when the user requests
it, rather than automatically for every error.

## Installation

### Option A — npx (recommended, no clone required)

```bash
npx @creeperhost/modlens-mcp
```

On first run it works with **zero configuration** — an embedded SQLite database is created automatically at `~/.modlens/data/modlens.db` (no Docker, no external services). Settings are stored in `~/.modlens/.env` and survive updates.

Add it to your MCP client config to start using it:
```json
{
  "mcpServers": {
    "modlens": { "command": "npx", "args": ["-y", "@creeperhost/modlens-mcp"] }
  }
}
```

**Optional — switch backends or enable semantic search:**
```bash
npx @creeperhost/modlens-mcp --setup
```
The setup wizard lets you move to PostgreSQL/PGlite, configure Ollama for semantic search, and auto-write your MCP client config. Re-run it any time to reconfigure.

**Update to the latest version:**
```bash
npx @creeperhost/modlens-mcp@latest --setup
```
This pins the new version in your MCP client config. Your database and settings in `~/.modlens/` are untouched.

---

### Option B — git clone (for contributors / advanced users)

```bash
git clone https://github.com/CreeperHost/modlens-mcp
cd modlens-mcp
npm install
npm run setup   # interactive setup wizard
npm run start   # start the server
```

---

## Gradle project environments

ModLens can import the **actual compile classpath** of a Gradle project. The ModDevGradle adapter also exports the matching prepared Minecraft sources and hashes of the AT files used by its artifact task. This lets the AI see project-specific access changes, loader patches and mapped names.

Imports are private, immutable snapshots, separate from the shared vanilla/mod caches and database. Re-export and import after changing ATs, dependencies or mappings. The returned `environmentId` selects the new snapshot; earlier IDs still describe their original inputs. This is compile-time context, not a simulation of runtime mixins/coremods.

### Export from Gradle

In a checkout, run your mod project's wrapper with the supplied init script:

```bash
./gradlew -I /path/to/modlens-mcp/scripts/gradle/modlens.init.gradle :modlensExport
```

For an installed package, locate its script first:

```bash
npx @creeperhost/modlens-mcp --gradle-init-script
# Pass the printed path to your project's ./gradlew -I command.
```

On Windows, use `gradlew.bat -I "H:\Git\modlens-mcp\scripts\gradle\modlens.init.gradle" :modlensExport`.

The task produces `build/modlens/main/environment.zip` and creates a persistent private key at `.gradle/modlens/project-key.txt` in the selected project. The key is not included in the bundle or printed. Keep it out of source control and share it only with clients that should access this project.

Use `:subproject:modlensExport` for a module, and `-PmodlensSourceSet=client` to select a different source set. The task runs the classpath's prerequisite tasks, including Minecraft artifact preparation, without launching the game. Referenced project/source-set outputs may need compilation. It does not support Gradle's configuration cache; use `--no-configuration-cache` if necessary.

Supported adapter: **ModDevGradle 2.x**, exercised with 2.0.141 / NeoForge 21.1.209 / Minecraft 1.21.1 and Gradle 8.14. Other Java projects can export their resolved compile classpath, including directory dependencies. Automatic source discovery for ForgeGradle/NeoGradle/Loom is not implemented; absent supplied sources, individual classes are decompiled from the exported binaries on demand. Do not interpret generic exports as proof that runtime-only transformations have been applied.

Optional metadata overrides: `-PmodlensMinecraftVersion=...`, `-PmodlensMappings=...`. The exporter also reads the common `minecraft_version`, `neo_version` and `forge_version` properties. It exports artifact names/content hashes and selected version metadata, not the project's entire Gradle configuration, repository credentials or absolute dependency paths.

### Import locally or remotely

Local import and query examples:

```bash
npx @creeperhost/modlens-mcp --project import-local build/modlens/main/environment.zip --key-file=.gradle/modlens/project-key.txt
npx @creeperhost/modlens-mcp --project list --key-file=.gradle/modlens/project-key.txt
npx @creeperhost/modlens-mcp --project members --environment-id=<returned-id> --class-name=net.minecraft.world.level.Level --key-file=.gradle/modlens/project-key.txt
```

From a checkout, the equivalent is `node dist/cli.js project ...`.

For a remote server, run the uploader **on the developer's machine**, where the bundle exists:

```bash
npx @creeperhost/modlens-mcp --project-upload https://modlens.example/mcp build/modlens/main/environment.zip .gradle/modlens/project-key.txt
# Checkout equivalent:
node /path/to/modlens-mcp/scripts/project-upload.mjs https://modlens.example/mcp build/modlens/main/environment.zip .gradle/modlens/project-key.txt
```

Set `MODLENS_AUTH_TOKEN` if the deployment's reverse proxy requires a bearer token. Remote uploads require HTTPS; loopback HTTP is supported for local testing. The uploader transfers 1 MiB chunks, verifies the full bundle hash, retries acknowledged chunks safely and prints the imported snapshot metadata. The remote server never runs Gradle or needs the developer's local paths. Host-local import is disabled when `MCP_PORT` is set.

Configure the AI to use the MCP **`project` tool** with `projectKey` (the key file's contents) and `environmentId`. Use `project` source/member/search queries for this environment; the existing `mc_source` and `mod` tools continue to describe their shared inputs. Key possession grants access to that project's snapshots; use the deployment's normal authentication to control access to the service and its upload resources.

| Action | Additional arguments | Result |
| --- | --- | --- |
| `list` | none | Snapshots belonging to this project key only |
| `info` | `environmentId` | Versions, artifacts, counts and snapshot provenance |
| `classes` | `environmentId`, optional `query`, `offset`, `limit` | Classes in compile classpath order of precedence |
| `source` | `environmentId`, `className`, optional `startLine`, `maxLines` | Supplied Gradle source or an on-demand binary decompile |
| `members` / `bytecode` | `environmentId`, `className` | Inspection of the project's prepared binary |
| `search` | `environmentId`, `query`, optional `limit` | Literal, case-insensitive search of supplied sources and cached decompiles |
| `import_local` | `bundlePath` | Import an absolute host-local ZIP path (stdio only) |
| `upload_begin` | `size`, `sha256` | Upload ID and chunk size |
| `upload_chunk` | `uploadId`, `offset`, `data` | Next offset; `data` is base64 |
| `upload_finish` / `upload_abort` | `uploadId` | Commit a complete upload or remove upload state |

Search reports its coverage: a missing match does not prove absence from binaries without sources. Duplicate classes follow the first compile classpath entry; sources from shadowed dependencies are excluded. Multi-release JARs use the compile Java release, with stale base sources excluded when a versioned class overrides them. Limits are 512 MiB per bundle, 1 GiB expanded content, 2 MiB per Java source, and four unfinished uploads per project. Abandoned uploads expire after 24 hours and are cleaned up when the next upload begins. Snapshot files live under `MODLENS_CACHE_ROOT/projects` and work with all database backends.

Contributor validation: `npm run test:project:http` exercises the real uploader and HTTP transport. Set `JAVA_HOME` and `MODLENS_TEST_GRADLE_HOME`, then run `npm run test:project:gradle` for a Java dependency fixture, or `npm run test:project:gradle -- moddev` for a real AT before/after check. The Gradle tests use disposable projects and may download build dependencies; they never launch Minecraft.

Minecraft compatibility validation: `npm run test:minecraft:eras` exercises the local MCP server across Beta 1.7.3 through 26.1.2, plus real legacy Forge, Fabric and NeoForge mods, using temporary databases and caches. See [TESTING.md](TESTING.md) for the version matrix, offline format coverage and upstream gaps.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 22+** | Runtime for the MCP server |
| **Docker** | *Optional* — only for the PostgreSQL backend (`docker compose`). Not needed for the default embedded SQLite. |
| **JDK 21+** | Required for decompilation (Vineflower) and bytecode analysis (`javap`). Eclipse Adoptium recommended — auto-discovered at `C:/Program Files/Eclipse Adoptium`, `C:/Program Files/Java`, `C:/Program Files/Microsoft`, or via `JAVA_HOME` |
| **Vineflower** | Decompiler JAR — **auto-downloaded** from Maven Central on first use |
| **mcsrc-indexer.jar** | JAR bytecode indexer — **auto-downloaded** from the modlens-mcp GitHub release on first use |

**Optional environment variables:**

| Variable | Purpose |
|----------|---------|
| `CURSEFORGE_API_KEY` | Optional direct fingerprint lookup and authenticated CurseForge downloads; normal metadata/sync uses modpacks.ch |
| `MODRINTH_TOKEN` | Modrinth API — increases rate limit for batch operations |
| `JAVA_HOME` | Override Java discovery (falls back to PATH if not set) |

---

## Docker — PostgreSQL Setup

> Only needed if you choose the **PostgreSQL** backend. The default embedded SQLite backend requires none of this.

The included `docker-compose.yml` starts a PostgreSQL 16 container on port **5433**.

```bash
# Start (detached)
docker compose up -d

# Check it's healthy
docker compose ps

# Stop (data is preserved in the named volume)
docker compose down

# Stop and wipe all data
docker compose down -v
```

> **⚠ Dev credentials warning:** `docker-compose.yml` uses `modlens:modlens` as the username/password. This is fine for a local dev tool that only binds to `localhost:5433`. If you expose the port externally or run this on a shared machine, change `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` in `docker-compose.yml` **and** update your `.env` accordingly.

---

## Setup

```bash
git clone https://github.com/CreeperHost/modlens-mcp
cd modlens-mcp
npm install
npm run build

# Interactive setup wizard — handles Docker, Ollama, schema, MCP config:
npm run setup
```

The wizard will ask about semantic search (Ollama), start the containers, apply the schema, optionally seed docs/primers, and write your MCP client config. Run it again any time to reconfigure.

**Manual setup (if you prefer):**

```bash
# 1. Start PostgreSQL
docker compose up -d

# 2. Create .env
echo DATABASE_URL=postgresql://modlens:modlens@localhost:5433/modlens > .env
# Optional — add a CurseForge key for sync_curseforge:
# echo CURSEFORGE_API_KEY=<your key> >> .env
# Optional — add a Modrinth token for higher rate limits:
# echo MODRINTH_TOKEN=<your token> >> .env

# 3. Apply the Prisma schema to the DB
npx prisma db push

# 4. Build
npm run build
```

> **Note:** Both Vineflower and mcsrc-indexer.jar are downloaded automatically to `~/.modlens-cache/tools/` on first use — no manual steps needed.

---

## Semantic Search (optional)

Semantic (vector) search lets you find docs, primers, and MC source by meaning rather than keywords — e.g. *"how do I attach data to a block?"* instead of the exact class name.

**Requirements:** [Ollama](https://ollama.com) installed and running locally.

```bash
# 1. Install Ollama and pull the embedding model
ollama pull nomic-embed-text

# 2. Enable pgvector in your Postgres container and add embedding columns
npm run db:vector

# 3. Add Ollama config to .env (optional — http://localhost:11434 is the default)
echo OLLAMA_URL=http://localhost:11434 >> .env

# 4. Embed all existing docs and primers
node dist/cli.js backfill-embeddings

# Embed a specific MC source version (large — takes a while)
node dist/cli.js backfill-embeddings --type source --version 26.1.2
```

After this, the `docs` and `primers` MCP tools provide `semantic_search`, and `mc_source` provides `search_semantic` and `index_semantic`. Semantic search requires a reachable Ollama service and the configured embedding model. Keyword search remains available separately. SQLite uses the bundled `sqlite-vec` dependency; `db:vector` above is for PostgreSQL.

> **Note:** The `npm run db:vector` script is safe to re-run. It creates the `pgvector` extension and `embedding` columns using `IF NOT EXISTS` guards.

## Data sources and shared bundles

ModLens uses [modpacks.ch](https://modpacks.ch/api/openapi.json) for supported mod and pack searches, provider records, release histories, hash lookups, parsed pack manifests and loader versions. Maven artifacts and metadata come from [CreeperHost Maven](https://maven.creeperhost.net/). Download URLs supplied by modpacks.ch may point to the original provider's CDN. An API failure or missing result does not silently switch to another metadata service.

When a mod file has no loader label, loader-filtered searches, version listings and update checks automatically download and inspect its JAR. Existing modpacks.ch labels take precedence. Inspection supports Forge/FML, Fabric, Quilt and NeoForge, including multiple loader declarations in one JAR; unknown or mismatched loaders are excluded. Recovered labels report `loaderSource: "jar"`. The first lookup can download several candidate files; subsequent queries and ingestion reuse the artifact cache. `mod_info` defaults to the latest 20 matches and reports `versionLimit`; increase `limit` (CLI: `--limit`) for more history. Download, checksum and unreadable-JAR failures are reported as errors.

Existing sources remain for capabilities these services do not cover: Mojang manifests, game files and official mappings; mcmeta's extracted data and history; RetroMCP legacy mappings; Adoptium runtime provisioning; the ModLens indexer release; metadata-provided source repositories; and the selected GitHub graph and embedding registries. Existing local Java installations are preferred.

`mod graph_build` can build a class and inheritance graph directly from the mod JAR, without Graphify or an AI service. Set `backend=ast-only` to select this mode explicitly. `graph_enrich_next` and `graph_enrich_submit` add relationships supplied by the client. Automatic semantic extraction still needs a configured Graphify backend.

`graph_export` and `embed_export` produce portable gzip bundles. Pass the resulting `bundlePath` to `graph_submit` or `embed_submit` to propose the bundle and its index entry together in a draft pull request. The defaults are [Mattabase/modlens-graphs](https://github.com/Mattabase/modlens-graphs) and [Mattabase/modlens-embeddings](https://github.com/Mattabase/modlens-embeddings). Submissions require `MODLENS_REGISTRY_TOKEN` or `GITHUB_TOKEN` with access to write the branch and open the pull request; a personal fork is used when the account cannot push to the registry. Submission does not merge the pull request.

Custom registries use `MODLENS_GRAPH_REGISTRY_URL` or `MODLENS_EMBED_REGISTRY_URL`. For submission, the corresponding `MODLENS_GRAPH_REGISTRY_REPO` / `MODLENS_EMBED_REGISTRY_REPO`, `_BRANCH` and `_INDEX_PATH` settings override the destination inferred from a GitHub raw-content URL.

---

## MCP Configuration

The server uses stdio transport — it works with any MCP client (VS Code Copilot, Claude Desktop, Claude CLI, Cursor, etc.) as long as Docker is running and `DATABASE_URL` is set.

### VS Code Copilot (`mcp.json`)

```json
{
  "servers": {
    "modlens": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/modlens-mcp/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://modlens:modlens@localhost:5433/modlens"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

Location: `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

```json
{
  "mcpServers": {
    "modlens": {
      "command": "node",
      "args": ["/path/to/modlens-mcp/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://modlens:modlens@localhost:5433/modlens"
      }
    }
  }
}
```

### Claude CLI

```bash
claude mcp add modlens node /path/to/modlens-mcp/dist/server.js \
  --env DATABASE_URL=postgresql://modlens:modlens@localhost:5433/modlens
```

Or manually edit `~/.claude/mcp.json` (same format as VS Code above).

> **Important:** Replace `/path/to/modlens-mcp` with the actual absolute path where you cloned the repo. On Windows use forward slashes or escaped backslashes, e.g. `C:/Users/you/modlens-mcp/dist/server.js`.

---

## Updating

```bash
npm run update
```

This runs `git pull`, reinstalls dependencies, rebuilds, and applies any new DB migrations — all in one command. After it finishes, **restart your MCP client** (reload VS Code window, restart Claude Desktop, etc.) to pick up the new server build.

> **First-time update (before `npm run update` existed)?** Run the steps manually once:
> ```bash
> git pull && npm install && npm run build && node scripts/post-update.mjs
> ```
> After this you'll have `npm run update` available for all future updates.

---

### 💡 Token overhead — disable tools you don't need

ModLens ships **22 tools**. Every tool's name, description, and parameter schema is sent to the model on **every request**, whether you use that tool or not. This adds a fixed overhead of ~3,400 tokens per turn.

**Recommendation:** disable any tool groups you don't regularly use. Common profiles:

| If you primarily… | Keep | Disable |
|---|---|---|
| Browse vanilla MC source | `mc_source`, `mc_data`, `mc_files`, `mc_registry`, `mappings` | `platform`, `mixin_scan`, `gradle`, `kubejs`, `pack_tools` |
| Analyze a modpack | `mod`, `mod_mixins`, `mixin_scan`, `reports`, `pack_tools` | `mc_files`, `mappings`, `docs`, `primers`, `gradle` |
| Mod development | `mod`, `mod_bytecode`, `mc_source`, `mappings`, `docs`, `primers` | `pack_tools`, `kubejs`, `platform`, `mixin_scan` |

**VS Code:** In `mcp.json` you can disable individual tools using the `disabled` list under the server entry:
```json
{
  "servers": {
    "modlens": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/modlens-mcp/dist/server.js"],
      "env": { "DATABASE_URL": "postgresql://modlens:modlens@localhost:5433/modlens" },
      "disabled": ["kubejs", "platform", "gradle", "docs", "primers"]
    }
  }
}
```

**Claude Desktop / CLI:** Toggle tools off in the MCP settings UI, or maintain separate config files for different workflows.

---

## CLI

All MCP tools are available from the command line:

```
node dist/cli.js <command> [args] [--flags]
```

Run without arguments (or `--help`) to print the full command list. Every MCP tool action has a CLI equivalent.

### Quick Reference

**Database & Catalog**

| Command | Description |
|---------|-------------|
| `stats` | DB statistics |
| `list` | List all mods |
| `get <modId>` | Get mod metadata |
| `search <query>` | Search mods |
| `deps <modId>` | List dependencies |
| `dep-graph` | Full dependency graph |
| `version-conflicts` | Duplicate modIds + unsatisfied deps |
| `source-urls [query]` | List GitHub/GitLab source URLs |

**Ingest**

| Command | Description |
|---------|-------------|
| `ingest <jarPath>` | Ingest a mod JAR (WSL paths auto-converted) |
| `ingest-neoforge <version>` | Download + ingest NeoForge |
| `ingest-fabric-api <version>` | Download + ingest Fabric API |
| `batch-ingest <dir>` | Ingest all JARs in a directory |
| `batch-decompile` | Decompile all un-decompiled mods |
| `batch-sync` | Bulk sync from Modrinth/CurseForge |
| `reindex` | Index class names for un-indexed mods |

**Decompile & Source**

| Command | Description |
|---------|-------------|
| `decompile <dbId>` | Decompile entire mod JAR |
| `decompile-status <dbId>` | Poll decompilation progress |
| `decompile-class <dbId> <class>` | Decompile a single class |
| `source <dbId> [path]` | Browse decompiled source |
| `search-source <query>` | Search decompiled source |
| `get-paths <dbId>` | JAR + decomp paths for native grep |
| `index-fts <dbId>` | Index mod source for BM25 search (no Ollama) |
| `search-indexed <dbId> <query>` | Fast BM25 FTS over mod source |

**Bytecode Analysis**

| Command | Description |
|---------|-------------|
| `search-class <dbId> <query>` | Search for a class by name |
| `members <dbId> <class>` | List methods and fields |
| `bytecode <dbId> <class>` | Raw javap bytecode |
| `refs <dbId> <target>` | Find references |
| `inheritance <dbId> <class>` | Inheritance chain |
| `diff <dbIdA> <dbIdB>` | Compare two mod versions |
| `diff-detailed <dbIdA> <dbIdB>` | AST-level diff with breaking-change flags |
| `cross-refs <target>` | Cross-mod references to a target |
| `find-implementors <target>` | Classes implementing an interface |
| `scan-registrations <dbId>` | Registry object registrations |
| `annotated-by <annotation>` | Classes with a given annotation |
| `event-listeners <event>` | Event listener registrations |
| `optional-integrations <dbId>` | Soft dependency integrations |
| `network-payloads <dbId>` | Network packet types |
| `config-schema <dbId>` | Configuration class schemas |

**Mixin Analysis**

| Command | Description |
|---------|-------------|
| `mixin-targets <modId>` | MC classes this mod injects into |
| `resolve-mixins <dbId>` | Parse `@Mixin` bytecode → update DB |
| `mixin-conflicts <targetClass>` | Mods injecting into the same class |
| `at-entries <dbId>` | Access Transformer entries |
| `aw-entries <dbId>` | Access Widener entries |
| `targets-in-package <pkg>` | Mods targeting classes in a package |
| `at-conflicts` | AT/AW entries conflicting across mods |
| `batch-resolve-mixins` | Resolve `@Mixin` targets for all mods |

**Mixin Scan (cross-mod matrix)**

| Command | Description |
|---------|-------------|
| `mixin-scan list` | List mods with mixins |
| `mixin-scan conflict-matrix` | Full conflict matrix |
| `mixin-scan class-detail <class>` | All mixins targeting one MC class |
| `mixin-scan hotspots` | Most-targeted MC classes |
| `mixin-scan batch-resolve` | Resolve targets for all mixin mods |

**Platform**

| Command | Description |
|---------|-------------|
| `sync-modrinth <dbId>` | Look up on Modrinth |
| `sync-curseforge <dbId>` | Look up on CurseForge |
| `check-updates <dbId>` | Check for newer versions |
| `download-source <dbId>` | Download GitHub/GitLab source |

**Versions**

| Command | Description |
|---------|-------------|
| `mc-versions` | List Minecraft versions |
| `neoforge-versions` | List NeoForge versions |
| `fabric-api-versions` | List Fabric API versions |

**Vanilla MC Source**

| Command | Description |
|---------|-------------|
| `mc-source search-class <ver> <q>` | Find a vanilla class by name |
| `mc-source get-source <ver> <class>` | Read decompiled source |
| `mc-source bytecode <ver> <class>` | Raw javap bytecode |
| `mc-source class-members <ver> <c>` | Methods and fields |
| `mc-source find-refs <ver> <target>` | References to a target |
| `mc-source inheritance <ver> <c>` | Inheritance tree |
| `mc-source diff <verA> <verB>` | High-level class diff |
| `mc-source diff-detailed <A> <B>` | AST-level method/field diff |
| `mc-source decompile <ver>` | Decompile MC JAR |
| `mc-source decompile-status <ver>` | Poll decompilation progress |
| `mc-source search-code <ver> <q>` | Full-text search over vanilla source |
| `mc-source index <ver>` | Index vanilla source for BM25 |
| `mc-source search-indexed <ver> <q>` | BM25 FTS over vanilla source |
| `mc-source search-events <ver>` | Browse event classes |
| `mc-source validate-aw <ver> <file>` | Validate an `.accesswidener` file |
| `mc-source analyze-mixin <ver> <file>` | Analyze a mixin source file |
| `mc-source search-semantic <ver> <q>` | Semantic search (requires Ollama) |
| `mc-source get-paths <ver>` | On-disk jar/decomp/index paths |

**Mappings**

| Command | Description |
|---------|-------------|
| `mappings find <sym> <ver> <src> <tgt>` | Translate between namespaces |
| `mappings remap <in> <out> <ver> <mapping>` | Remap a JAR |
| `mappings parchment <class> <mcVer>` | Parchment parameter docs |
| `mappings list-parchment <mcVer>` | Available Parchment versions |
| `mappings parchment-summary <mcVer>` | Parchment coverage stats |

**Documentation & Primers**

| Command | Description |
|---------|-------------|
| `docs seed` | Seed built-in docs |
| `docs get <query>` | Look up by title/class |
| `docs search <query>` | Keyword search |
| `docs list` | List all entries |
| `docs delete <id>` | Delete by ID |
| `docs semantic-search <query>` | Semantic search (requires Ollama) |
| `primers seed` | Seed built-in primers |
| `primers get <id>` | Get by ID |
| `primers by-version <from> <to>` | Guides for a version range |
| `primers search <query>` | Keyword search |
| `primers list` | List all primers |
| `primers delete <id>` | Delete by ID |
| `primers semantic-search <query>` | Semantic search (requires Ollama) |

**MC Registry / Data / Files**

| Command | Description |
|---------|-------------|
| `mc-registry <action>` | blocks, commands, registries, sounds, item-components, registry-entries, mcmeta-versions |
| `mc-data <action>` | tags, find-tags-for, recipes, get-recipe, biomes, enchantments, lang, model, structures, particles, entity-attributes, and more |
| `mc-files <action>` | get-data, get-asset, list-files, diff, atlas, raw, compare, changelog |

**Mod JAR & Mod Data**

| Command | Description |
|---------|-------------|
| `mod-jar <action> <modId>` | list-files, get-file, lang, sounds, atlas, registry-entries, manifest, list-configs, get-config |
| `mod-data <action> <modId>` | list, get, diff, trace-item — with type: recipe, loot_table, advancement, model, biome, data_tag, enchantment, and more |

**Mod Tags, Gradle, Reports, Pack Tools**

| Command | Description |
|---------|-------------|
| `mod-tags <action>` | index, index-all, namespaces, contributors, expand, mod-list, find-conflicts, search |
| `gradle <action>` | get-files, search, compare-deps |
| `report <type>` | mixin-conflicts, tag-conflicts, version-conflicts, mod-overview, gradle-deps, pack-compat, dep-graph, sidedness, mod-complexity, pack-changelog |
| `pack-tools <action>` | asset-conflicts, vanilla-overrides, sidedness, pack-sidedness, complexity, pack-changelog, data-conflicts |

**KubeJS & Modpacks**

| Command | Description |
|---------|-------------|
| `kubejs index <dir>` | Index a kubejs/ scripts directory |
| `kubejs search <dir> <query>` | Search indexed scripts |
| `modpacks search <query>` | Search modpacks.ch packs |
| `modpacks featured` | Featured packs |
| `modpacks info <packId>` | Pack metadata |
| `modpacks manifest <packId> <verId>` | Pack manifest |
| MCP `modpacks_ch action=resolve_pack` | Resolve FTB/CurseForge/Modrinth/Feed The Beast pack names, IDs, version IDs, or version names |
| MCP `modpacks_ch action=list_versions` | List remote pack versions and optionally mark matches for a short `versionRef` like `7.1` |
| MCP `modpacks_ch action=ingest_pack` | Resolve metadata through modpacks.ch, then download and ingest the selected pack version |
| `modpacks list-versions` | Pack version list |
| `modpacks list-files` | Pack file list |
| `modpacks mod-info <modId>` | Mod metadata from modpacks.ch (`ftb-mod-info` remains an alias) |
| `modpacks find-mod` | Find a mod across packs |

**Diagnostics**

| Command | Description |
|---------|-------------|
| `crash-log <logPath>` | Analyze a crash log file |
| `missing-deps` | Find unsatisfied declared dependencies |
| `compat-check <jarPath>` | Pre-flight compatibility check |

**Semantic Search (requires Ollama)**

| Command | Description |
|---------|-------------|
| `backfill-embeddings` | Embed docs + primers |
| `backfill-embeddings --type=source --version=<ver>` | Embed MC source |
| `backfill-embeddings --type=mod --db-id=<n>` | Embed mod source |

---

## MCP Tools Reference

All tool actions have been consolidated into **24 grouped tools** to stay within MCP client tool-count limits. Each tool takes a required `action` parameter that selects the operation, plus optional params specific to that action.

### Tool Index

| # | Tool | Actions | Description |
|---|------|---------|-------------|
| 1 | `mod` | 22 | Mod DB, decompile, source, FTS/semantic search |
| 2 | `mod_bytecode` | 16 | Mod JAR class/bytecode analysis |
| 3 | `mod_mixins` | 7 | Mixin targets, AT/AW entries, package scan |
| 4 | `platform` | 5 | Modrinth/CurseForge sync |
| 5 | `mc_versions` | 5 | MC + loader version listing/ingest |
| 6 | `mc_source` | 19 | Vanilla MC source, decompile, validate |
| 7 | `mappings` | 5 | Name mappings + Parchment |
| 8 | `docs` | 8 | Documentation CRUD + semantic search |
| 9 | `primers` | 9 | Version migration guides + semantic search |
| 10 | `mc_registry` | 7 | MC registries, blocks, commands, sounds |
| 11 | `mc_data` | 23 | Vanilla data browser (tags, recipes, biomes, …) |
| 12 | `mc_files` | 8 | MC file access via misode/mcmeta |
| 13 | `mod_jar` | 9 | Mod JAR file browser, lang, sounds, configs |
| 14 | `mod_data` | list+get × 22 types | Mod structured data (recipes, loot tables, …) |
| 15 | `mod_tags` | 8 | Cross-mod tag indexing + conflict detection |
| 16 | `mixin_scan` | 5 | Cross-mod mixin conflict analysis |
| 17 | `gradle` | 3 | Gradle build file analysis |
| 18 | `reports` | 10 report types | Markdown report generation |
| 19 | `pack_tools` | 7 | Modpack asset/data conflict analysis |
| 20 | `kubejs` | 2 | KubeJS script indexing + search |
| 21 | `modpacks_ch` | 15 | modpacks.ch / FTB / CurseForge / Modrinth / Feed The Beast pack browsing and ingest |
| 22 | `analyze_crash_log` | — | Triage crash logs against mod class index |
| 23 | `find_missing_deps` | — | Find mods with missing declared dependencies |
| 24 | `check_mod_compat` | — | Pre-flight compatibility check for a candidate JAR |

---

### 1. `mod` — Mod Database, Decompile & Source

| action | Key params | Description |
|--------|-----------|-------------|
| `ingest` | jarPath, skipSource | Add a JAR to the database. Accepts Windows paths (`C:\mods\foo.jar`) and WSL paths (`/mnt/c/mods/foo.jar`) |
| `list` | loader, mcVersion, hasMixins, decompiled, limit | List mods |
| `get` | modId | Full metadata for a mod |
| `search` | query, loader, mcVersion, limit | Search by name/description |
| `stats` | — | DB statistics |
| `dependencies` | modId, recursive | Dependency list |
| `dep_graph` | mcVersion | Full requires/requiredBy graph |
| `version_conflicts` | — | Detect duplicate modIds + unsatisfied deps |
| `source_urls` | query | GitHub/GitLab URLs from manifests |
| `decompile` | dbId, force | Bulk decompile JAR via Vineflower (background) |
| `decompile_status` | dbId | Poll background decompile job |
| `decompile_class` | modId or dbId, className, sha1? | Resolve the exact JAR and decompile a single class on demand |
| `source` | dbId, path | Browse or read decompiled source tree |
| `search_source` | query, dbId?, isRegex, limit | Text/regex search across decompiled source — omit `dbId` to search **all** decompiled mods (results include `modId` + `modVersion`) |
| `reindex` | dbId? | Re-index class names |
| `batch_ingest` | directory, skipSource, indexClasses, replace | Ingest all JARs in a directory. `replace=true` deletes any existing DB row for the same `modId` before inserting — keeps DB in sync with disk |
| `batch_decompile` | — | Decompile all not-yet-decompiled mods with concurrency control |
| `index_fts` | dbId | Index decompiled mod source into BM25/FTS. Works for all loaders — NeoForge, Fabric, Forge, Quilt. **No Ollama required.** |
| `search_indexed` | dbId, query, limit? | Fast BM25-ranked FTS search over indexed mod source |
| `index_semantic` | dbId, batchSize? | Embed decompiled source into pgvector (batched, resumable — requires Ollama). Also populates FTS index as a side-effect. |
| `search_semantic` | dbId, query, limit? | Semantic source search using Ollama + pgvector (requires Ollama) |
| `get_paths` | dbId | Return `jarPath`, `decompPath` (null if not yet decompiled), and `cacheRoot` so the agent can grep/search files natively |

### 2. `mod_bytecode` — Mod JAR Class Analysis

| action | Key params | Description |
|--------|-----------|-------------|
| `search_class` | dbId, query | Find class by name (CamelCase/prefix/substring) |
| `class_members` | dbId, className | Methods/fields with mixin targets, AT/AW strings |
| `bytecode` | dbId, className | Raw `javap` output |
| `find_refs` | dbId, target | All classes referencing a class/method/field |
| `inheritance` | dbId, className | Superclass, interfaces, subclasses |
| `diff` | dbIdA, dbIdB | Added/removed classes between two versions |
| `find_implementors` | target, modId?, limit | Find mod classes extending/implementing a target across DB |

### 3. `mod_mixins` — Mixin & Access Transformer Analysis

| action | Key params | Description |
|--------|-----------|-------------|
| `targets` | modId | MC classes a mod injects into |
| `resolve` | dbId | Parse `@Mixin` bytecode → update DB |
| `conflicts` | targetClass | All mods injecting into the same MC class |
| `at_entries` | dbId | NeoForge/Forge AT entries |
| `aw_entries` | dbId | Fabric/Quilt AW entries |

### 4. `platform` — Modrinth/CurseForge Sync

| action | Key params | Description |
|--------|-----------|-------------|
| `sync_modrinth` | dbId | Resolve a known project or JAR SHA-1 through modpacks.ch; store project ID and source URL |
| `sync_curseforge` | dbId | Resolve a known project or JAR SHA-1 through modpacks.ch; no CurseForge API key required |
| `check_updates` | dbId | Check both platforms for newer version |
| `batch_sync` | syncModrinth, syncCurseforge, downloadSources, modIdFilter, limit | Bulk sync all unmatched mods |
| `download_source` | dbId | Download GitHub/GitLab source ZIP |

### 5. `mc_versions` — Loader Version Management

| action | Key params | Description |
|--------|-----------|-------------|
| `list_mc` | type=release\|snapshot\|all | MC versions from Mojang Piston Meta |
| `list_neoforge` | mcVersion, limit | NeoForge versions from Maven |
| `list_fabric` | mcVersion, limit | Fabric API versions from Modrinth |
| `ingest_neoforge` | version, skipIndex | Download + ingest a NeoForge JAR |
| `ingest_fabric` | version, skipIndex | Download + ingest a Fabric API JAR |

### 6. `mc_source` — Vanilla MC Source & Validation

| action | Key params | Description |
|--------|-----------|-------------|
| `search_class` | version, query | Find class by name |
| `get_source` | version, className, startLine, endLine, maxLines | Read decompiled source locally or for enabled teams; public HTTP prepares a private class index and returns status only |
| `bytecode` | version, className | Raw `javap` output |
| `class_members` | version, className | Methods/fields with mixin target strings |
| `find_refs` | version, target | Classes referencing a target |
| `inheritance` | version, className | Superclass/interfaces/subclasses |
| `diff` | versionA, versionB | Added/removed classes between MC versions |
| `decompile` | version, force | Bulk decompile MC JAR (background) |
| `decompile_status` | version | Poll bulk decompile job |
| `search_code` | version, query, searchType, isRegex, limit | Regex/text search across MC source; public HTTP returns file and line only |
| `source_info` | version, className | Cached class availability and total line count, without source text |
| `index_status` | version | Full-version source index status, without source text |
| `index` | version, force | Index decompiled MC into PostgreSQL FTS |
| `search_indexed` | version, query, limit | Fast FTS search |
| `search_events` | version, query?, modloader? | Find Event subclasses in decompiled source |
| `validate_aw` | content, mcVersion | Validate Access Widener against MC JAR |
| `analyze_mixin` | source, mcVersion | Parse + validate a Mixin class |

### 7. `mappings` — Name Mappings & Parchment

| action | Key params | Description |
|--------|-----------|-------------|
| `find` | symbol, version, sourceNs, targetNs | Translate between official/intermediary/yarn/mojmap |
| `remap` | inputJar, outputJar, version, toMapping | Remap mod JAR using TinyRemapper |
| `parchment` | className, mcVersion | Community parameter names/javadocs for a class |
| `list_parchment` | mcVersion | Available Parchment builds |
| `parchment_summary` | mcVersion | Parchment coverage summary |

### 8. `docs` — Documentation Database

| action | Key params | Description |
|--------|-----------|-------------|
| `ingest` | entries[] | Add/update doc entries |
| `seed` | — | Populate built-in defaults |
| `get` | query | Look up by class name or keyword |
| `search` | query, category, namespace | Full-text search |
| `list` | category, namespace, tag, limit | List all entries |
| `delete` | id | Remove by DB id |

### 9. `primers` — Version Migration Guides

| action | Key params | Description |
|--------|-----------|-------------|
| `ingest` | entries[] | Add migration guide entries |
| `seed` | fetchContent=true | Populate the official Minecraft/Forge/NeoForge primer catalogue and cache missing guide bodies |
| `get` | id, startLine=1, maxLines=400, fetchContent=true, refresh=false | Read cached Markdown; fetch missing content automatically |
| `by_version` | fromVersion, toVersion, modloader, includeContent=false, maxChars=60000, cursor, fetchContent=true | Ordered migration steps; optionally bundle their Markdown, including vanilla changes for the selected loader |
| `search` | query, modloader, fromVersion, toVersion, limit | Full-text search |
| `list` | modloader, limit | List all primers |
| `delete` | id | Remove by DB id |

Start with `{"action":"seed"}` on a fresh database, then use `{"action":"by_version","fromVersion":"1.21.1","toVersion":"1.21.5","modloader":"neoforge"}`. This returns the vanilla and NeoForge guides for the intervening transitions. Call `{"action":"get","id":<returned id>}` for each guide, following `nextStartLine` until it is null. Guides retain headings, tables, links and code blocks; pagination does not truncate the cached document. The catalogue contains the steps published upstream, so a result is not a guarantee of coverage for every release or loader.

To read a whole migration range, request `{"action":"by_version","fromVersion":"1.21.1","toVersion":"26.1","modloader":"neoforge","includeContent":true}`. The server fetches missing bodies and returns the original Markdown with each guide's ID, title, source URL, loader and version boundaries. Small ranges fit in one response. Larger ranges return `nextCursor`; repeat the same request with `cursor` set to that value until it is null. `count` is the total number of matching guides; `primers` contains the current page. Existing calls without `includeContent` retain their metadata-only response.

Bundled pages share a `maxChars` text budget (1,000–200,000, default 60,000) and contain at most 20 guides. Long guides may span pages: concatenate `content` chunks for the same ID directly, without inserting separators. `startOffset`, `endOffset` (exclusive), `totalChars` and `contentChars` count UTF-16 code units; pagination preserves Unicode characters. Each guide reports `contentStatus` and `truncated`; the outer `truncated` reports whether another page remains. Cursors detect changes to the selected catalogue or partly read content and ask you to restart. `fetchContent:false` reads only cached bodies and reports missing ones with `contentStatus:"missing"` and a page-level `missing` count. Fetch failures retain successful guides, report `contentStatus:"fetch_failed"` and an error per failed guide, and set the page-level `failed` count and MCP error flag. Retry those IDs with `get`. The CLI equivalent is `primers by-version 1.21.1 26.1 --modloader=neoforge --include-content`, with optional `--max-chars=`, `--cursor=` and `--fetch-content=false`; fetch failures set a nonzero exit code after printing the page.

`get` and `seed` fetch missing content on the MCP server and store it in its configured database, so this also works with a remote server. Cached reads work without Internet access. Use `fetchContent:false` for metadata-only reads/seeding, or `refresh:true` on `get` to replace cached content. Fetch failures return an error; failed refreshes preserve the previous content. `ingest` still accepts supplied content or an explicit `entries[].fetchContent:true`, and reports failed entries without saving them. The CLI equivalents are `primers seed --fetch-content=false` and `primers get <id> --refresh --start-line=401`.

Existing installations repair the old built-in placeholder URLs on the first primer operation; no database reset is needed. IDs are retained where possible, and obsolete duplicates or placeholders are marked superseded with replacement guides. Custom entries and existing content are preserved.

### 10. `mc_registry` — MC Registry & Meta Data

| action | Key params | Description |
|--------|-----------|-------------|
| `blocks` | version | Block state property definitions |
| `commands` | version | Full Brigadier command tree |
| `registries` | version, registry? | All registry keys, or entries for one registry |
| `sounds` | version | sounds.json — all sound events |
| `item_components` | version | Data-driven item component definitions |
| `registry_entries` | registry, version | Full entry list from registries branch |
| `mcmeta_versions` | filter=release\|snapshot\|all | All MC versions tracked by misode/mcmeta |

### 11. `mc_data` — Vanilla Data Browser

| action | Key params | Description |
|--------|-----------|-------------|
| `tags` | version, registry, tagId, namespace | Browse vanilla tags |
| `find_tags_for` | entry, registry, version, namespace | Reverse tag lookup |
| `recipes` | version, type, outputItem | List recipes |
| `get_recipe` | recipeId, version | Recipe JSON |
| `find_recipes_for` | item, version | Reverse recipe lookup by output item |
| `loot_tables` | version, category | List loot tables |
| `get_loot_table` | path, version | Loot table JSON |
| `lang` | version, filter, limit | Search en_us.json |
| `blockstate` | block, version | Blockstate variant/model mapping |
| `model` | modelPath, version, resolveParents | Model JSON with parent chain |
| `model_tree` | modelPath, version | Full model inheritance with merged textures |
| `biomes` | version | List all biomes |
| `get_biome` | biomeId, version | Biome worldgen JSON |
| `damage_types` | version | All damage types with JSON |
| `enchantments` | version | List all enchantments |
| `get_enchantment` | id, version | Enchantment JSON |
| `advancements` | version, category | List advancements |
| `get_advancement` | id, version | Advancement JSON |
| `structures` | version | List worldgen structures |
| `get_structure` | id, version | Structure JSON |
| `particles` | version | List particle types |
| `get_particle` | id, version | Particle description JSON |
| `entity_attributes` | entity, version, modId? | Default attributes for vanilla or modded entity |

### 12. `mc_files` — MC File Access (misode/mcmeta)

| action | Key params | Description |
|--------|-----------|-------------|
| `get_data` | filePath, version, jsonOnly | Fetch a data pack file |
| `get_asset` | filePath, version, jsonOnly | Fetch a resource pack file |
| `list_files` | dirPath, version, branch | List files in a directory |
| `diff` | filePath, versionA, versionB, branch | Compare a file between two MC versions |
| `atlas` | version, atlas? | Texture atlas definitions |
| `raw` | ref, filePath | Fetch any file by git ref + path |
| `compare` | versionA, versionB, branch | GitHub compare API between two MC versions |
| `changelog` | version, branch | Files changed in a specific MC version |

### 13. `mod_jar` — Mod JAR File & Registry Access

| action | Key params | Description |
|--------|-----------|-------------|
| `list_files` | modId, prefix? | List JAR contents under an optional path prefix |
| `get_file` | modId, path | Read any file from the JAR |
| `lang` | modId, filter, limit | Translation strings from en_us.json |
| `sounds` | modId, namespace? | sounds.json — registered sound events |
| `atlas` | modId, atlas?, namespace? | Texture atlas JSON |
| `registry_entries` | modId, type, filter, limit | Items/blocks/entities via lang key inspection — no decompilation needed |

### 14. `mod_data` — Mod Structured Data

`action=list` or `action=get` combined with a `type` parameter:

| type | list returns | get returns |
|------|-------------|-------------|
| `recipe` | All recipe ids | Recipe JSON |
| `loot_table` | All loot table ids | Loot table JSON |
| `advancement` | All advancement ids | Advancement JSON |
| `blockstate` | All blockstate files | Blockstate JSON |
| `model` | All model files | Model JSON |
| `biome` | All biome ids | Biome JSON |
| `structure` | All structure ids | Structure JSON |
| `data_tag` | All tag files (+ registry param) | Tag entries JSON |
| `particle` | All particle ids | Particle JSON |
| `damage_type` | All damage type ids | Damage type JSON |
| `enchantment` | All enchantment ids | Enchantment JSON |

Common params: `modId` (required), `namespace` (optional scope), `filter` (list), `id` (get), `modelPath` (get model), `registry` (data_tag only).

### 15. `mod_tags` — Cross-Mod Tag Analysis

| action | Key params | Description |
|--------|-----------|-------------|
| `index` | modId | Scan + index tag files for one mod |
| `index_all` | — | Scan + index tags for all mods |
| `namespaces` | — | All tag namespaces + registries present |
| `contributors` | tagPath, registry? | Every mod contributing to a tag path |
| `mod_list` | modId, registry? | All tags a specific mod registers |
| `find_conflicts` | registry? | replace:true conflicts across mods |
| `search` | query, registry, limit | Substring search across tag paths |

### 16. `mixin_scan` — Cross-Mod Mixin Conflict Analysis

| action | Key params | Description |
|--------|-----------|-------------|
| `list_mods` | loader, mcVersion | All mixin mods with target class lists |
| `conflict_matrix` | loader, mcVersion, minConflicts | Classes targeted by 2+ mods |
| `class_detail` | targetClass | Every mod injecting into one class |
| `hotspots` | top, loader | Top-N most contested classes |
| `batch_resolve` | loader, mcVersion | Resolve @Mixin targets for all mixin mods |

### 17. `gradle` — Gradle Build File Analysis

| action | Key params | Description |
|--------|-----------|-------------|
| `get_files` | modId | Parsed build.gradle with deps, plugins, repos |
| `search` | query, modIdFilter, limit | Cross-mod grep with context |
| `compare_deps` | groupFilter, modIdFilter | Dependency comparison — version conflicts, embed vs compileOnly |

### 18. `reports` — Markdown Report Generation

| report | Key params | Description |
|--------|-----------|-------------|
| `mixin_conflicts` | loader, mcVersion, minConflicts | Cross-mod mixin conflict report |
| `tag_conflicts` | registry | replace:true tag conflict report |
| `version_conflicts` | — | Duplicate modId + unsatisfied deps |
| `mod_overview` | modId | Full overview for one mod |
| `gradle_deps` | groupFilter, modIdFilter | Gradle dependency comparison |
| `pack_compat` | mcVersion, loader | One-shot pack audit: mixin conflicts + AT/AW shared targets + tag conflicts + dep issues |
| `dep_graph` | mcVersion, modId? | Full dependency graph with Mermaid diagram |
| `sidedness` | mcVersion, loader | Classify all mods as client_only / client_optional / common / server_only |
| `mod_complexity` | mcVersion, loader | Rank mods by class count + mixin + AT/AW footprint |
| `pack_changelog` | oldIds[], newIds[] | Diff two pack snapshots — added/removed/updated mods |

All reports accept an optional `savePath` to write the `.md` file to disk.

### 19. `pack_tools` — Modpack Asset & Data Conflict Analysis

| action | Key params | Description |
|--------|-----------|-------------|
| `asset_conflicts` | mcVersion?, loader?, limit | Resource pack path collisions across all mods |
| `data_conflicts` | dataType?, mcVersion?, loader?, limit | Data pack path collisions (recipes, loot tables, advancements, …) |
| `vanilla_overrides` | type=asset\|data\|both, mcVersion?, loader? | Paths where mods override vanilla files |
| `complexity` | mcVersion?, loader?, limit | Rank mods by JAR entry count (complexity proxy) |
| `pack_sidedness` | mcVersion?, loader? | Classify mods by presence of client/server entry points |
| `missing_assets` | mcVersion?, loader?, limit | Mod JAR entries referencing textures/models that don't exist |
| `at_conflicts` | mcVersion?, loader? | AT/AW entries targeted by multiple mods |

### 20. `analyze_crash_log` — Crash Log Triage

Paste a NeoForge/Forge/Fabric crash log. Cross-references stack frames against the `ModClass` index and returns suspects ranked by frame count, plus coverage warning if the class index is sparse.

| param | Description |
|-------|-------------|
| `logText` | Full text of the crash report or log snippet |

### 21. `find_missing_deps` — Missing Dependency Detection

Reads all ingested mods' declared dependencies and checks each dep ID against the ingested modId set. Skips known platform-provided deps (minecraft, neoforge, forge, fabric-api, java).

| param | Description |
|-------|-------------|
| `mcVersion` | Filter to a specific MC version |
| `loader` | Filter to a specific loader |

### 22. `check_mod_compat` — Pre-flight JAR Compatibility Check

Runs a candidate JAR through 5 checks without requiring it to be ingested first:
1. Mixin target conflicts with existing mods
2. AT/AW entry overlaps
3. Asset path conflicts
4. Missing declared dependencies
5. Sidedness detection

| param | Description |
|-------|-------------|
| `jarPath` | Absolute path to the candidate mod JAR |
| `mcVersion` | Filter comparison pool to this MC version |
| `loader` | Filter comparison pool to this loader |

---

## Typical Workflows

### Ingest a modpack

```bash
# Remote MCP one-shot from modpacks.ch using CurseForge pack ID and latest/resolved version name:
modpacks_ch  action=ingest_pack  namespace=curseforge  packRef=925200  versionRef=4.8

# Or resolve names first, then ingest the returned packId/versionId:
modpacks_ch  action=resolve_pack  namespace=curseforge  packRef="All the Mods 10"  versionRef=4.8
modpacks_ch  action=ingest_pack    namespace=curseforge  packId=<resolved packId>  versionId=<resolved versionId>

# For fuzzy user input like "7.1", list versions first and use the matching row:
modpacks_ch  action=list_versions  namespace=curseforge  packRef="All the Mods 10"  versionRef=7.1

# Modrinth packs use the same flow with a slug, project ID, name, version ID, version number,
# modrinth.com URL, api.modrinth.com URL, CDN .mrpack URL, or direct HTTPS .mrpack URL:
modpacks_ch  action=list_versions  namespace=modrinth  packRef=<slug-or-project-id-or-name>  versionRef=<version-number>
modpacks_ch  action=ingest_pack  namespace=modrinth  packRef=<slug-or-project-id-or-name>  versionRef=<version-id-or-version-number>
modpacks_ch  action=ingest_pack  namespace=modrinth  packRef="https://modrinth.com/modpack/fabulously-optimized"  versionRef=6.4.0

# Official Feed The Beast API packs use namespace=feedthebeast.
# Both use modpacks.ch: namespace=ftb selects /modpack; feedthebeast selects /ftb.
modpacks_ch  action=list_versions  namespace=feedthebeast  packRef="Architect's"  versionRef=1.1
modpacks_ch  action=ingest_pack  namespace=feedthebeast  packRef="Architect's"  versionRef=1.1

# Existing local-folder fallback if you already have a mods/ directory:
node dist/cli.js batch-ingest /path/to/mods --index --replace

# 2. Resolve mixin targets (enables conflict detection)
node dist/cli.js batch-resolve-mixins

# 3. Sync Modrinth/CurseForge metadata
# (via MCP: platform action=batch_sync)

# 4. Index mod-shipped tags
# (via MCP: mod_tags action=index_all)

# 5. Ingest the loader for cross-reference
node dist/cli.js ingest-neoforge 21.1.228
```

### Run a full pack compatibility audit

```bash
# via MCP — generates a Markdown report scoped to your pack
reports  report=pack_compat  loader=neoforge  mcVersion=1.21.1  savePath=C:/reports/pack-compat.md
```

The scorecard covers: duplicate mod IDs, unsatisfied deps, mixin-conflicted classes, and tag hard conflicts. AT/AW shared targets are shown separately as informational (they can only widen access, never cause crashes).

### Pre-flight check a new mod before adding it

```bash
# via MCP — checks against all mods currently in DB, no ingestion needed
check_mod_compat  jarPath=/path/to/newmod-1.0.jar  loader=neoforge  mcVersion=1.21.1
```

### Triage a crash log

```bash
# If the pack is not already in ModLens, ingest it first so class/mod lookups
# are grounded in the exact modpack version:
modpacks_ch  action=list_versions  namespace=curseforge  packRef="All the Mods 10"  versionRef=7.1
modpacks_ch  action=ingest_pack    namespace=curseforge  packRef="All the Mods 10"  versionRef=7.1

# via MCP — paste the crash report, get ranked suspect mods
analyze_crash_log  logText="<paste full crash log here>"
```

### Find missing dependencies

```bash
# via MCP
find_missing_deps  loader=neoforge  mcVersion=1.21.1
```

### Cross-mod source search

```bash
# via MCP — grep across ALL decompiled mod sources at once
mod  action=search_source  query=LivingEntity  isRegex=false
mod  action=search_source  query="@Mixin.*LivingEntity"  isRegex=true
# Results include modId + modVersion so you know which mod each hit came from
```

### Detect mixin conflicts

```bash
# via CLI (single class)
node dist/cli.js mixin-conflicts net/minecraft/world/entity/LivingEntity

# via MCP (full matrix)
mixin_scan  action=conflict_matrix
reports  report=mixin_conflicts  savePath=C:/reports/mixin_conflicts.md
```

### Explore tag conflicts

```bash
# via MCP
mod_tags  action=index_all
mod_tags  action=find_conflicts
mod_tags  action=contributors  tagPath=c:ores/iron
```

### Explore a mod

```bash
node dist/cli.js get apotheosis
node dist/cli.js mixin-targets apotheosis
node dist/cli.js at-entries 2
node dist/cli.js decompile-class 2 com/shadows/apotheosis/mixin/LivingEntityMixin
```

### Check for updates

```bash
node dist/cli.js sync-modrinth 2
node dist/cli.js check-updates 2
```

---

## Hosted access limits

HTTP MCP (`MCP_PORT`) enables hosted limits by default; local stdio retains full access. Direct HTTP connections from RFC 1918 IPv4 peers (`10/8`, `172.16/12`, `192.168/16`) also get full tool access by default, including whole-mod and whole-Minecraft decompilation, without gateway or OAuth authentication. Set `MODLENS_RFC1918_BYPASS=0` to require normal hosted authentication and limits for these clients. Loopback and IPv6 addresses do not match this bypass.

The check uses the TCP peer address, including IPv4-mapped IPv6 addresses, and ignores claimed client IP headers. Requests carrying `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, or ModLens gateway identity headers follow normal hosted access. If a reverse proxy reaches the server from an RFC 1918 address, configure it to send a forwarding header for **every** request or disable the bypass; otherwise its public clients may appear to be private peers. Private clients must connect directly to use this allowance.

Public HTTP returns Minecraft class locations, members, references, mixin and version analysis, and source metadata, without Minecraft source text or bytecode. `source_info` reports cached line counts; `search_code` reports matching files and lines (`0` when no exact line is available). Line numbers may differ from a client's local decompilation.

The first hosted Minecraft request for a version queues private full-version decompilation and indexing. Public `get_source` prioritizes that class and returns preparation status instead of source; `index_status` reports full-version progress. Bulk commands, exports, raw JAR reads, host paths, filesystem administration, and KubeJS directory access remain unavailable to public hosted clients.

| Setting | Default | Scope |
| --- | --- | --- |
| `MODLENS_RFC1918_BYPASS` | enabled | Set to `0` to disable private-peer full access |
| `MODLENS_HOSTED_SOURCE_LINES` | 200 | Source/bytecode lines per response, shared across search snippets |
| `MODLENS_HOSTED_RESPONSE_BYTES` | 131072 (128 KiB) | Serialized text content per tool response |
| `MODLENS_HOSTED_DAILY_BYTES` | 5242880 (5 MiB) | Delivered tool content per account per UTC day |
| `MODLENS_HOSTED_PERIOD_BYTES` | 52428800 (50 MiB) | Delivered tool content per account per fixed 30-day period |
| `MODLENS_HOSTED_DAILY_REQUESTS` | 1000 | Tool calls per account per UTC day |
| `MODLENS_HOSTED_MINUTE_REQUESTS` | 120 | Tool calls per account per minute |

The byte allowance includes all successful tool content, including metadata, search snippets and bytecode. It measures UTF-8 JSON content before transport compression. Cached files and inbound upload bytes are excluded. Each source text field has a 32 KiB cap. Searches with `limit`/`top` are capped at 50 results; responses exceeding the byte limit require a narrower query.

Use `startLine` (1-based) and `maxLines` for team `mc_source get_source/bytecode`, `mod source/decompile_class`, `mod_bytecode bytecode`, and `project source/bytecode`. A range may start anywhere; the hosted cap bounds its length. Minecraft source indexes populate automatically after the first hosted request for a version. A hosted mod reader can fetch a missing JAR from modpacks.ch when it resolves one exact artifact; provide `sha1` to select a particular release. Hosted source and bytecode are checked against that JAR's licence before any content is returned. Hosted clients can upload their own Gradle environment through `project`.

To allow Minecraft source for specific teams, set `MODLENS_HOSTED_MC_SOURCE=1` and `MODLENS_HOSTED_MC_SOURCE_TEAMS` to comma-separated team IDs. This requires `MODLENS_HOSTED_PROXY_SECRET`; the authenticated gateway must inject `x-modlens-team-id` for verified members and remove caller-provided `x-modlens-*` headers. Other users retain metadata-only Minecraft access. Team access uses the same source and usage limits above. Local stdio is unaffected.

### Mod source access

Hosted mod source responses include licence and attribution notices. Use `mod_license` with `action=check` and `modId`/`dbId` to check availability. For uploaded projects, supply `projectKey`, `environmentId` and `className` instead.

Before deploying this resolver against an existing PostgreSQL or PGlite database, run `npx prisma db push` with that database's `DATABASE_URL`. This adds the nullable `mods.sha1` column and index before the new server starts. Existing SQLite databases add them during startup without replacing mod rows.

When hosted source is unavailable, `action=local_plan` provides instructions for decompiling your local JAR with your explicit consent. Run the returned request on your computer:

```bash
npx -y @creeperhost/modlens-mcp --local-mod --request-file local-request.json
```

### Bind allowances to authenticated accounts

For built-in OAuth sign-in, set `MODLENS_HOSTED_AUTH=oauth` and configure `MODLENS_OAUTH_PUBLIC_URL` (the public `/mcp` URL), `MODLENS_OAUTH_ISSUER`, `MODLENS_OAUTH_CLIENT_ID`, `MODLENS_OAUTH_SCOPES`, and a stable base64-encoded 32-byte `MODLENS_OAUTH_STORAGE_KEY`. Set `MODLENS_OAUTH_PROFILE_URL` unless provider discovery supplies a userinfo endpoint. The provider must support authorization code with S256 PKCE and refresh tokens for persistent sign-in. Register `<public origin>/oauth/upstream/callback` as the provider client's redirect URI. `MODLENS_OAUTH_CLIENT_SECRET` is optional. `MODLENS_OAUTH_SUBJECT_FIELD` defaults to `sub`; optional `MODLENS_OAUTH_REQUIRED_FIELD` and `MODLENS_OAUTH_REQUIRED_VALUE` restrict access using a profile field. The OAuth routes and well-known metadata must be reachable through the public HTTPS origin. OAuth mode does not enable hosted Minecraft source.

Dynamic client registration accepts the optional `client_name` metadata field. The consent page displays this self-reported name alongside the registered callback origin. Existing clients must register again to supply a name; clients without one appear as "Unnamed application".

OAuth clients, short-lived authorization state, grants, and tokens are stored in the configured database. A multi-replica deployment must point every replica at the same persistent database and use the same `MODLENS_OAUTH_STORAGE_KEY`; the embedded SQLite default is suitable only for a single replica. Otherwise, a browser redirect can land on a replica that cannot see the authorization created by the previous request and fail with `invalid_grant`.

The server writes structured OAuth lifecycle events to stderr with a short `flow` identifier. Failures also include an `incident` reference shown on browser-facing error pages, so one report can be matched to its server log. These events include the stage, route, status, error code, hashed client reference, and redirect origin where relevant; authorization codes, state values, PKCE material, tokens, provider profiles, and subjects are never logged.

For gateway authentication (the default HTTP mode), put an authenticated HTTPS gateway in front of the server. Set `MODLENS_HOSTED_PROXY_SECRET` to a random secret of at least 32 characters. The gateway must remove caller-provided `x-modlens-*` headers and inject:

- `x-modlens-proxy-secret`: the server's secret, never sent to clients.
- `x-modlens-user-id`: a stable, verified account identifier selected by the gateway. Reconnecting, rotating tokens, or using another client must retain this identifier.

Restrict network access to the origin to that gateway and protect the gateway-to-server connection. The server checks the secret and account on every MCP request and binds each session to its account. The gateway manages authentication and account access. Multiple login methods for one account must use the same identifier.

Without the proxy secret, callers share a single global allowance, regardless of self-asserted user IDs or tokens. This fallback provides limits, **not authentication**, and one caller can exhaust it for everyone. `MODLENS_HOSTED_LIMITS=0` disables these controls and gateway-secret checking entirely; use it only for trusted private HTTP deployments.

Usage persists in `hosted_usage` in the configured database. Checks and updates are atomic, including parallel calls; reconnects and server restarts do not reset usage. All replicas must use the same persistent database and account mapping. The 30-day periods align to Unix-epoch boundaries, rather than rolling with each request. Restoring an older database restores its older counters. Database failures reject hosted tool calls before releasing output.

## Acknowledgements

### Services & APIs
- **[CreeperHost](https://www.creeperhost.net)** — for the free [modpacks.ch](https://www.modpacks.ch) public API powering modpack search, sync, and mod downloads.
- **[Feed The Beast](https://www.feed-the-beast.com)** — for the official FTB pack catalog, accessed through modpacks.ch.
- **[Modrinth](https://modrinth.com)** — for the free [Modrinth API](https://docs.modrinth.com) powering mod search, metadata lookup, and version sync.
- **[CurseForge](https://www.curseforge.com)** — for mod and modpack hosting; metadata and release history are accessed through modpacks.ch.
- **[misode](https://github.com/misode)** — for [mcmeta](https://github.com/misode/mcmeta), the version-controlled Minecraft data repository that powers the `mc_data`, `mc_files`, and `mc_registry` tools.
- **[Mojang](https://www.minecraft.net)** — for publishing official Mojmap mappings and the Piston Meta API used for version discovery and JAR downloads.

### Modloader teams
- **[NeoForged team](https://github.com/neoforged/NeoForge)** — for NeoForge, the [NeoForge documentation](https://docs.neoforged.net) seeded into the docs database, and the [migration primer catalogue](https://docs.neoforged.net/primer/docs/) used by the primers tool.
- **[FabricMC team](https://github.com/FabricMC)** — for the [Fabric Wiki](https://fabricmc.net/wiki) and [Yarn mappings](https://github.com/FabricMC/yarn) seeded into the docs database, Intermediary mappings used by the `mappings` tool, and [mcsrc.dev](https://mcsrc.dev) whose source browsing and class analysis features inspired our `mc_source` tool.
- **[MinecraftForge team](https://github.com/MinecraftForge)** — for Forge and the API changes documented in the Forge migration primers.

### Community contributors
- **[MCPHackers](https://mcphackers.org/)** — for [RetroMCP](https://github.com/MCPHackers/RetroMCP-Java), providing the Tiny v2 mappings that enable decompilation of legacy Minecraft versions (Alpha, Beta, and pre-1.7.10 releases).
- **[ApexModder](https://github.com/ApexModder)** — for NeoForge update primers and migration guides included in the default primers database.
- **[TheIllusiveC4](https://github.com/TheIllusiveC4)** — for [Curios API](https://github.com/TheIllusiveC4/Curios), whose wiki is seeded into the docs database as a default mod API reference.
- **[ParchmentMC](https://parchmentmc.org)** — for [Parchment](https://github.com/ParchmentMC/Parchment), the community-maintained parameter names and javadocs layered on top of Mojmap used by the `mappings` tool.

### Tooling & libraries
- **[Vineflower](https://github.com/Vineflower/vineflower)** — the decompiler powering all Java source reconstruction.
- **[SpecialSource](https://github.com/md-5/SpecialSource)** — the bytecode remapper used to apply legacy SRG mappings for Minecraft 1.7.10 through 1.13.2.
- **[tiny-remapper](https://github.com/FabricMC/tiny-remapper)** — the highly optimized JAR remapping tool used to apply RetroMCP and modern mappings.
- **[SpongePowered Mixin](https://github.com/SpongePowered/Mixin)** — the Mixin framework whose annotation format the mixin-scan tool parses and analyses across mods.
- **[Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)** — the MCP server/client framework this tool is built on.
- **[Prisma](https://www.prisma.io)** — ORM powering multi-backend database support (PostgreSQL, PGlite, SQLite).
- **[pgvector](https://github.com/pgvector/pgvector)** — PostgreSQL vector extension enabling semantic search.
- **[Ollama](https://ollama.com)** — local LLM runtime used for generating semantic embeddings.
- **[Electric SQL / PGlite](https://github.com/electric-sql/pglite)** — embedded Postgres for zero-Docker deployments.
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** / **[sqlite-vec](https://github.com/asg017/sqlite-vec)** — SQLite backend and vector search extension.
- **[Zod](https://zod.dev)** — runtime schema validation for all MCP tool parameters.
- **[clack](https://github.com/bombshell-dev/clack)** — the interactive setup wizard TUI.
- **[adm-zip](https://github.com/cthackers/adm-zip)** — JAR/ZIP extraction used throughout the ingestion pipeline.

### Special thanks

A heartfelt thank you to all the members of the **ForgeCraft Discord and Minecraft server** for being a genuinely great community, for your feedback, and for supporting my development endeavours over the years. This project wouldn't be what it is without you.
