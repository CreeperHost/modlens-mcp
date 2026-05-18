# modlens-mcp

MCP server and CLI for browsing, decompiling, and analyzing Minecraft mod JARs.

Store mod metadata, class indexes, mixin targets, AT/AW entries, and decompiled source in a local PostgreSQL database. Query everything via AI (MCP) or command line (CLI).

## Installation

### Option A — npx (recommended, no clone required)

```bash
npx @mattabase/modlens-mcp
```

On first run the setup wizard launches automatically — pick your database profile, configure Ollama (optional), and the wizard writes your MCP client config. Settings are stored in `~/.modlens/.env` and survive updates.

**Reconfigure anytime:**
```bash
npx @mattabase/modlens-mcp --setup
```

**Update to the latest version:**
```bash
npx @mattabase/modlens-mcp@latest --setup
```
This re-runs the wizard and pins the new version in your MCP client config. Your database and settings in `~/.modlens/` are untouched.

---

### Option B — git clone (for contributors / advanced users)

```bash
git clone https://github.com/Mattabase/modlens-mcp
cd modlens-mcp
npm install
npm run setup   # interactive setup wizard
npm run start   # start the server
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 22+** | Runtime for the MCP server |
| **Docker** | Runs the PostgreSQL container via `docker compose` |
| **JDK 21+** | Required for decompilation (Vineflower) and bytecode analysis (`javap`). Eclipse Adoptium recommended — auto-discovered at `C:/Program Files/Eclipse Adoptium`, `C:/Program Files/Java`, `C:/Program Files/Microsoft`, or via `JAVA_HOME` |
| **Vineflower** | Decompiler JAR — **auto-downloaded** from Maven Central on first use |
| **mcsrc-indexer.jar** | JAR bytecode indexer — **auto-downloaded** from the modlens-mcp GitHub release on first use |

**Optional environment variables:**

| Variable | Purpose |
|----------|---------|
| `CURSEFORGE_API_KEY` | CurseForge platform sync (`sync_curseforge` action) |
| `MODRINTH_TOKEN` | Modrinth API — increases rate limit for batch operations |
| `JAVA_HOME` | Override Java discovery (falls back to PATH if not set) |

---

## Docker — PostgreSQL Setup

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
git clone https://github.com/Mattabase/modlens-mcp
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

After this, the `docs` and `primers` MCP tools will have a `semantic_search` action, and the `mc_source` tool will have `search_semantic` and `index_semantic`. Semantic search is **opt-in** — if `OLLAMA_URL` is not reachable, tools fall back to keyword search automatically.

> **Note:** The `npm run db:vector` script is safe to re-run. It creates the `pgvector` extension and `embedding` columns using `IF NOT EXISTS` guards.

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

Run without arguments (or `--help`) to print the full command list.

### Quick Reference

| Command | Description |
|---------|-------------|
| `stats` | DB statistics |
| `list` | List all mods |
| `get <modId>` | Get mod metadata |
| `search <query>` | Search mods |
| `deps <modId>` | List dependencies |
| `ingest <jarPath>` | Ingest a mod JAR |
| `ingest-neoforge <version>` | Download + ingest NeoForge |
| `ingest-fabric-api <version>` | Download + ingest Fabric API |
| `batch-ingest <dir>` | Ingest all JARs in a directory |
| `reindex` | Index class names for un-indexed mods |
| `decompile <dbId>` | Decompile entire mod JAR |
| `decompile-class <dbId> <class>` | Decompile a single class |
| `source <dbId> [path]` | Browse decompiled source |
| `search-source <query>` | Search decompiled source |
| `search-class <dbId> <query>` | Search for a class by name |
| `members <dbId> <class>` | List methods and fields |
| `bytecode <dbId> <class>` | Raw javap bytecode |
| `refs <dbId> <target>` | Find references |
| `inheritance <dbId> <class>` | Inheritance chain |
| `diff <dbIdA> <dbIdB>` | Compare two mod versions |
| `mixin-targets <modId>` | MC classes this mod injects into |
| `resolve-mixins <dbId>` | Parse `@Mixin` bytecode → update DB |
| `mixin-conflicts <targetClass>` | Mods injecting into the same class |
| `at-entries <dbId>` | Access Transformer entries |
| `aw-entries <dbId>` | Access Widener entries |
| `sync-modrinth <dbId>` | Look up on Modrinth |
| `sync-curseforge <dbId>` | Look up on CurseForge |
| `check-updates <dbId>` | Check for newer versions |
| `download-source <dbId>` | Download GitHub/GitLab source |
| `mc-versions` | List Minecraft versions |
| `neoforge-versions` | List NeoForge versions |
| `fabric-api-versions` | List Fabric API versions |
| `batch-resolve-mixins` | Resolve `@Mixin` targets for all mods |

### Flags Reference

```
list               --loader=neoforge  --mc-version=1.21  --has-mixins  --decompiled  --limit=50
search             --loader=  --mc-version=  --limit=20
deps               --recursive
ingest             --skip-source  --skip-index
ingest-neoforge    --skip-index
ingest-fabric-api  --skip-index
batch-ingest       --index
reindex            --db-id=N
search-source      --db-id=N  --regex  --limit=50
mc-versions        --type=release|snapshot|all
neoforge-versions  --mc-version=1.21.1  --limit=20
fabric-api-versions  --mc-version=1.21.1  --limit=20
```

---

## MCP Tools Reference

All 155 individual tools have been consolidated into **21 grouped tools** to stay within MCP client tool-count limits. Each tool takes a required `action` parameter that selects the operation, plus optional params specific to that action.

### Tool Index

| # | Tool | Actions | Description |
|---|------|---------|-------------|
| 1 | `mod` | 16 | Mod DB, decompile, source |
| 2 | `mod_bytecode` | 7 | Mod JAR class/bytecode analysis |
| 3 | `mod_mixins` | 5 | Mixin targets, AT/AW entries |
| 4 | `platform` | 5 | Modrinth/CurseForge sync |
| 5 | `mc_versions` | 5 | MC + loader version listing/ingest |
| 6 | `mc_source` | 15 | Vanilla MC source, decompile, validate |
| 7 | `mappings` | 5 | Name mappings + Parchment |
| 8 | `docs` | 6 | Documentation CRUD |
| 9 | `primers` | 7 | Version migration guides |
| 10 | `mc_registry` | 7 | MC registries, blocks, commands, sounds |
| 11 | `mc_data` | 23 | Vanilla data browser (tags, recipes, biomes, …) |
| 12 | `mc_files` | 8 | MC file access via misode/mcmeta |
| 13 | `mod_jar` | 6 | Mod JAR generic file + registry access |
| 14 | `mod_data` | list+get × 11 types | Mod structured data (recipes, loot tables, …) |
| 15 | `mod_tags` | 7 | Cross-mod tag indexing + conflict detection |
| 16 | `mixin_scan` | 5 | Cross-mod mixin conflict analysis |
| 17 | `gradle` | 3 | Gradle build file analysis |
| 18 | `reports` | 10 report types | Markdown report generation |
| 19 | `pack_tools` | 7 | Modpack asset/data conflict analysis |
| 20 | `analyze_crash_log` | — | Triage crash logs against mod class index |
| 21 | `find_missing_deps` | — | Find mods with missing declared dependencies |
| 22 | `check_mod_compat` | — | Pre-flight compatibility check for a candidate JAR |

---

### 1. `mod` — Mod Database, Decompile & Source

| action | Key params | Description |
|--------|-----------|-------------|
| `ingest` | jarPath, skipSource | Add a JAR to the database |
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
| `decompile_class` | dbId, className | Decompile a single class on demand |
| `source` | dbId, path | Browse or read decompiled source tree |
| `search_source` | query, dbId?, isRegex, limit | Text/regex search across decompiled source — omit `dbId` to search **all** decompiled mods (results include `modId` + `modVersion`) |
| `reindex` | dbId? | Re-index class names |
| `batch_ingest` | directory, skipSource, indexClasses, replace | Ingest all JARs in a directory. `replace=true` deletes any existing DB row for the same `modId` before inserting — keeps DB in sync with disk |

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
| `sync_modrinth` | dbId | SHA-512 lookup → store project ID + source URL |
| `sync_curseforge` | dbId | Murmur2 fingerprint lookup (needs `CURSEFORGE_API_KEY`) |
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
| `get_source` | version, className, startLine, endLine, maxLines | Read decompiled source |
| `bytecode` | version, className | Raw `javap` output |
| `class_members` | version, className | Methods/fields with mixin target strings |
| `find_refs` | version, target | Classes referencing a target |
| `inheritance` | version, className | Superclass/interfaces/subclasses |
| `diff` | versionA, versionB | Added/removed classes between MC versions |
| `decompile` | version, force | Bulk decompile MC JAR (background) |
| `decompile_status` | version | Poll bulk decompile job |
| `search_code` | version, query, searchType, isRegex, limit | Regex/text search across MC source |
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
| `seed` | — | Populate built-in NeoForge/Forge/Fabric guides |
| `get` | id | Get primer by DB id |
| `by_version` | fromVersion, toVersion, modloader | All guides covering a version span |
| `search` | query, modloader, fromVersion, toVersion, limit | Full-text search |
| `list` | modloader, limit | List all primers |
| `delete` | id | Remove by DB id |

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
# 1. Ingest all mods (--replace keeps DB in sync if re-running after updates)
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

## Acknowledgements

### Services & APIs
- **[CreeperHost](https://www.creeperhost.net)** — for the free [modpacks.ch](https://www.modpacks.ch) public API powering modpack search, sync, and mod downloads.
- **[Modrinth](https://modrinth.com)** — for the free [Modrinth API](https://docs.modrinth.com) powering mod search, metadata lookup, and version sync.
- **[CurseForge](https://www.curseforge.com)** — for the [CurseForge API](https://docs.curseforge.com) powering mod and modpack browsing and sync.
- **[misode](https://github.com/misode)** — for [mcmeta](https://github.com/misode/mcmeta), the version-controlled Minecraft data repository that powers the `mc_data`, `mc_files`, and `mc_registry` tools.
- **[Mojang](https://www.minecraft.net)** — for publishing official Mojmap mappings and the Piston Meta API used for version discovery and JAR downloads.

### Modloader teams
- **[NeoForged team](https://github.com/neoforged/NeoForge)** — for NeoForge, the [NeoForge documentation](https://docs.neoforged.net) seeded into the docs database, and the migration changelogs seeded into the primers database.
- **[FabricMC team](https://github.com/FabricMC)** — for the [Fabric Wiki](https://fabricmc.net/wiki) and [Yarn mappings](https://github.com/FabricMC/yarn) seeded into the docs database, Intermediary mappings used by the `mappings` tool, and [mcsrc.dev](https://mcsrc.dev) whose source browsing and class analysis features inspired our `mc_source` tool.
- **[MinecraftForge team](https://github.com/MinecraftForge)** — for the pre-fork Forge migration changelogs (1.18.2 → 1.20.1) seeded into the primers database.

### Community contributors
- **[ApexModder](https://github.com/ApexModder)** — for NeoForge update primers and migration guides included in the default primers database.
- **[TheIllusiveC4](https://github.com/TheIllusiveC4)** — for [Curios API](https://github.com/TheIllusiveC4/Curios), whose wiki is seeded into the docs database as a default mod API reference.
- **[ParchmentMC](https://parchmentmc.org)** — for [Parchment](https://github.com/ParchmentMC/Parchment), the community-maintained parameter names and javadocs layered on top of Mojmap used by the `mappings` tool.

### Tooling & libraries
- **[Vineflower](https://github.com/Vineflower/vineflower)** — the decompiler powering all Java source reconstruction.
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

