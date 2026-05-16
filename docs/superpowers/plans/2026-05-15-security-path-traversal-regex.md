# Security: Path Traversal + Regex Injection Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close two security gaps in tool input handling:
1. **Path traversal** — `getModSource(dbId, path)` passes a user-supplied `path` directly to `join(decompPath, path)`. A path like `../../../etc/passwd` escapes the decompile directory.
2. **Regex DoS** — `searchSource(query, dbId, isRegex)` and `searchMcCode(version, query, searchType, isRegex)` both call `new RegExp(query, "i")` with unchecked user input. A crafted regex triggers catastrophic backtracking (ReDoS).

**Approach:**
- Shared `validatePath(untrusted, base)` helper that normalises and checks the resolved path stays inside `base`.
- Shared `safeRegex(pattern)` helper that validates regex compile time and enforces a max length.
- Add tests for both helpers.

**Files to modify:** `src/tools/source.ts`, `src/tools/vanilla.ts`
**File to create:** `src/security.ts` (shared helpers), `src/security.test.ts`

---

## Task 1: `validatePath` helper

- [ ] **Create `src/security.ts`**

  ```typescript
  import { resolve, relative } from "path";

  /**
   * Validate that `untrusted` resolves to a path inside `base`.
   * Throws if it would escape (path traversal attempt).
   * Returns the resolved absolute path on success.
   */
  export function validatePath(untrusted: string, base: string): string {
      // Normalize both to absolute paths
      const resolvedBase = resolve(base);
      const resolvedTarget = resolve(base, untrusted);

      // relative() from resolvedBase to resolvedTarget must not start with '..'
      const rel = relative(resolvedBase, resolvedTarget);
      if (rel.startsWith("..") || require("path").isAbsolute(rel)) {
          throw new Error(`Path traversal attempt rejected: '${untrusted}'`);
      }
      return resolvedTarget;
  }

  const MAX_REGEX_LENGTH = 500;

  /**
   * Compile a user-supplied regex string safely.
   * Throws if the pattern is too long or fails to compile.
   * Does NOT catch catastrophic backtracking at runtime, but the length cap
   * significantly reduces the surface area for ReDoS.
   */
  export function safeRegex(pattern: string, flags = "i"): RegExp {
      if (pattern.length > MAX_REGEX_LENGTH) {
          throw new Error(`Regex pattern too long (max ${MAX_REGEX_LENGTH} characters)`);
      }
      try {
          return new RegExp(pattern, flags);
      } catch (e) {
          throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
      }
  }
  ```

- [ ] **Write tests first in `src/security.test.ts`**

  ```typescript
  import { describe, it, expect } from "vitest";
  import { validatePath, safeRegex } from "./security.js";
  import { tmpdir } from "os";

  describe("validatePath", () => {
      const base = tmpdir();

      it("accepts a normal relative path inside base", () => {
          const result = validatePath("foo/bar.java", base);
          expect(result).toContain("foo");
          expect(result).toContain("bar.java");
      });

      it("throws on simple path traversal (../)", () => {
          expect(() => validatePath("../etc/passwd", base)).toThrow("Path traversal");
      });

      it("throws on deep traversal attempt", () => {
          expect(() => validatePath("foo/../../etc/passwd", base)).toThrow("Path traversal");
      });

      it("accepts a plain filename with no subdirectory", () => {
          expect(() => validatePath("World.java", base)).not.toThrow();
      });

      it("throws on absolute path that escapes base", () => {
          expect(() => validatePath("/etc/passwd", base)).toThrow("Path traversal");
      });
  });

  describe("safeRegex", () => {
      it("compiles a valid regex", () => {
          const r = safeRegex("foo.*bar");
          expect(r.test("fooXXXbar")).toBe(true);
      });

      it("throws on invalid regex syntax", () => {
          expect(() => safeRegex("(unclosed")).toThrow("Invalid regex");
      });

      it("throws when pattern exceeds max length", () => {
          const long = "a".repeat(501);
          expect(() => safeRegex(long)).toThrow("too long");
      });

      it("accepts pattern exactly at max length", () => {
          const ok = "a".repeat(500);
          expect(() => safeRegex(ok)).not.toThrow();
      });

      it("applies flags correctly", () => {
          const r = safeRegex("foo", "gi");
          expect(r.flags).toContain("g");
          expect(r.flags).toContain("i");
      });
  });
  ```

- [ ] **Run tests — expect FAIL (module not yet created)**

  ```powershell
  npx vitest run src/security.test.ts
  ```

- [ ] **Create `src/security.ts` as above, then run again — expect PASS**

  ```powershell
  npx vitest run src/security.test.ts
  ```
  Expected: 10 tests pass.

- [ ] **Commit**

  ```powershell
  git add src/security.ts src/security.test.ts
  git commit -m "feat: validatePath + safeRegex security helpers with tests"
  ```

---

## Task 2: Apply `validatePath` to `getModSource`

- [ ] **Edit `src/tools/source.ts`**

  Add import at top:
  ```typescript
  import { validatePath } from "../security.js";
  ```

  In `getModSource`, replace the current `join` call:
  ```typescript
  // BEFORE
  const filePath = join(decompPath, path);
  ```
  with:
  ```typescript
  // AFTER
  const filePath = validatePath(path, decompPath);
  ```

  This replaces the unsafe `join` — `validatePath` calls `resolve(decompPath, path)` internally and throws if it escapes.

- [ ] **Also apply to `searchSource` regex construction**

  In `searchSource`, replace:
  ```typescript
  const regex = isRegex ? new RegExp(query, "i") : null;
  ```
  with:
  ```typescript
  import { safeRegex } from "../security.js";
  // ...
  const regex = isRegex ? safeRegex(query) : null;
  ```

- [ ] **Run type-check and tests**

  ```powershell
  npx tsc --noEmit
  npm test
  ```
  Expected: clean.

- [ ] **Commit**

  ```powershell
  git add src/tools/source.ts
  git commit -m "fix(security): path traversal + ReDoS in getModSource/searchSource"
  ```

---

## Task 3: Apply `safeRegex` to `searchMcCode`

- [ ] **Edit `src/tools/vanilla.ts`**

  Add import:
  ```typescript
  import { safeRegex } from "../security.js";
  ```

  In `searchMcCode`, replace every `new RegExp(effectiveQuery, "i")` in the switch block with `safeRegex(effectiveQuery)`.

  Specifically the four branches:
  ```typescript
  // BEFORE (example — class branch)
  pattern = new RegExp(`(?:class|interface|enum|record)\\s+.*${effectiveQuery}`, "i");
  // AFTER
  pattern = safeRegex(`(?:class|interface|enum|record)\\s+.*${effectiveQuery}`);
  ```

  Do the same for `method`, `field`, and `content/all` branches.

- [ ] **Run type-check and full test suite**

  ```powershell
  npx tsc --noEmit
  npm test
  ```
  Expected: clean, all tests pass.

- [ ] **Commit**

  ```powershell
  git add src/tools/vanilla.ts
  git commit -m "fix(security): ReDoS guard on searchMcCode regex construction"
  ```
