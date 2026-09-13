# Compatibility testing

Run the deterministic regressions with `npm test`. Run `npm run build` before the MCP and package checks below.

## Minecraft era matrix

`npm run test:minecraft:eras` starts a local MCP server with a fresh temporary SQLite database, home and cache. It downloads public artifacts using the application's configured source policy. Every interaction with game/mod source goes through MCP. Results and the server log are retained in the printed temporary directory.

The vanilla checks verify named class discovery, decompiled source, methods/fields, bytecode and inheritance:

| Mapping generation | Minecraft versions |
| --- | --- |
| RetroMCP, separate client/server namespaces | Beta 1.7.3, 1.2.5 |
| RetroMCP, joined mappings | 1.5.2 |
| Legacy SRG, with MCP member names where available | 1.6.4, 1.7.10, 1.8.9, 1.12.2 |
| MCPConfig TSRG | 1.13.2 |
| Official Mojang mappings | 1.16.5, 1.18.2, 1.20.1, 1.20.6, 1.21.1 |
| Unobfuscated game artifacts | 26.1.2 |

The 1.5.2 checks also verify the explicit `MinecraftServer.tick` and `IntegratedServer.tickIntegrated` mappings. This catches differences between the joined mapping's declared names and TinyRemapper's inherited-name guesses.

Real-mod checks cover metadata resolution, the compatibility action alias, download/ingestion, database identity, language discovery, indexing, members, bytecode and single-class decompilation:

| Mod | Minecraft / loader |
| --- | --- |
| Waila | 1.6.4 Forge, 1.7.10 Forge |
| JEI | 1.8.9 Forge, 1.12.2 Forge, 1.16.5 Forge, 1.20.1 Forge, 1.21.1 NeoForge |
| Sodium | 1.16.5 Fabric |

Select individual game versions or run only the mod checks:

```sh
npm run test:minecraft:eras -- b1.7.3 1.7.10 1.12.2
npm run test:minecraft:eras -- --mods
```

Set `JAVA_HOME` for the Java runtime used by remapping. Public services must be reachable. Optional `MODLENS_TEST_TOOL_CACHE` and `MODLENS_TEST_ARTIFACT_CACHE` directories are read-only seeds: the harness copies their files into its temporary cache. Credentials, live database settings, MCP server settings and automatic graph/embedding settings are removed from the test server environment. The harness retains evidence and never starts Minecraft gameplay.

## Offline format regressions

The unit suite builds small disposable JARs and mapping archives. Assertions cover the behavior that changed between eras:

- `mcmod.info` arrays, wrapper objects and bare objects from 1.2.5 through 1.12.2.
- Java 6/7/8 Forge annotations, accepted Minecraft ranges, required versus optional dependencies, version bounds and duplicate declarations.
- Legacy `FMLAT` files and folded JAR manifest headers.
- Forge `mods.toml`, JAR implementation-version substitution, early NeoForge `mods.toml` and later `neoforge.mods.toml` dependency types.
- Fabric declared mixin filenames, optional dependencies, array predicates and access wideners; Quilt metadata, dependencies and its `mixin` key.
- SRG/TSRG archives, MCP CSV names, object descriptors, CRLF mappings and consistency between version listing and source access.
- Pre-1.13 resources under `assets/`, later data packs under `data/`, and the 1.21 plural-to-singular directory changes.
- Legacy `.lang` files, JSON translations, namespace filtering and resource deduplication.
- Automatic loader inspection for unlabeled files, provider-label precedence, multiple loader declarations, pagination after filtering, artifact reuse, forced refresh, checksum failures and range-filtered update checks.

## Package validation

`npm run test:package` installs the packed npm artifact into an isolated consumer. It checks setup, the MCP handshake, SQLite bootstrap, database types, transactions and restart persistence. Run this after changes to public commands, packaging or database setup.

## Current coverage and upstream gaps

The 2026-09-13 housekeeping and loader-fallback passes verified the matrix above. An isolated copy of the committed changes built successfully and passed 523 tests across 28 files. These are selected compatibility boundaries, not an exhaustive test of every Minecraft release or mod.

The final mod matrix passed 116 MCP checks across all eight builds, including filtered search, mismatch rejection and database isolation. The installed npm-consumer checks also passed.

Some modpacks.ch historical file records, including the tested Waila releases and JEI 1.8.9, include the Minecraft version but omit the loader target. The matrix now supplies the loader filter for every release. ModLens keeps the API's version order, uses supplied loader labels, and downloads and inspects unlabeled candidate JARs before accepting a match. Result limits apply after filtering, including across pages. This also recovers a newer unlabeled file when older labeled versions exist.

The fallback is automatic for mod searches, details, downloads and provider update checks. Recovered labels carry `loaderSource: "jar"`; the artifact cache is shared with ingestion. `mod_info` returns up to 20 matches by default; its `limit` parameter allows a larger history. The MCP matrix also checks loader-filtered Waila search, rejects Waila for Fabric, and verifies that metadata inspection does not ingest candidates into the database. JARs with no recognised loader are excluded, and failed downloads or unreadable artifacts produce errors. API errors still surface, and no other metadata service supplies replacement records. Upstream labels can be populated later; they take precedence immediately when present.
