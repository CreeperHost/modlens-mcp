# P5 — Profiles Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** P1, P2, P3, P4 all complete.

**Goal:** Rewrite `src/setup.ts` to add a profile picker. On fresh install the first prompt is "Choose a profile." On reconfigure, the wizard detects the active profile from `DATABASE_URL` and offers Full wizard / Pick tasks / Switch profile. Switch profile triggers an automatic backup (P4), optional migration (P4), and optional cleanup.

**Architecture:** Profiles are objects that carry a label, hint, backend type, and a list of setup sections to execute. The profile is persisted in `.env` as `MODLENS_PROFILE=<name>`. The existing `sections: Set<Section>` flow is kept — profiles just pre-fill the set.

---

## Profile Definitions

| Name | Label | Backend | Sections | Notes |
|------|-------|---------|----------|-------|
| `full` | Full power (recommended) | postgres | all | Docker + semantic optional |
| `zero-friction` | Zero-friction (PGlite) | pglite | schema, pgvector, seed, backfill, mcp | No Docker required |
| `lightweight` | Lightweight (SQLite) | sqlite | schema, seed, mcp | No Docker, no semantic |
| `standard` | Standard (Postgres, no semantic) | postgres | containers, schema, pgvector, seed, mcp | Docker, no Ollama |
| `existing` | Existing Postgres server | postgres | schema, pgvector, seed, backfill, mcp | User supplies URL |
| `custom` | Custom | any | user chooses | Current multiselect flow |

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/setup.ts` | Modify | Add profile picker, Switch profile flow |

No other files change. `scripts/backup.mjs` and `scripts/migrate-backend.mjs` are imported from P4.

---

### Task 1: Add profile types and constants

**Files:**
- Modify: `src/setup.ts`

- [ ] **Step 1: Add the `Profile` type and `PROFILES` map near the top of the file**

Insert after the `Section` type definition:

```typescript
type ProfileName = "full" | "zero-friction" | "lightweight" | "standard" | "existing" | "custom";

interface Profile {
    name: ProfileName;
    label: string;
    hint: string;
    backend: "postgres" | "pglite" | "sqlite";
    sections: Section[];
    requiresDocker: boolean;
}

const PROFILES: Record<ProfileName, Profile> = {
    "full": {
        name: "full",
        label: "Full power  — Docker Postgres + optional semantic search",
        hint: "recommended",
        backend: "postgres",
        sections: ["containers", "semantic", "schema", "pgvector", "seed", "backfill", "mcp"],
        requiresDocker: true,
    },
    "zero-friction": {
        name: "zero-friction",
        label: "Zero-friction  — PGlite (embedded Postgres, no Docker required)",
        hint: "great for solo use or CI",
        backend: "pglite",
        sections: ["schema", "pgvector", "seed", "backfill", "mcp"],
        requiresDocker: false,
    },
    "lightweight": {
        name: "lightweight",
        label: "Lightweight  — SQLite (fully embedded, no Docker, no semantic search)",
        hint: "smallest footprint",
        backend: "sqlite",
        sections: ["schema", "seed", "mcp"],
        requiresDocker: false,
    },
    "standard": {
        name: "standard",
        label: "Standard  — Docker Postgres, no semantic search",
        hint: "good default if Ollama is unavailable",
        backend: "postgres",
        sections: ["containers", "schema", "pgvector", "seed", "mcp"],
        requiresDocker: true,
    },
    "existing": {
        name: "existing",
        label: "Existing Postgres server  — connect to a running Postgres instance",
        hint: "bring your own database",
        backend: "postgres",
        sections: ["schema", "pgvector", "seed", "backfill", "mcp"],
        requiresDocker: false,
    },
    "custom": {
        name: "custom",
        label: "Custom  — choose individual steps",
        hint: "power users",
        backend: "postgres",   // overridden by user input
        sections: [],          // filled by multiselect
        requiresDocker: false, // determined by user input
    },
};

