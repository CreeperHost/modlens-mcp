# Ingest Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a test suite for `src/tools/ingest.ts` covering all four `IngestResult` branches of `ingestMod`, platform-lookup parallelism, and the `reindexClasses` entry points. All tests use `vi.mock()` to stub out Postgres, JAR parsing, and platform APIs — no real database, files, or network calls.

**Architecture:**
- `vi.mock("../repositories/mod.js")` replaces every DB call with `vi.fn()` stubs
- `vi.mock("../processor.js")` stubs `parseJar` and `computeHashes` with deterministic return values
- `vi.mock("../modrinth.js")` stubs `lookupBySha512` and `getProject`
- `vi.mock("../curseforge.js")` stubs `lookupByFingerprint`
- `vi.mock("../java-tools.js")` stubs `decompileJar`, `isDecompileDone`, `indexJar`
- `vi.mock("../cache.js")` stubs `paths` and `ensureDir`

Each test uses `beforeEach` to reset all mocks to sensible defaults (happy path), then individual tests override specific mocks to exercise each branch.

**Tech Stack:** Vitest, `vi.mock`, `vi.fn`, `beforeEach`, `vi.resetAllMocks`

---

## File Map

- **Create:** `src/tools/ingest.test.ts`
- **Read (do not modify):** `src/tools/ingest.ts`, `src/repositories/mod.ts`

---

## Task 1: Mock scaffolding and test infrastructure

- [ ] **Step 1: Create `src/tools/ingest.test.ts` with all mocks declared**

  ```typescript
  import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
  import type { IngestResult } from "./ingest.js";

  // ── Module mocks ────────────────────────────────────────────────────────────
  vi.mock("../repositories/mod.js", () => ({
      findModByJarPath: vi.fn(),
      findModByDupKey:  vi.fn(),
      findModBySha512:  vi.fn(),
      createMod:        vi.fn(),
      updateMod:        vi.fn(),
      findModById:      vi.fn(),
      listAllMods:      vi.fn(),
      countModClasses:  vi.fn(),
      createModClasses: vi.fn(),
  }));

  vi.mock("../processor.js", () => ({
      parseJar:      vi.fn(),
      computeHashes: vi.fn(),
  }));

  vi.mock("../modrinth.js", () => ({
      lookupBySha512: vi.fn(),
      getProject:     vi.fn(),
  }));

  vi.mock("../curseforge.js", () => ({
      lookupByFingerprint: vi.fn(),
  }));

  vi.mock("../java-tools.js", () => ({
      decompileJar:    vi.fn(),
      isDecompileDone: vi.fn(),
      indexJar:        vi.fn(),
  }));

  vi.mock("../cache.js", () => ({
      paths:     { decompiled: "/tmp/decompiled", source: "/tmp/source", jars: "/tmp/jars" },
      ensureDir: vi.fn(),
  }));

  // ── Import SUT after mocks are declared ─────────────────────────────────────
  const { ingestMod, reindexClasses } = await import("./ingest.js");

  // ── Import mock references for per-test override ─────────────────────────────
  const repo   = await import("../repositories/mod.js");
  const proc   = await import("../processor.js");
  const mr     = await import("../modrinth.js");
  const cf     = await import("../curseforge.js");

  // ── Fixture data ─────────────────────────────────────────────────────────────
  const FAKE_MANIFEST = {
      modId: "testmod", displayName: "Test Mod", version: "1.0.0",
      mcVersion: "1.21.1", loader: "fabric" as const, description: "",
      sourceUrl: null, dependencies: [], mixinConfigs: [],
      hasMixins: false, hasAt: false, hasAw: false,
      atEntries: [], awEntries: [], mixinTargets: [],
  };

  const FAKE_HASHES = { sha256: "aaa", sha512: "bbb", murmur2: "12345" };

  const FAKE_DB_MOD = {
      id: 1, jarPath: "/mods/testmod.jar", modId: "testmod",
      displayName: "Test Mod", version: "1.0.0", mcVersion: "1.21.1",
      loader: "fabric", description: "", sourceUrl: null,
      modrinthProjectId: null, curseforgeProjectId: null, slug: null,
      createdAt: new Date(),
  };

  // ── Default mock setup (happy path) ─────────────────────────────────────────
  beforeEach(() => {
      vi.resetAllMocks();

      vi.mocked(repo.findModByJarPath).mockResolvedValue(null);
      vi.mocked(repo.findModByDupKey).mockResolvedValue(null);
      vi.mocked(repo.findModBySha512).mockResolvedValue(null);
      vi.mocked(repo.createMod).mockResolvedValue(FAKE_DB_MOD);
      vi.mocked(repo.findModById).mockResolvedValue(FAKE_DB_MOD);
      vi.mocked(repo.countModClasses).mockResolvedValue(0);
      vi.mocked(repo.createModClasses).mockResolvedValue(undefined);

      vi.mocked(proc.parseJar).mockResolvedValue(FAKE_MANIFEST);
      vi.mocked(proc.computeHashes).mockResolvedValue(FAKE_HASHES);

      vi.mocked(mr.lookupBySha512).mockResolvedValue(null);
      vi.mocked(mr.getProject).mockResolvedValue(null);
      vi.mocked(cf.lookupByFingerprint).mockResolvedValue(null);
  });
  ```

