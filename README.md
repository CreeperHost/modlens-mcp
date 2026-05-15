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

### Ingest & Catalog

| Tool | Description |
|------|-------------|
| `ingest_mod` | Ingest a single mod JAR (parse manifest, hashes, Modrinth/CurseForge lookup) |
| `batch_ingest` | Ingest all JARs in a directory; skips already-ingested files |
| `ingest_neoforge` | Download + ingest a NeoForge universal JAR by version string |
| `ingest_fabric_api` | Download + ingest a Fabric API JAR by version string |
| `reindex_classes` | Index (or re-index) class names for un-indexed mods |
| `list_mods` | List mods; filter by `loader`, `mcVersion`, `hasMixins`, `decompiled` |
| `get_mod_details` | Full metadata for a mod by DB id or modId string |
| `search_mods` | Search mods by name/id/description |
| `get_dependencies` | Dependency list for a mod (`recursive` flag for transitive) |
| `get_db_stats` | Total mods, classes, loader breakdown |
| `find_version_conflicts` | Duplicate modIds in DB + unsatisfied dep version ranges |
| `get_dependency_graph` | Full requires/requiredBy adjacency list across all mods |
| `list_mod_source_urls` | Source/GitHub URLs extracted from all ingested mods |
| `list_mod_registry_entries` | **List entities, items, blocks, enchantments, or effects registered by a mod** — reads lang file from JAR, works without decompilation. `type`: `item` \| `block` \| `entity_type` \| `enchantment` \| `effect` \| `biome` \| `all` |

### Source & Decompile

| Tool | Description |
|------|-------------|
| `decompile_mod` | Decompile entire mod JAR with Vineflower (cached) |
| `decompile_mod_status` | Check decompile progress for a mod |
| `decompile_mod_class` | Decompile a single class on demand (faster) |
| `get_mod_source` | Browse or read decompiled source files |
| `search_source` | Grep decompiled source by text or regex |

### Bytecode Analysis

| Tool | Description |
|------|-------------|
| `search_mod_class` | Find a class by name (CamelCase, prefix, substring) |
| `get_mod_class_members` | Methods, fields, annotations for a class |
| `get_mod_class_bytecode` | Raw `javap` output for a class |
| `find_mod_references` | All classes referencing a given class/method/field |
| `get_mod_inheritance` | Superclass, interfaces, subclasses |
| `diff_mod_versions` | Added/removed classes between two mod versions |
| `find_implementors` | **Find all mod classes extending/implementing a target class or interface** (DB search, requires `reindex_classes`) |

### Mixin Analysis

| Tool | Description |
|------|-------------|
| `get_mixin_targets` | MC classes a mod injects into (from DB) |
| `resolve_mixin_targets` | Parse `@Mixin` bytecode for one mod → update DB |
| `batch_resolve_mixins` | Re-resolve `@Mixin` targets for all mixin mods (run after ingest or after fixing parser) |
| `get_mixin_conflicts` | All mods injecting into a specific MC class |
| `list_mods_with_mixins` | All hasMixins=true mods with their target lists |
| `get_mixin_conflict_matrix` | Full cross-mod conflict matrix; classes targeted by 2+ mods |
| `get_mixin_class_detail` | Every mod targeting one specific class |
| `get_mixin_hotspots` | Top-N most contested MC classes |
| `get_at_entries` | Access Transformer entries for a mod |
| `get_aw_entries` | Access Widener entries for a mod |
| `analyze_mixin` | Parse + validate a mixin class against decompiled MC source |
| `validate_access_widener` | Validate an AW file against MC class definitions |
| `remap_mod_jar` | Remap a mod JAR using Tiny mappings |

### Mod Tag Analysis (JAR-Shipped Tags)

| Tool | Description |
|------|-------------|
| `index_mod_tags` | Scan one mod's JAR for `data/<ns>/tags/…` files → DB |
| `index_all_mod_tags` | Scan all ingested mods for tag files → DB |
| `list_tag_namespaces` | All distinct tag namespaces+registries across mods |
| `get_tag_contributors` | Every mod contributing to `#c:ores/iron` etc.; flags `replace:true` conflicts |
| `get_mod_tag_list` | All tags a specific mod registers, optionally filtered by registry |
| `find_tag_conflicts` | Hard conflicts (2+ mods with `replace:true`) + soft conflicts (one replacer silences others) |
| `search_mod_tags` | Substring search across all tag paths |

### Mod JAR Data (Parity with Vanilla Data Tools)

Reads data/asset files directly from a mod JAR — no decompilation needed. Full parity with the vanilla data tools.

