# Multi-action tools to cap MCP tool count

Many MCP clients (IDEs, agent runtimes) impose a hard limit on the number of tools they will load — typically 16–32. Exposing every domain operation as its own MCP tool would exceed these limits.

Instead, related operations are grouped into a single MCP tool with an `action` parameter dispatched via a switch statement in `server.ts`. This keeps the visible tool count to roughly 15 while still exposing 50+ distinct operations.

**Consequence**: `server.ts` intentionally looks like a god file. Do not refactor the mega-tool pattern into per-operation tools without first verifying the target client has no tool-count ceiling.