- [ ] **Step 2: Run to verify the scaffolding compiles and 0 tests run (not yet any `it` blocks)**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: 0 tests, no errors.

- [ ] **Step 3: Commit scaffolding**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: ingest mock scaffolding"
  ```

---

## Task 2: `already_ingested` branch

- [ ] **Step 1: Write failing test**

  Append to `src/tools/ingest.test.ts`:
  ```typescript
  describe("ingestMod — already_ingested", () => {
      it("returns already_ingested when JAR path already exists in DB", async () => {
          vi.mocked(repo.findModByJarPath).mockResolvedValue(FAKE_DB_MOD);

          const result: IngestResult = await ingestMod("/mods/testmod.jar");

          expect(result.status).toBe("already_ingested");
          expect((result as Extract<IngestResult, { status: "already_ingested" }>).mod).toEqual(FAKE_DB_MOD);

          // Should not have parsed the JAR or hit the DB further
          expect(proc.parseJar).not.toHaveBeenCalled();
          expect(repo.createMod).not.toHaveBeenCalled();
      });
  });
  ```

- [ ] **Step 2: Run to verify test passes**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: PASS (1 test).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: ingest already_ingested branch"
  ```

---

## Task 3: `duplicate_version` branch

- [ ] **Step 1: Write failing test**

  Append to `src/tools/ingest.test.ts`:
  ```typescript
  describe("ingestMod — duplicate_version", () => {
      it("returns duplicate_version when same modId+version+loader exists at different path", async () => {
          const existingMod = { ...FAKE_DB_MOD, id: 99, jarPath: "/other/path/testmod.jar" };
          vi.mocked(repo.findModByDupKey).mockResolvedValue(existingMod);

          const result: IngestResult = await ingestMod("/mods/testmod-copy.jar");

          expect(result.status).toBe("duplicate_version");
          const r = result as Extract<IngestResult, { status: "duplicate_version" }>;
          expect(r.existingJarPath).toBe("/other/path/testmod.jar");
          expect(r.existingDbId).toBe(99);
          expect(r.message).toContain("testmod");

          expect(repo.createMod).not.toHaveBeenCalled();
      });
  });
  ```

