# Stability: Unify CLI and Server Tool Definitions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `src/cli.ts` and `src/server.ts` both call the same underlying tool functions (e.g. `ingestMod`, `searchMods`, `getMixinTargets`). Any change to a tool's arguments or behaviour currently requires updating BOTH files independently, creating drift risk. This plan consolidates the duplication: CLI command handlers call the same tool functions as the MCP server — no logic duplication, only argument-parsing differences.

**Scope:** This is a refactor, not a feature addition. No tool behaviour changes. The risk is primarily CLI breakage — all existing commands must continue to work.

**Approach:** 
- Audit both files to confirm which CLI commands have equivalent server tools
- Extract any CLI-specific argument coercion into thin adapters in `cli.ts` itself
- The tool functions already live in `src/tools/*.ts` — neither `cli.ts` nor `server.ts` should duplicate logic from those files

---

## Task 1: Audit CLI vs server for duplicated logic

- [ ] **Read `src/cli.ts` lines 60–250 and `src/server.ts` lines 1–150**

  For each CLI command, note whether it:
  - (A) Directly calls a tool function — already unified, no action needed
  - (B) Duplicates logic that belongs in a tool function — needs extraction
  - (C) Has no server equivalent — CLI-only, keep as-is

  Document findings as inline comments in `src/cli.ts` using `// UNIFIED`, `// DUPLICATED`, `// CLI-ONLY`.

- [ ] **Identify duplicate argument validation**

  The CLI uses `requireArg()` to validate required positional args. If `server.ts` tool handlers do no equivalent validation, they rely solely on Zod schema types. Duplicate validation logic (e.g. checking `dbId > 0`) that exists in CLI but not server is a gap.

  After this audit, the validation plan (`2026-05-15-stability-input-validation.md`) covers server-side gaps. This plan focuses on keeping CLI handlers thin.

---

## Task 2: Remove duplicate batch-ingest implementation

Both `cli.ts` and `server.ts` reference `batchIngest` (as `batch-ingest` / `batch_ingest` respectively) but the CLI implements its own `readdir` + loop before `batchIngest` was added to the tool layer.

- [ ] **Read the CLI's `batch-ingest` command handler** (search for `batch-ingest` in `src/cli.ts`)

  If the CLI is hand-rolling a `readdir` + `ingestMod` loop instead of calling `batchIngest()`:
  
  Replace the hand-rolled loop with:
  ```typescript
  case "batch-ingest": {
      const dir = requireArg(positional[0], "directory");
      const skipSource = !flags.withSource;
      const indexClasses = !!flags.indexClasses;
      const result = await batchIngest(dir, skipSource, indexClasses);
      out(result);
      break;
  }
  ```

- [ ] **Import `batchIngest` if not already imported in `src/cli.ts`**

  ```typescript
  import { ingestMod, decompileMod, reindexClasses, batchIngest } from "./tools/ingest.js";
  ```

- [ ] **Run type-check**

  ```powershell
  npx tsc --noEmit
  ```

- [ ] **Commit**

  ```powershell
  git add src/cli.ts
  git commit -m "refactor: CLI batch-ingest delegates to batchIngest() tool function"
  ```

---

## Task 3: Normalise command naming (kebab-case everywhere in CLI)

The audit found `batch_ingest` (underscore) in some server tool names and `batch-ingest` (kebab) in CLI. Standardise CLI to always use kebab-case, server to always use snake_case (as MCP tool names conventionally use underscores).

- [ ] **Verify CLI uses kebab-case for all multi-word commands**

  ```powershell
  grep -n "case \"" src/cli.ts
  ```
  Any `case "foo_bar"` in `cli.ts` should be `case "foo-bar"`.

- [ ] **Fix any inconsistencies found**

- [ ] **Commit**

  ```powershell
  git add src/cli.ts
  git commit -m "refactor: normalise CLI command naming to kebab-case"
  ```

---

## Task 4: Add missing `--help` for CLI commands

The CLI currently only shows a global help string. Individual commands have no `--help` support.

- [ ] **Add per-command help support to `src/cli.ts`**

  In the arg parser, detect `--help` as a special flag:
  ```typescript
  if (flags.help) {
      // Print per-command usage if defined, else fall through to main help
      const cmdHelp = COMMAND_HELP[command];
      if (cmdHelp) { console.log(cmdHelp); process.exit(0); }
  }
  ```

  Define `COMMAND_HELP` as a `Record<string, string>` near the top of `cli.ts`:
  ```typescript
  const COMMAND_HELP: Record<string, string> = {
      "ingest":         "Usage: ingest <jarPath> [--skip-source] [--index-classes]",
      "batch-ingest":   "Usage: batch-ingest <directory> [--with-source] [--index-classes]",
      "reindex":        "Usage: reindex [--id=<dbId>]",
      "decompile":      "Usage: decompile <dbId>",
      "decompile-status": "Usage: decompile-status <dbId>",
      "search":         "Usage: search <query> [--loader=fabric|neoforge] [--mc=<version>] [--limit=20]",
      "list":           "Usage: list [--loader=fabric|neoforge] [--mc=<version>] [--limit=50]",
      "mod":            "Usage: mod <dbId>",
      "source":         "Usage: source <dbId> [<path>]",
      "search-source":  "Usage: search-source <query> [--id=<dbId>] [--regex] [--limit=50]",
  };
  ```

  Add more entries as needed during the implementation.

- [ ] **Run type-check**

  ```powershell
  npx tsc --noEmit
  ```

- [ ] **Commit**

  ```powershell
  git add src/cli.ts
  git commit -m "feat: per-command --help strings in CLI"
  ```

---

## Task 5: Validate required args with meaningful errors

Several CLI commands silently pass `undefined` to tool functions when positional args are missing. `requireArg` exists but isn't applied everywhere.

- [ ] **Audit every `case` block in `src/cli.ts` for missing `requireArg` calls**

  Pattern: any `positional[0]` used without a preceding `requireArg(positional[0], "...")`.

- [ ] **Apply `requireArg` to all call sites that are missing it**

  Example fix:
  ```typescript
  case "source": {
      // BEFORE (fragile — if user omits dbId, Number(undefined) = NaN)
      const dbId = Number(positional[0]);
      // AFTER
      const dbId = Number(requireArg(positional[0], "dbId"));
      // ...
  }
  ```

- [ ] **Run type-check and full tests**

  ```powershell
  npx tsc --noEmit
  npm test
  ```

- [ ] **Commit**

  ```powershell
  git add src/cli.ts
  git commit -m "fix: requireArg applied to all CLI commands missing required positionals"
  ```