| Tool | Vanilla Equivalent | Description |
|------|-------------------|-------------|
| `list_mod_jar_files` | `list_mc_data_files` | List all files under a path prefix in the mod JAR |
| `get_mod_jar_file` | `get_mc_data_file` / `get_mc_asset_file` | Read any file from the mod JAR by internal path |
| `list_mod_recipes` | `list_recipes` | All recipes shipped in the JAR |
| `get_mod_recipe` | `get_recipe` | Full JSON for a specific recipe |
| `list_mod_loot_tables` | `list_loot_tables` | All loot tables |
| `get_mod_loot_table` | `get_loot_table` | Full JSON for a loot table |
| `list_mod_advancements` | `list_advancements` | All advancements |
| `get_mod_advancement` | `get_advancement` | Full JSON for an advancement |
| `list_mod_blockstates` | _(list)_ | All blockstate files |
| `get_mod_blockstate` | `get_blockstate` | Blockstate variant/model mapping |
| `list_mod_models` | _(list)_ | All model JSON files |
| `get_mod_model` | `get_mc_model` | Model JSON from the JAR |
| `list_mod_biomes` | `list_biomes` | All worldgen biomes |
| `get_mod_biome` | `get_biome` | Full JSON for a biome |
| `list_mod_structures` | `list_structures` | All worldgen structures |
| `get_mod_structure_data` | `get_structure_data` | Full JSON for a worldgen structure |
| `get_mod_lang` | `get_lang_entries` | Translation strings with optional filter |
| `get_mod_sounds` | `get_mc_sounds` | sounds.json — all registered sound events |
| `list_mod_data_tags` | `get_mc_tags` | Data-pack tag files; filter by registry |
| `get_mod_data_tag` | `get_mc_tags` | Entries for a specific tag |
| `list_mod_particles` | `get_mc_particles` | All particle description files |
| `get_mod_particle` | `get_particle_data` | Description JSON for a specific particle |
| `list_mod_damage_types` | `list_damage_types` | All damage type data files |
| `get_mod_damage_type` | _(get)_ | Full JSON for a damage type |
| `get_mod_atlas` | `get_mc_atlas` | Texture atlas JSON |
| `list_mod_enchantments` | `list_enchantments` | Enchantment data files (1.21+; use `list_mod_registry_entries` for older mods) |
| `get_mod_enchantment` | `get_enchantment` | Full JSON for an enchantment |
| `list_mod_registry_entries` | `get_mc_registry_entries` | Items/blocks/entities/effects from lang file — works without decompilation |

### Gradle Analysis

| Tool | Description |
|------|-------------|
| `get_mod_gradle_files` | Parse `build.gradle[.kts]` for a mod: deps, plugins, repos |
| `search_gradle_files` | Cross-mod grep across all gradle files with context |
| `compare_gradle_deps` | Dependency comparison matrix; flags version conflicts |

### Platform Integration

| Tool | Description |
|------|-------------|
| `sync_modrinth` | SHA-512 lookup → store `modrinthId` + `sourceUrl` |
| `sync_curseforge` | Murmur2 lookup → store `curseforgeId` + `sourceUrl` (needs `CURSEFORGE_API_KEY`) |
| `batch_sync_sources` | Run Modrinth + CurseForge lookups for all unmatched mods; optionally download GitHub source ZIPs |
| `check_updates` | Check Modrinth/CurseForge for newer versions |
| `download_source` | Download GitHub/GitLab source ZIP for a mod |

### Minecraft Source & Mappings

| Tool | Description |
|------|-------------|
| `index_minecraft_version` | Index a Minecraft version's classes for search |
| `decompile_minecraft_version` | Decompile a full MC version with Vineflower |
| `decompile_minecraft_version_status` | Check decompile progress |
| `get_minecraft_source` | Browse/read decompiled MC source |
| `search_minecraft_code` | Grep decompiled MC source |
| `search_events` | **Find Event subclasses** in decompiled MC source; optional name filter (`Living`, `Player`, etc.) |
| `search_minecraft_class` | Find an MC class by name |
| `search_mc_indexed` | Full-text search across indexed MC classes |
| `get_mc_class_members` | Methods + fields for an MC class |
| `get_mc_class_bytecode` | Raw bytecode for an MC class |
| `get_mc_inheritance` | Inheritance chain for an MC class |
| `find_mc_references` | Find MC classes referencing a target |
| `diff_minecraft_versions` | Class-level diff between two MC versions |
| `compare_mc_versions` | Side-by-side MC version comparison |
| `find_mapping` | Look up a class/method/field mapping (Mojmap, Intermediary, Yarn) |
| `get_parchment` | Parchment parameter/javadoc mappings for a class |
| `get_parchment_summary` | Parchment coverage summary for a version |
| `list_parchment_versions` | Available Parchment mapping versions |

### Vanilla Data (requires indexed MC version)

