# Tests: reindexClasses + batchIngest

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `reindexClasses` and `batchIngest` are exported from `src/tools/ingest.ts` but have zero test coverage. Both are DB-heavy operations that can be fully tested with `vi.mock` (same approach as the existing `ingest.test.ts`). The existing mock scaffolding in `src/tools/ingest.test.ts` already has all the module mocks set up — extend that file with new `describe` blocks.

**Files to modify:** `src/tools/ingest.test.ts`

---

## Task 1: `reindexClasses` — single mod path

`reindexClasses(dbId)` fetches the mod by ID, checks if class count is already > 0 (skips if so), otherwise calls `indexJar` and `createModClasses`.

- [ ] **Import `reindexClasses` in the test file**

  In `src/tools/ingest.test.ts`, update the SUT import line:
  ```typescript
  // BEFORE
  const { ingestMod } = await import("./ingest.js");
  // AFTER
  const { ingestMod, reindexClasses, batchIngest } = await import("./ingest.js");
  ```

- [ ] **Write failing tests**

  Append to `src/tools/ingest.test.ts`:
  ```typescript
  // ── reindexClasses ─────────────────────────────────────────────────────────

  describe("reindexClasses — single mod", () => {
      it("indexes classes when mod has none yet", async () => {
          vi.mocked(repo.findModById).mockResolvedValue(FAKE_DB_MOD as any);
          vi.mocked(repo.countModClasses).mockResolvedValue(0);
          vi.mocked(jt.indexJar).mockResolvedValue({
              classes: {
                  "com/example/A": { name: "com/example/A", superName: "java/lang/Object", interfaces: [], accessFlags: 1 },
              },
          } as any);

          const result = await reindexClasses(FAKE_DB_MOD.id);

          expect(result.indexed).toBe(1);
          expect(result.skipped).toBe(0);
          expect(result.failed).toBe(0);
          expect(repo.createModClasses).toHaveBeenCalledOnce();
      });

      it("skips a mod that already has classes indexed", async () => {
          vi.mocked(repo.findModById).mockResolvedValue(FAKE_DB_MOD as any);
          vi.mocked(repo.countModClasses).mockResolvedValue(42); // already has classes

          const result = await reindexClasses(FAKE_DB_MOD.id);

          expect(result.skipped).toBe(1);
          expect(result.indexed).toBe(0);
          expect(jt.indexJar).not.toHaveBeenCalled();
          expect(repo.createModClasses).not.toHaveBeenCalled();
      });

      it("returns failed=1 when indexJar throws", async () => {
          vi.mocked(repo.findModById).mockResolvedValue(FAKE_DB_MOD as any);
          vi.mocked(repo.countModClasses).mockResolvedValue(0);
          vi.mocked(jt.indexJar).mockRejectedValue(new Error("JAR not found"));

          const result = await reindexClasses(FAKE_DB_MOD.id);

          expect(result.failed).toBe(1);
          expect(result.indexed).toBe(0);
          expect(repo.createModClasses).not.toHaveBeenCalled();
      });

      it("returns skipped=1 when indexJar returns no classes", async () => {
          vi.mocked(repo.findModById).mockResolvedValue(FAKE_DB_MOD as any);
          vi.mocked(repo.countModClasses).mockResolvedValue(0);
          vi.mocked(jt.indexJar).mockResolvedValue({ classes: {} } as any);

          const result = await reindexClasses(FAKE_DB_MOD.id);

          expect(result.skipped).toBe(1);
          expect(repo.createModClasses).not.toHaveBeenCalled();
      });
  });

  describe("reindexClasses — all mods (no dbId)", () => {
      it("processes all mods returned by listAllMods", async () => {
          const mod2 = { ...FAKE_DB_MOD, id: 2, jarPath: "/mods/other.jar" };
          vi.mocked(repo.listAllMods).mockResolvedValue([FAKE_DB_MOD, mod2] as any);
          vi.mocked(repo.countModClasses).mockResolvedValue(0);
          vi.mocked(jt.indexJar).mockResolvedValue({
              classes: {
                  "com/example/A": { name: "com/example/A", superName: "java/lang/Object", interfaces: [], accessFlags: 1 },
              },
          } as any);

          const result = await reindexClasses();

          expect(result.indexed).toBe(2);
          expect(repo.createModClasses).toHaveBeenCalledTimes(2);
      });
  });
  ```