function detectProfileFromUrl(url: string): ProfileName | null {
    if (!url) return null;
    if (url.startsWith("pglite://") || url.startsWith("pglite:")) return "zero-friction";
    if (url.startsWith("file:") || url.endsWith(".db")) return "lightweight";
    return null; // postgres — could be any of full/standard/existing/custom
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors (new types don't change runtime behavior yet).

---

### Task 2: Rewrite the intro and fresh install profile picker

**Files:**
- Modify: `src/setup.ts`

- [ ] **Step 1: Replace the fresh-install `sections = new Set(ALL_SECTIONS)` block**

The current code:
```typescript
if (!isReconfigure) {
    // Fresh install: run all steps
    sections = new Set(ALL_SECTIONS);
} else {
    // ... reconfigure block
}
```

Replace the entire `if (!isReconfigure)` branch (fresh install path) with:

```typescript
if (!isReconfigure) {
    // ── Fresh install: profile picker ─────────────────────────────────────────
    const profileChoice = await p.select<ProfileName>({
        message: "Choose a setup profile",
        options: Object.values(PROFILES).map(pr => ({
            value: pr.name,
            label: pr.label,
            hint: pr.hint,
        })),
    });
    checkCancel(profileChoice);
    selectedProfile = profileChoice as ProfileName;

    if (selectedProfile === "custom") {
        // Custom: use full multiselect (existing flow)
        sections = new Set(ALL_SECTIONS);
    } else if (selectedProfile === "existing") {
        // Ask for the Postgres URL before proceeding
        const url = await p.text({
            message: "Enter your Postgres connection URL",
            placeholder: "postgresql://user:password@host:5432/modlens",
            validate: v => (v ?? "").startsWith("postgresql://") || (v ?? "").startsWith("postgres://")
                ? undefined
                : "Must be a postgresql:// URL",
        });
        checkCancel(url);
        writeEnv({ ...readEnv(), DATABASE_URL: url as string });
        sections = new Set(PROFILES["existing"].sections);
    } else if (selectedProfile === "zero-friction") {
        // Ask for data directory
        const defaultDir = join(homedir(), ".modlens-data");
        const dataDir = await p.text({
            message: "PGlite data directory (created if it does not exist)",
            initialValue: defaultDir,
        });
        checkCancel(dataDir);
        writeEnv({ ...readEnv(), DATABASE_URL: `pglite://${dataDir as string}` });
        sections = new Set(PROFILES["zero-friction"].sections);
    } else if (selectedProfile === "lightweight") {
        // Ask for SQLite file path
        const defaultFile = join(homedir(), ".modlens-data", "modlens.db");
        const dbFile = await p.text({
            message: "SQLite database file path (created if it does not exist)",
            initialValue: defaultFile,
        });
        checkCancel(dbFile);
        writeEnv({ ...readEnv(), DATABASE_URL: `file:${dbFile as string}` });
        sections = new Set(PROFILES["lightweight"].sections);
    } else {
        // full / standard — Postgres via Docker
        sections = new Set(PROFILES[selectedProfile].sections);
    }
    // Save selected profile
    writeEnv({ ...readEnv(), MODLENS_PROFILE: selectedProfile });
```

Note: `selectedProfile` must be declared as `let selectedProfile: ProfileName = "full";` before the `if (!isReconfigure)` block.

Import `homedir` from `"os"` and `join` from `"path"` at the top of the file (likely already present).

---

### Task 3: Rewrite the reconfigure branch to add Switch profile

**Files:**
- Modify: `src/setup.ts`

- [ ] **Step 1: Read current profile from env in the reconfigure intro block**

Replace the existing `if (isReconfigure)` intro block with:

```typescript
if (isReconfigure) {
    p.intro(" modlens — reconfigure ");
    const lines: string[] = [];
    const currentProfile = (existingEnv.MODLENS_PROFILE as ProfileName | undefined) ?? "full";
    const profileLabel = PROFILES[currentProfile]?.label ?? currentProfile;
    lines.push(`  Profile:            ${profileLabel}`);
    if (existingEnv.DATABASE_URL)       lines.push(`  DATABASE_URL:       ${existingEnv.DATABASE_URL}`);
    if (existingEnv.OLLAMA_URL)         lines.push(`  OLLAMA_URL:         ${existingEnv.OLLAMA_URL}`);
    if (existingEnv.OLLAMA_EMBED_MODEL) lines.push(`  OLLAMA_EMBED_MODEL: ${existingEnv.OLLAMA_EMBED_MODEL}`);
    if (existingEnv.CURSEFORGE_API_KEY) lines.push(`  CURSEFORGE_API_KEY: (configured)`);
    if (existingEnv.MODRINTH_TOKEN)     lines.push(`  MODRINTH_TOKEN:     (configured)`);
    if (lines.length) p.log.message("Current config:\n" + lines.join("\n"));
}
```

- [ ] **Step 2: Add "Switch profile" to the reconfigure mode select**

Replace the existing `p.select` (two options: full, pick) with a three-option version:

```typescript
const wizardMode = await p.select({
    message: "What would you like to do?",
    options: [
        { value: "full",   label: "Full wizard   — re-run all steps", hint: "safe for upgrades, all ops are idempotent" },
        { value: "pick",   label: "Pick tasks    — choose which steps to run" },
        { value: "switch", label: "Switch profile — change backend or feature set" },
    ],
});
checkCancel(wizardMode);
```

- [ ] **Step 3: Add the `switch` branch**

After the existing `if (wizardMode === "full")` and `else` blocks (the multiselect), add:

```typescript
} else if (wizardMode === "switch") {
    // ── Switch profile ────────────────────────────────────────────────────────
    // 1. Auto-backup the current backend
    const currentUrl = existingEnv.DATABASE_URL ?? "";
    if (currentUrl) {
        const s = p.spinner();
        s.start("Creating backup before switching profile");
        try {
            const { backup } = await import("../scripts/backup.mjs" as string) as { backup: (url: string) => Promise<{ file?: string; dir?: string; restore: string }> };
            const result = await backup(currentUrl);
            s.stop(`Backup created: ${result.file ?? result.dir}`);
        } catch (e) {
            s.error(`Backup failed: ${(e as Error).message}`);
            const cont = await p.confirm({ message: "Continue switching profile without backup?" });
            checkCancel(cont);
            if (!cont) process.exit(1);
        }
    }

    // 2. Pick new profile
    const newProfile = await p.select<ProfileName>({
        message: "Switch to which profile?",
        options: Object.values(PROFILES).map(pr => ({
            value: pr.name,
            label: pr.label,
            hint: pr.hint,
        })),
    });
    checkCancel(newProfile);
    selectedProfile = newProfile as ProfileName;

    // 3. Collect new DATABASE_URL for non-default profiles
    let newUrl = "";
    if (selectedProfile === "existing") {
        const url = await p.text({
            message: "Enter your Postgres connection URL",
            placeholder: "postgresql://user:password@host:5432/modlens",
            validate: v => (v ?? "").startsWith("postgresql://") || (v ?? "").startsWith("postgres://")
                ? undefined : "Must be a postgresql:// URL",
        });
        checkCancel(url);
        newUrl = url as string;
    } else if (selectedProfile === "zero-friction") {
        const defaultDir = join(homedir(), ".modlens-data");
        const dataDir = await p.text({
            message: "PGlite data directory",
            initialValue: defaultDir,
        });
        checkCancel(dataDir);
        newUrl = `pglite://${dataDir as string}`;
    } else if (selectedProfile === "lightweight") {
        const defaultFile = join(homedir(), ".modlens-data", "modlens.db");
        const dbFile = await p.text({
            message: "SQLite database file path",
            initialValue: defaultFile,
        });
        checkCancel(dbFile);
        newUrl = `file:${dbFile as string}`;
    } else if (selectedProfile === "full" || selectedProfile === "standard") {
        // Postgres via Docker — use default (from docker-compose)
        newUrl = "postgresql://postgres:postgres@localhost:5432/modlens";
    } else {
        // custom — keep current URL or let downstream steps set it
        newUrl = currentUrl;
    }

    // 4. Offer data migration
    if (currentUrl && newUrl && currentUrl !== newUrl) {
        const wantMigrate = await p.confirm({
            message: "Migrate existing data (mods, docs, primers) to new backend? (MC source not migrated — too large)",
            initialValue: true,
        });
        checkCancel(wantMigrate);
        if (wantMigrate) {
            const s = p.spinner();
            s.start("Migrating data");
            try {
                const { migrate } = await import("../scripts/migrate-backend.mjs" as string) as {
                    migrate: (src: string, tgt: string) => Promise<void>
                };
                await migrate(currentUrl, newUrl);
                s.stop("Migration complete");
            } catch (e) {
                s.error(`Migration failed: ${(e as Error).message}`);
                p.log.warn("Continuing — you can re-run migration manually: SOURCE_DATABASE_URL=<old> DATABASE_URL=<new> node scripts/migrate-backend.mjs");
            }
        }
    }

    // 5. Offer cleanup of old backend data
    if (currentUrl && currentUrl !== newUrl) {
        const wantCleanup = await p.confirm({
            message: "Delete old backend data? (keep backup — this frees disk space)",
            initialValue: false, // default: keep
        });
        checkCancel(wantCleanup);
        if (wantCleanup) {
            const { rmSync } = await import("fs");
            const oldBackend = detectProfileFromUrl(currentUrl);
            if (oldBackend === "zero-friction") {
                const dataDir = currentUrl.replace(/^pglite:\/\//, "");
                rmSync(dataDir, { recursive: true, force: true });
                p.log.success(`Removed PGlite data directory: ${dataDir}`);
            } else if (oldBackend === "lightweight") {
                const dbPath = currentUrl.replace(/^file:\/\//, "").replace(/^file:/, "");
                rmSync(dbPath, { force: true });
                p.log.success(`Removed SQLite database: ${dbPath}`);
            } else {
                p.log.warn("Cannot auto-clean Postgres data. To remove: docker compose down -v");
            }
        }
    }

    // 6. Write new env and set sections
    writeEnv({ ...readEnv(), DATABASE_URL: newUrl, MODLENS_PROFILE: selectedProfile });
    sections = new Set(
        selectedProfile === "custom"
            ? ALL_SECTIONS
            : PROFILES[selectedProfile].sections
    );
}
```

---

### Task 4: Guard Docker-only steps when backend doesn't need Docker

**Files:**
- Modify: `src/setup.ts`

PGlite and SQLite profiles skip `containers`. The existing `sections.has("containers")` guards already handle this. But the hard Docker check at the top should be conditional:

- [ ] **Step 1: Wrap the Docker check in a guard**

Replace:
```typescript
// ── Check Docker (always required) ─────────────────────────────────────────
{
    const s = p.spinner();
    s.start("Checking Docker");
    const docker = run("docker info", { silent: true });
    if (!docker.ok) {
        s.error("Docker not found or not running");
        p.log.error("Please install Docker Desktop and make sure it is running, then re-run setup.");
        process.exit(1);
    }
    s.stop("Docker is running");
}
```

With:
```typescript
// ── Check Docker (only required for container-using profiles) ───────────────
const profileNeedsDocker = selectedProfile === "custom"
    ? sections.has("containers")
    : PROFILES[selectedProfile]?.requiresDocker ?? false;

if (profileNeedsDocker) {
    const s = p.spinner();
    s.start("Checking Docker");
    const docker = run("docker info", { silent: true });
    if (!docker.ok) {
        s.error("Docker not found or not running");
        p.log.error("Please install Docker Desktop and make sure it is running, then re-run setup.");
        process.exit(1);
    }
    s.stop("Docker is running");
}
```

---

### Task 5: Compile check and smoke test

- [ ] **Step 1: Compile check**

```bash
npx tsc --noEmit 2>&1
```

Expect: no errors. Common issues:
- `homedir` and `join` not imported → add to top-of-file imports
- `selectedProfile` not declared before the `if (!isReconfigure)` block → add `let selectedProfile: ProfileName = "full";`
- Dynamic import of `.mjs` files → cast with `as string` trick shown above, or use `process.env` path trick if needed

- [ ] **Step 2: Test fresh install (dry run)**

```bash
# Rename .env temporarily to simulate fresh install
mv .env .env.bak
node --loader ts-node/esm src/setup.ts
```

Navigate the profile picker, select "Lightweight", confirm `.env` is written with `file:` URL and `MODLENS_PROFILE=lightweight`.

Restore: `mv .env.bak .env`

- [ ] **Step 3: Test reconfigure — switch profile**

```bash
node --loader ts-node/esm src/setup.ts
```

Choose "Switch profile." Confirm backup is created, new profile and URL are written.

---

### Task 6: Push

- [ ] **Step 1: Commit and push**

```bash
git add src/setup.ts
git commit -m "feat(p5): profiles wizard — profile picker, switch profile, auto-backup, optional migration"
git push
```

---

**P5 done.** The wizard now surfaces a profile on first run and allows switching profiles on reconfigure, with automatic backup and optional data migration baked in.