- [ ] **Step 2: Run to verify test passes**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: PASS (2 tests total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: ingest duplicate_version branch"
  ```

---

## Task 4: `duplicate_hash` branch

- [ ] **Step 1: Write failing test**

  Append to `src/tools/ingest.test.ts`:
  ```typescript
  describe("ingestMod — duplicate_hash", () => {
      it("returns duplicate_hash when SHA-512 matches existing mod", async () => {
          const existingMod = { ...FAKE_DB_MOD, id: 42, jarPath: "/original/testmod.jar" };
          vi.mocked(repo.findModBySha512).mockResolvedValue(existingMod);

          const result: IngestResult = await ingestMod("/mods/testmod-renamed.jar");

          expect(result.status).toBe("duplicate_hash");
          const r = result as Extract<IngestResult, { status: "duplicate_hash" }>;
          expect(r.existingDbId).toBe(42);
          expect(r.existingJarPath).toBe("/original/testmod.jar");

          expect(repo.createMod).not.toHaveBeenCalled();
      });
  });
  ```

- [ ] **Step 2: Run to verify test passes**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: PASS (3 tests total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: ingest duplicate_hash branch"
  ```

---

## Task 5: Happy path — `ingested` branch

- [ ] **Step 1: Write failing test**

  Append to `src/tools/ingest.test.ts`:
  ```typescript
  describe("ingestMod — ingested (happy path)", () => {
      it("creates mod record and returns ingested status", async () => {
          const result: IngestResult = await ingestMod("/mods/testmod.jar");

          expect(result.status).toBe("ingested");
          expect(repo.createMod).toHaveBeenCalledOnce();
          expect(repo.findModById).toHaveBeenCalled();

          const r = result as Extract<IngestResult, { status: "ingested" }>;
          expect(r.mod).toEqual(FAKE_DB_MOD);
      });

      it("calls parseJar and computeHashes on the provided path", async () => {
          await ingestMod("/mods/testmod.jar");
          expect(proc.parseJar).toHaveBeenCalledWith("/mods/testmod.jar");
          expect(proc.computeHashes).toHaveBeenCalledWith("/mods/testmod.jar");
      });
  });
  ```

- [ ] **Step 2: Run to verify tests pass**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: PASS (5 tests total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: ingest happy path ingested branch"
  ```

---

## Task 6: Platform lookup integration

- [ ] **Step 1: Write failing test — Modrinth hit**

  Append to `src/tools/ingest.test.ts`:
  ```typescript
  describe("ingestMod — platform lookups", () => {
      it("stores modrinthProjectId when Modrinth returns a match", async () => {
          vi.mocked(mr.lookupBySha512).mockResolvedValue({
              project_id: "mr-abc-123",
              id: "ver-1",
              project_type: "mod",
              name: "Test Mod",
              version_number: "1.0.0",
              files: [],
              loaders: [],
              game_versions: [],
          } as any);
          vi.mocked(mr.getProject).mockResolvedValue({
              id: "mr-abc-123",
              slug: "test-mod",
              source_url: "https://github.com/example/testmod",
          } as any);

          await ingestMod("/mods/testmod.jar");

          expect(repo.createMod).toHaveBeenCalledWith(
              expect.objectContaining({ modrinthProjectId: "mr-abc-123" }),
          );
      });

      it("stores curseforgeProjectId when CurseForge returns a match", async () => {
          vi.mocked(cf.lookupByFingerprint).mockResolvedValue({
              id: 99999,
              slug: "testmod",
              links: { sourceUrl: "https://github.com/example/testmod" },
          } as any);

          await ingestMod("/mods/testmod.jar");

          expect(repo.createMod).toHaveBeenCalledWith(
              expect.objectContaining({ curseforgeProjectId: 99999 }),
          );
      });

      it("skipSource=true skips all platform lookups", async () => {
          await ingestMod("/mods/testmod.jar", /* skipSource= */ true);

          expect(mr.lookupBySha512).not.toHaveBeenCalled();
          expect(cf.lookupByFingerprint).not.toHaveBeenCalled();
      });

      it("continues ingesting even if both platform lookups fail", async () => {
          vi.mocked(mr.lookupBySha512).mockRejectedValue(new Error("Modrinth down"));
          vi.mocked(cf.lookupByFingerprint).mockRejectedValue(new Error("CurseForge down"));

          const result: IngestResult = await ingestMod("/mods/testmod.jar");

          // Should still ingest successfully, just with no platform data
          expect(result.status).toBe("ingested");
          expect(repo.createMod).toHaveBeenCalledOnce();
      });
  });
  ```

- [ ] **Step 2: Run to verify tests pass**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: PASS (9 tests total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: ingest platform lookup coverage"
  ```

---

## Task 7: Full test suite validation

- [ ] **Step 1: Run full test suite**

  ```powershell
  npm test
  ```
  Expected: all previously passing tests + 9 new ingest tests.

- [ ] **Step 2: Type-check**

  ```powershell
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit if not already done**

  ```powershell
  git add -A
  git commit -m "test: ingest full suite — all IngestResult branches covered"
  ```