- [ ] **Run to verify tests pass**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: existing 9 + 5 new = 14 tests pass.

- [ ] **Commit**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: reindexClasses — single mod, all mods, skip, fail, no-classes"
  ```

---

## Task 2: `batchIngest` — directory ingest

`batchIngest(directory, skipSource, indexClasses)` reads a directory, calls `ingestMod` per JAR, accumulates counts.

- [ ] **Append to `src/tools/ingest.test.ts`**

  ```typescript
  // ── batchIngest ────────────────────────────────────────────────────────────

  // We need to mock fs/promises.readdir since batchIngest does a dynamic import
  vi.mock("fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs/promises")>();
      return { ...actual, readdir: vi.fn().mockResolvedValue([]) };
  });
  const fsPromises = await import("fs/promises");

  describe("batchIngest — empty directory", () => {
      it("returns zero totals when directory has no JARs", async () => {
          vi.mocked(fsPromises.readdir).mockResolvedValue([] as any);

          const result = await batchIngest("/mods") as any;

          expect(result.total).toBe(0);
          expect(result.ingested).toBe(0);
          expect(result.failed).toBe(0);
          expect(result.skipped).toBe(0);
      });
  });

  describe("batchIngest — with JARs", () => {
      beforeEach(() => {
          // Return two fake JAR filenames
          vi.mocked(fsPromises.readdir).mockResolvedValue(["alpha.jar", "beta.jar", "readme.txt"] as any);
      });

      it("processes only .jar files, ignores others", async () => {
          const result = await batchIngest("/mods", true) as any;
          // readme.txt is skipped — only 2 JARs processed
          expect(result.total).toBe(2);
      });

      it("counts ingested status correctly when all JARs are new", async () => {
          // ingestMod default mock returns "ingested"
          const result = await batchIngest("/mods", true) as any;
          expect(result.ingested).toBe(2);
          expect(result.skipped).toBe(0);
          expect(result.failed).toBe(0);
      });

      it("counts skipped when ingestMod returns already_ingested", async () => {
          vi.mocked(repo.findModByJarPath).mockResolvedValue(FAKE_DB_MOD as any);

          const result = await batchIngest("/mods", true) as any;
          expect(result.skipped).toBe(2);
          expect(result.ingested).toBe(0);
      });

      it("counts failed when ingestMod throws", async () => {
          vi.mocked(proc.parseJar).mockRejectedValue(new Error("Corrupt JAR"));

          const result = await batchIngest("/mods", true) as any;
          expect(result.failed).toBe(2);
          expect(result.ingested).toBe(0);
          // Error message is captured in results
          expect((result.results as any[]).every((r: any) => r.status.startsWith("error:"))).toBe(true);
      });

      it("includes modId and version in results for ingested JARs", async () => {
          const result = await batchIngest("/mods", true) as any;
          for (const r of result.results as any[]) {
              if (r.status === "ingested") {
                  expect(r.modId).toBe(FAKE_DB_MOD.modId);
                  expect(r.version).toBe(FAKE_DB_MOD.version);
              }
          }
      });
  });
  ```

  > **Note on `readdir` mock:** `batchIngest` does `const { readdir } = await import("fs/promises")` (dynamic import). Because vi.mock hoists, the mock should intercept. If not, an alternative is to pass `{ readdir: vi.fn() }` through dependency injection or refactor to a top-level import. The executing agent should verify the dynamic import is intercepted correctly and adjust if needed.

- [ ] **Run to verify tests pass**

  ```powershell
  npx vitest run src/tools/ingest.test.ts
  ```
  Expected: 14 + 6 = 20 tests pass.

- [ ] **Run full test suite**

  ```powershell
  npm test
  ```
  Expected: all tests pass.

- [ ] **Commit**

  ```powershell
  git add src/tools/ingest.test.ts
  git commit -m "test: batchIngest — empty dir, JAR count, ingested/skipped/failed/error"
  ```
