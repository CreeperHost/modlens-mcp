## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout — `CONTEXT-MAP.md` at the root points to per-context `CONTEXT.md` files. See `docs/agents/domain.md`.

### ModLens MCP

This repo **is** the ModLens MCP server. Whenever a task involves any of the following surfaces, prefer the `mcp_modlens_*` tools over manual file reads, `grep`, or CLI fallbacks:

- Searching or reading decompiled vanilla Minecraft source
- Searching or reading decompiled mod source
- Looking up mixin targets or detecting mixin conflicts across mods
- Ingesting or syncing mods from Modrinth / CurseForge / local JARs
- Listing available MC versions

**Do NOT use any CLI fallback.** If a `mcp_modlens_*` tool exists for the job, use it. Key tools: `mcp_modlens_search_mc_indexed`, `mcp_modlens_search_minecraft_code`, `mcp_modlens_get_minecraft_source`, `mcp_modlens_get_mod_source`, `mcp_modlens_get_mixin_targets`, `mcp_modlens_get_mixin_conflicts`, `mcp_modlens_sync_modrinth`, `mcp_modlens_sync_curseforge`, `mcp_modlens_ingest_mod`.
