# Keep tool count low via nested action dispatch

MCP tools are registered globally and some IDEs (e.g. Antigravity) enforce a hard cap on the total number of tools across **all** connected MCP servers. To stay within that cap, related capabilities are grouped under a single registered tool and dispatched internally via an `action` parameter (e.g. `{ action: "ingest" | "list" | "search" | ... }`). This is why tool files export many functions but `server.ts` registers far fewer `server.tool()` entries than there are capabilities.

**Do not split a nested tool into multiple registered tools** to clean up the switch statement — that increases the global tool count and can push users over the IDE cap. The nesting is intentional. Refactoring the internals of a tool (extracting helpers, adding a repository layer, restructuring action handlers) is fine as long as the number of `server.tool()` registrations stays the same or decreases.