| Tool | Description |
|------|-------------|
| `get_mc_tags` | Vanilla tag entries (e.g. `minecraft:mineable/pickaxe`) |
| `find_tags_for_entry` | Which tags contain a given registry entry |
| `get_recipe` | Recipe JSON by id |
| `list_recipes` | All recipes, filter by type/result |
| `find_recipes_for_item` | **Reverse recipe lookup** — find all recipes whose output is a given item |
| `get_loot_table` | Loot table JSON |
| `list_loot_tables` | All loot tables |
| `get_lang_entries` | Translation strings |
| `get_blockstate` | Blockstate definition |
| `get_mc_model` | Block/item model JSON |
| `get_model_tree` | **Full model parent chain** — follows all `parent` refs, returns merged texture map |
| `get_mc_atlas` | Texture atlas JSON |
| `get_biome` | Biome JSON data |
| `list_biomes` | All biomes |
| `get_damage_types` (via `list_damage_types`) | Damage type registry entries |
| `get_enchantment` | Enchantment data |
| `list_enchantments` | All enchantments |
| `get_advancement` | Advancement JSON |
| `list_advancements` | All advancements |
| `list_structures` | **All vanilla worldgen structures** (`data/minecraft/worldgen/structure/`) |
| `get_structure_data` | **Full JSON for a worldgen structure** |
| `get_mc_particles` | **List all vanilla particle types** |
| `get_particle_data` | **Description JSON for a specific particle** |
| `get_entity_attributes` | **Default attributes for vanilla or modded entities** — mcmeta data pack, built-in table, or decompiled source search for modded |
| `get_mc_blocks` | Block registry |
| `get_mc_commands` | Command tree |
| `get_mc_item_components` | Item component schemas |
| `get_mc_registries` | All MC registries |
| `get_mc_registry_entries` | Entries for any registry (block, item, entity_type, biome, …) |
| `list_mc_entities` | **All vanilla entity types** — shortcut for `get_mc_registry_entries(entity_type)` |
| `list_mc_items` | **All vanilla items** — shortcut for `get_mc_registry_entries(item)` |
| `get_mc_sounds` | Sound event list |
| `get_mc_asset_file` | Raw asset file from MC jar |
| `get_mc_data_file` | Raw data file from MC jar |
| `list_mc_data_files` | List all data files |
| `diff_mc_data` | Diff a data file between two MC versions |
| `get_mcmeta_versions` | Version list from version.json |
| `get_mcmeta_raw` | Raw version manifest data |
| `get_version_changelog` | Changelog for an MC version |

### Versions

| Tool | Description |
|------|-------------|
| `list_mc_versions` | Minecraft versions from Mojang Piston Meta |
| `list_neoforge_versions` | NeoForge versions from Maven |
| `list_fabric_api_versions` | Fabric API versions from Modrinth |

### Documentation & Primers

| Tool | Description |
|------|-------------|
| `ingest_documentation` | Store documentation entries for AI retrieval |
| `get_documentation` | Retrieve a documentation entry |
| `search_documentation` | Search documentation entries |
| `list_documentation` | List all documentation entries |
| `delete_documentation` | Delete a documentation entry |
| `seed_default_documentation` | Seed built-in modding documentation |
| `ingest_primer` | Store a primer (structured tutorial/reference) |
| `get_primer` | Retrieve a primer by id |
| `search_primers` | Search primers |
| `list_primers` | List all primers |
| `get_primers_by_version_range` | Primers applicable to a MC version range |
| `delete_primer` | Delete a primer |
| `seed_default_primers` | Seed built-in modding primers |

### Reports

| Tool | Description |
|------|-------------|
| `generate_report` | Generate a Markdown report. Types: `mixin_conflicts`, `tag_conflicts`, `version_conflicts`, `mod_overview`, `gradle_deps`. Optional `savePath` to write to disk. |

---

## Typical Workflows

### Ingest a modpack

```bash
# 1. Ingest all mods
node dist/cli.js batch-ingest /path/to/mods --index

# 2. Resolve mixin targets (enables conflict detection)
node dist/cli.js batch-resolve-mixins

# 3. Sync Modrinth/CurseForge metadata
# (via MCP: batch_sync_sources)

# 4. Index mod-shipped tags
# (via MCP: index_all_mod_tags)

# 5. Ingest the loader for cross-reference
node dist/cli.js ingest-neoforge 21.1.228
```

### Detect mixin conflicts

```bash
# via CLI (single class)
node dist/cli.js mixin-conflicts net/minecraft/world/entity/LivingEntity

# via MCP (full matrix)
get_mixin_conflict_matrix
generate_report  report=mixin_conflicts  savePath=C:/reports/mixin_conflicts.md
```

### Explore tag conflicts

```bash
# via MCP
index_all_mod_tags
find_tag_conflicts
get_tag_contributors  tagPath=c:ores/iron
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


| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `jarPath` | string | — | Absolute path to the mod `.jar` file |
| `skipSource` | boolean | `false` | Skip Modrinth/CurseForge source lookup |

