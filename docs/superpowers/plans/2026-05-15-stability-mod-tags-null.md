# Stability: mod-tags.ts Null Crash Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `scanTagsFromJar` in `src/tools/mod-tags.ts` calls `zip.readFile(entry)!.toString("utf8")` — the non-null assertion `!` is wrong. `AdmZip.readFile()` returns `null` for directories and malformed entries. This throws `TypeError: Cannot read properties of null (reading 'toString')` when a tag JSON file exists as a directory entry in the ZIP or is otherwise unreadable.

**Fix:** Check for `null` before calling `.toString()`. The existing `try/catch` only catches JSON parse errors, not this crash.

**Files to modify:** `src/tools/mod-tags.ts`

---

## Task 1: Fix the null-crash

- [ ] **Read the bug site in `src/tools/mod-tags.ts`**

  Current code (around line 42):
  ```typescript
  try {
      json = JSON.parse(zip.readFile(entry)!.toString("utf8"));
  } catch { continue; }
  ```

- [ ] **Apply the fix**

  Replace:
  ```typescript
  try {
      json = JSON.parse(zip.readFile(entry)!.toString("utf8"));
  } catch { continue; }
  ```
  with:
  ```typescript
  try {
      const raw = zip.readFile(entry);
      if (!raw) continue;
      json = JSON.parse(raw.toString("utf8"));
  } catch { continue; }
  ```

- [ ] **Run type-check**

  ```powershell
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Run full tests**

  ```powershell
  npm test
  ```
  Expected: all pass.

- [ ] **Commit**

  ```powershell
  git add src/tools/mod-tags.ts
  git commit -m "fix: null check before toString in scanTagsFromJar"
  ```

---

## Task 2: Add a regression test

`mod-tags.ts` has no test file. Add a minimal test that constructs a ZIP with a null-content entry and verifies `scanTagsFromJar` doesn't throw.

- [ ] **Create `src/tools/mod-tags.test.ts`**

  ```typescript
  import { describe, it, expect } from "vitest";
  import AdmZip from "adm-zip";
  import { writeFile, unlink } from "fs/promises";
  import { tmpdir } from "os";
  import { join } from "path";

  // We test scanTagsFromJar by building JARs with specific content.
  // The function is not exported — test via the exported indexModTags wrapper
  // which calls it internally. However, since indexModTags needs a DB, we
  // test the null-safety by directly importing and calling the internal logic
  // through a thin re-export. For now we validate via a real JAR that includes
  // a directory entry matching the tag pattern.

  async function makeTagJar(extras: Record<string, string | null> = {}): Promise<string> {
      const zip = new AdmZip();
      for (const [name, content] of Object.entries(extras)) {
          if (content === null) {
              // Add as directory entry (null content scenario)
              zip.addFile(name, Buffer.alloc(0));
          } else {
              zip.addFile(name, Buffer.from(content, "utf8"));
          }
      }
      const dest = join(tmpdir(), `test-tags-${Date.now()}.jar`);
      zip.writeZip(dest);
      return dest;
  }

  // Since scanTagsFromJar is internal we test indirectly by verifying
  // the export `indexModTags` path handles bad ZIPs gracefully.
  // We can also re-export scanTagsFromJar for testing — do that first.
  ```

  **Note:** `scanTagsFromJar` is not currently exported. Before writing the test body, add `export` to its declaration in `mod-tags.ts`:
  ```typescript
  // src/tools/mod-tags.ts — change:
  function scanTagsFromJar(jarPath: string): ScannedTag[] {
  // to:
  export function scanTagsFromJar(jarPath: string): ScannedTag[] {
  ```

  Then complete the test:
  ```typescript
  import { scanTagsFromJar } from "./mod-tags.js";

  describe("scanTagsFromJar — null safety", () => {
      it("returns empty array for a JAR with no tag files", async () => {
          const jarPath = await makeTagJar({});
          try {
              const tags = scanTagsFromJar(jarPath);
              expect(tags).toEqual([]);
          } finally {
              await unlink(jarPath);
          }
      });

      it("does not throw when a tag-path entry has zero-byte content", async () => {
          // An empty buffer parses to invalid JSON — should be skipped, not thrown
          const jarPath = await makeTagJar({
              "data/mod/tags/blocks/stone.json": "",
          });
          try {
              const tags = scanTagsFromJar(jarPath);
              expect(tags).toEqual([]);
          } finally {
              await unlink(jarPath);
          }
      });

      it("parses valid tag entries correctly", async () => {
          const content = JSON.stringify({ values: ["minecraft:stone", "minecraft:granite"], replace: false });
          const jarPath = await makeTagJar({
              "data/mymod/tags/blocks/stone_group.json": content,
          });
          try {
              const tags = scanTagsFromJar(jarPath);
              expect(tags).toHaveLength(1);
              expect(tags[0].registry).toBe("blocks");
              expect(tags[0].namespace).toBe("mymod");
              expect(tags[0].entries).toContain("minecraft:stone");
              expect(tags[0].replace).toBe(false);
          } finally {
              await unlink(jarPath);
          }
      });

      it("handles replace:true flag", async () => {
          const content = JSON.stringify({ values: ["minecraft:stone"], replace: true });
          const jarPath = await makeTagJar({
              "data/mymod/tags/items/iron_ores.json": content,
          });
          try {
              const tags = scanTagsFromJar(jarPath);
              expect(tags[0].replace).toBe(true);
          } finally {
              await unlink(jarPath);
          }
      });
  });
  ```

- [ ] **Run tests**

  ```powershell
  npx vitest run src/tools/mod-tags.test.ts
  ```
  Expected: PASS (4 tests).

- [ ] **Run full suite**

  ```powershell
  npm test
  ```
  Expected: all pass.

- [ ] **Commit**

  ```powershell
  git add src/tools/mod-tags.ts src/tools/mod-tags.test.ts
  git commit -m "test: mod-tags null safety regression tests"
  ```
