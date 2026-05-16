# ModLens Companion Mod — Design Spec
**Date:** 2026-05-15  
**Status:** Approved — pending implementation plan  
**Author:** Brainstorming session

---

## 1. Overview

ModLens currently operates entirely on static artefacts — JAR bytecode, Prisma DB, decompiled sources. The companion mod bridges that to **live runtime state**: what is actually loaded, running, and behaving in a real game instance. It exposes this via three communication channels and accepts bidirectional commands from modlens-mcp.

---

## 2. Repositories

| Repo | Loaders | MC versions (branches) |
|------|---------|------------------------|
| `Mattabase/modlens-companion-neoforge` | NeoForge | `mc-26.1.2`, `mc-1.21.1` |
| `Mattabase/modlens-companion-fabric` | Fabric | `mc-26.1.2`, `mc-1.21.1` |

Both repos use **Architectury** (same multiloader pattern as DisCraftHonored): common logic in `common/`, loader-specific in `neoforge/` and `fabric/` subprojects. GitHub Actions builds both loader JARs on push and attaches them to a release tagged `mc-<mcVersion>-<modVersion>` (e.g. `mc-26.1.2-1.0.0`).

modlens-mcp maps `(mcVersion, loader)` → GitHub release asset URL → downloads the matching JAR.

---

## 3. Communication Channels

### 3.1 Embedded HTTP Server (primary)
- Binds to `127.0.0.1:<port>` (default `25580`, configurable)
- All requests require `Authorization: Bearer <token>` header
- **Token lifecycle:** on first startup the mod generates a random 32-byte hex token, writes it to `<gameDir>/.modlens/token.txt`. modlens-mcp reads this file to authenticate. File is gitignored.
- Used for all live on-demand queries and MCP→companion commands

### 3.2 File Dumps
- Output directory: `<gameDir>/.modlens/dumps/`
- Used for large one-shot exports (full registry, full recipe set, event listener map)
- MCP triggers a dump via HTTP `POST /dump/<type>`, then polls for the output file
- Files named `<type>-<timestamp>.json` so multiple captures coexist

### 3.3 RCON Bridge
- When RCON is enabled on a dedicated server, modlens-mcp can invoke `/modlens dump <type>` which writes a file dump; MCP then reads the result
- Useful for headless dedicated server scenarios where the HTTP server may not be reachable

### 3.4 Explicit Install Path
- User can always specify an explicit `targetDir` to override auto-detection

---

## 4. Companion Mod — HTTP API

All endpoints are under `http://localhost:25580/` (port configurable).  
All require `Authorization: Bearer <token>`.  
All return `Content-Type: application/json`.

### 4.1 Raw Tier — Full Live Data

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| GET | `/raw/registry` | `type=item\|block\|entity\|fluid\|...` | All entries in a live registry including modded |
| GET | `/raw/tags` | `registry=item\|block\|...` | Fully resolved tag → member list after all overrides |
| GET | `/raw/recipes` | `type=crafting\|smelting\|...` | All loaded recipes after KubeJS/datapacks applied |
| GET | `/raw/loot` | `table=<resource_location>` | Single resolved loot table |
| GET | `/raw/configs` | — | All loaded mod configs + current values |
| GET | `/raw/event-listeners` | — | All registered event listener classes + priorities |
| GET | `/raw/capabilities` | — | Capability registration map |
| GET | `/raw/network-log` | `limit=N` | Last N packets sent/received (circular buffer, configurable size) |
| GET | `/raw/loaded-mods` | — | Runtime mod list with actual loaded versions |
| POST | `/dump/<type>` | — | Trigger async file dump for large exports (`registry`, `recipes`, `tags`, `all`) |

### 4.2 Smart Tier — Pre-Processed / Expensive

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| GET | `/smart/tag-conflicts` | — | Tags with `replace:true` fights — resolved winner + losers |
| GET | `/smart/recipe-conflicts` | — | Recipes producing same output from different sources |
| POST | `/smart/tracy/start` | `duration?=seconds` | Start a Tracy profiler capture session |
| POST | `/smart/tracy/stop` | — | Stop capture, write `.tracy` to `.modlens/profiler/` |
| GET | `/smart/tracy/status` | — | Is capture running, elapsed time, output path |
| GET | `/smart/spark/summary` | — | Relay Spark tick health + hotspot summary if Spark present (graceful no-op if absent) |
| GET | `/smart/perf/snapshot` | — | Tick times per mod (via JFR `/perf` data), entity counts, chunk counts |
| GET | `/smart/logs/structured` | `limit=N` | Last N log entries parsed into `{level, logger, message, throwable}` |
| GET | `/smart/logs/errors` | `since=<timestamp>` | Only ERROR/WARN entries since timestamp (delta mode) |
| GET | `/smart/thread-dump` | — | JVM thread dump — all threads with stack traces, useful for deadlock / tick-freeze diagnosis |

---

## 5. MCP → Companion Commands

