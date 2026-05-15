# modlens-mcp

MCP server and CLI for browsing, decompiling, and analyzing Minecraft mod JARs.

Store mod metadata, class indexes, mixin targets, AT/AW entries, and decompiled source in a local PostgreSQL database. Query everything via AI (MCP) or command line (CLI).

## Prerequisites

- **Node.js 22+**
- **Docker** (for PostgreSQL)
- **JDK 21+** (Eclipse Adoptium recommended — `findJava()` scans `C:/Program Files/Eclipse Adoptium` first)
- A CurseForge API key (optional — needed only for `sync-curseforge`)

## Setup

```bash
git clone https://github.com/Mattabase/modlens-mcp
cd modlens-mcp
npm install

# Start PostgreSQL
docker compose up -d

# Create .env
echo DATABASE_URL=postgresql://modlens:modlens@localhost:5433/modlens > .env
# echo CURSEFORGE_API_KEY=<your key> >> .env   # optional

# Apply schema
npx prisma db push

# Build
npm run build
```

## MCP Configuration

Add to your MCP config (`mcp.json`):

```json
{
  "modlens": {
    "command": "node",
    "args": ["D:/Downloads/modlens-mcp/dist/server.js"],
    "env": {
      "DATABASE_URL": "postgresql://modlens:modlens@localhost:5433/modlens"
    }
  }
}
```

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

All 155 individual tools have been consolidated into **18 grouped tools** to stay within MCP client tool-count limits. Each tool takes a required `action` parameter that selects the operation, plus optional params specific to that action.

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
| 18 | `reports` | 5 report types | Markdown report generation |

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
| `search_source` | query, dbId, isRegex, limit | Text/regex search across decompiled source |
| `reindex` | dbId? | Re-index class names |
| `batch_ingest` | directory, skipSource, indexClasses | Ingest all JARs in a directory |

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

All reports accept an optional `savePath` to write the `.md` file to disk.

---

## Typical Workflows

### Ingest a modpack

```bash
# 1. Ingest all mods
node dist/cli.js batch-ingest /path/to/mods --index

# 2. Resolve mixin targets (enables conflict detection)
node dist/cli.js batch-resolve-mixins

# 3. Sync Modrinth/CurseForge metadata
# (via MCP: platform action=batch_sync)

# 4. Index mod-shipped tags
# (via MCP: mod_tags action=index_all)

# 5. Ingest the loader for cross-reference
node dist/cli.js ingest-neoforge 21.1.228
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