These are write/control operations sent from modlens-mcp to the companion.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/cmd/run` | `{"command": "/reload"}` | Execute a server command (RCON-equivalent without RCON setup) |
| POST | `/cmd/screenshot` | — | Trigger screenshot, return PNG bytes as base64 in response |
| POST | `/inject/recipe` | `{recipe JSON}` | Inject a recipe into the live game volatile overlay (cleared on `/reload`) |
| POST | `/inject/tag` | `{registry, tag, entries[]}` | Inject tag entries into the live volatile overlay |
| POST | `/inject/loot` | `{table, overrideJson}` | Inject a loot table override into the volatile overlay |
| DELETE | `/inject/all` | — | Clear all volatile injections |
| POST | `/config/set` | `{modId, key, value}` | Hot-modify a loaded mod config value at runtime |
| POST | `/watch/event` | `{eventClass, durationSeconds, maxEntries}` | Subscribe to an event class — companion buffers occurrences |
| GET | `/watch/event` | `{subscriptionId}` | Poll buffered event captures |
| DELETE | `/watch/event` | `{subscriptionId}` | Cancel an event watch subscription |
| POST | `/watch/alert` | `{type: "block_place\|log_error\|...", filter}` | Register a one-shot alert (fires once, then auto-cancels) |
| GET | `/watch/alerts` | — | Check if any one-shot alerts have fired |

---

## 6. modlens-mcp Side — New Tools

### 6.1 `companion_install`

Downloads and installs the companion JAR for a given MC version and loader.

**Auto-detection logic (in order):**
1. If `gradleProject` path contains `build.gradle` or `settings.gradle` → install to `<gradleProject>/run/mods/` (create if missing)
2. If `packInstance` path contains `mods/` folder → install there  
3. If explicit `targetDir` given → install there
4. If none match → return error with instructions

**Params:**
```
mcVersion      string   required  e.g. "26.1.2" or "1.21.1"
loader         string   required  "neoforge" | "fabric"
gradleProject  string?  optional  Absolute path to a Gradle mod project root
packInstance   string?  optional  Absolute path to a pack instance (Prism/CurseForge/MultiMC)
targetDir      string?  optional  Explicit absolute path to drop the JAR
force          boolean? optional  Re-download even if version matches
```

**Actions:** Fetches latest release asset from the appropriate GitHub repo matching `mc-<mcVersion>-*`, verifies SHA256, places JAR, returns installed path and version.

### 6.2 `companion`

Communicates with a running companion mod instance.

**Params:**
```
action         string   required  One of the action enum values below
host           string?  default "localhost"
port           number?  default 25580
tokenFile      string?  default ".modlens/token.txt" relative to gameDir or project
gameDir        string?  Path to game dir (used to resolve tokenFile default)
-- action-specific --
registry       string?  Registry type for /raw/registry
tagRegistry    string?  Registry for /raw/tags
recipeType     string?  Recipe type filter
lootTable      string?  Loot table resource location
limit          number?  Max entries for log/network/registry endpoints
command        string?  Server command for cmd_run
dumpType       string?  Type for file_dump
eventClass     string?  Fully qualified event class for watch_event
durationSecs   number?  Watch duration in seconds
alertType      string?  Alert type for watch_alert
alertFilter    string?  Filter expression for alert
subscriptionId string?  ID returned by watch_event/watch_alert
injectPayload  string?  JSON string for inject_* actions
configModId    string?  Mod id for config_set
configKey      string?  Config key for config_set
configValue    string?  Config value (serialized as string) for config_set
tracyDuration  number?  Tracy capture duration in seconds
```

**Action enum:**
`ping`, `loaded_mods`, `registry`, `tags`, `recipes`, `loot`, `configs`, `event_listeners`, `capabilities`, `network_log`, `file_dump`,
`tag_conflicts`, `recipe_conflicts`, `spark_summary`, `perf_snapshot`, `logs`, `log_errors`, `thread_dump`,
`tracy_start`, `tracy_stop`, `tracy_status`,
`cmd_run`, `screenshot`,
`inject_recipe`, `inject_tag`, `inject_loot`, `inject_clear`,
`config_set`,
`watch_event`, `watch_event_poll`, `watch_event_cancel`,
`watch_alert`, `watch_alerts_check`

---

## 7. Companion Mod Config

`modlens.toml` / `modlens.json` in the game's config dir:

```toml
[server]
port = 25580
enabled = true
network_log_buffer = 500   # max packets to keep in circular buffer

[tracy]
output_dir = ".modlens/profiler"
max_capture_seconds = 120

[spark]
enabled = true   # false to disable even if Spark is present

[inject]
allow_volatile_recipes = true
allow_volatile_tags = true
allow_volatile_loot = true

[watch]
max_event_buffer = 1000
max_subscriptions = 10
```

---

## 8. GitHub Actions CI

Each repo gets a workflow that:
1. Builds with Gradle on push to any `mc-*` branch
2. Produces `modlens-companion-<loader>-mc<mcVersion>-<modVersion>.jar`
3. Creates/updates a GitHub release tagged `mc-<mcVersion>-<modVersion>`
4. Attaches JAR + `sha256.txt` as release assets

modlens-mcp's `companion_install` uses `GET https://api.github.com/repos/Mattabase/modlens-companion-<loader>/releases` filtered by tag prefix to find the right asset.

---

## 9. Out of Scope for v1

- WebSocket streaming (event subscriptions use poll model in v1)
- Remote (non-localhost) companion access
- World/chunk snapshot endpoints
- Automated test harness integration

---

## 10. Open Questions / Risks

- Tracy integration requires the game to be launched with `-agentlib:TracyAgent` or similar JVM arg — the companion mod can detect whether Tracy is available at startup and report gracefully if not. Need to verify Tracy's Java API surface for MC 26.1.2 and 1.21.1.
- Fabric has no unified event system like NeoForge's event bus — the `event_listeners` endpoint will need loader-specific implementations. Common interface will return a normalized list.
- Volatile injection overlay needs to hook into the recipe manager / tag loader reload cycle to correctly wipe on `/reload` — approach differs between loaders.
