# Stability: MCP Tool Input Validation Guards

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MCP tool handlers in `src/server.ts` receive user-supplied parameters (dbId, version strings, class names, file paths) validated only by Zod schema types. Several tools pass these directly to DB queries or filesystem operations with no semantic validation. This plan adds a shared `validateInput` module with lightweight guards and applies them to the most critical call sites.

**Scope (highest risk first):**
1. `dbId` parameters — integer ≥ 1; reject 0, negatives, NaN, floats
2. `version` strings — non-empty, reasonable length, no shell metacharacters
3. `className` strings — valid Java binary class name format
4. File `path` parameters — already covered by the path-traversal plan; reuse `validatePath`

**Files to create:** `src/validate.ts`, `src/validate.test.ts`
**Files to modify:** `src/tools/ingest.ts` (reindexClasses), `src/tools/source.ts` (getModSource), `src/tools/bytecode.ts` (searchModClass, getModClassBytecode), `src/tools/vanilla.ts` (getMinecraftSource, getMcClassBytecode)

---

## Task 1: Create `src/validate.ts` with guards

- [ ] **Write failing tests first (`src/validate.test.ts`)**

  ```typescript
  import { describe, it, expect } from "vitest";
  import { validateDbId, validateVersion, validateClassName } from "./validate.js";

  describe("validateDbId", () => {
      it("accepts a valid positive integer", () => {
          expect(() => validateDbId(1)).not.toThrow();
          expect(() => validateDbId(999999)).not.toThrow();
      });

      it("throws for zero", () => {
          expect(() => validateDbId(0)).toThrow("dbId");
      });

      it("throws for negative", () => {
          expect(() => validateDbId(-1)).toThrow("dbId");
      });

      it("throws for non-integer (float)", () => {
          expect(() => validateDbId(1.5)).toThrow("dbId");
      });

      it("throws for NaN", () => {
          expect(() => validateDbId(NaN)).toThrow("dbId");
      });

      it("returns the id on success", () => {
          expect(validateDbId(42)).toBe(42);
      });
  });

  describe("validateVersion", () => {
      it("accepts a normal MC version string", () => {
          expect(() => validateVersion("1.21.1")).not.toThrow();
          expect(() => validateVersion("26.1.2")).not.toThrow();
      });

      it("throws for empty string", () => {
          expect(() => validateVersion("")).toThrow("version");
      });

      it("throws for excessively long string", () => {
          expect(() => validateVersion("a".repeat(65))).toThrow("version");
      });

      it("throws for strings with shell metacharacters", () => {
          expect(() => validateVersion("1.21; rm -rf /")).toThrow("version");
          expect(() => validateVersion("1.21 && echo hi")).toThrow("version");
          expect(() => validateVersion("1.21`id`")).toThrow("version");
      });

      it("returns the version string on success", () => {
          expect(validateVersion("1.21.1")).toBe("1.21.1");
      });
  });

  describe("validateClassName", () => {
      it("accepts valid Java binary class names", () => {
          expect(() => validateClassName("net/minecraft/world/World")).not.toThrow();
          expect(() => validateClassName("com/example/MyMod")).not.toThrow();
      });

      it("accepts dot-separated names too", () => {
          expect(() => validateClassName("net.minecraft.world.World")).not.toThrow();
      });

      it("throws for empty string", () => {
          expect(() => validateClassName("")).toThrow("className");
      });

      it("throws for strings with path traversal sequences", () => {
          expect(() => validateClassName("../evil/Class")).toThrow("className");
      });

      it("throws for strings with shell metacharacters", () => {
          expect(() => validateClassName("net/mc/World; rm -rf /")).toThrow("className");
      });

      it("throws for excessively long class name", () => {
          expect(() => validateClassName("a/".repeat(100))).toThrow("className");
      });

      it("returns the class name on success", () => {
          expect(validateClassName("net/minecraft/world/World")).toBe("net/minecraft/world/World");
      });
  });
  ```

- [ ] **Run — expect FAIL (module not yet created)**

  ```powershell
  npx vitest run src/validate.test.ts
  ```

- [ ] **Create `src/validate.ts`**

  ```typescript
  /**
   * Lightweight semantic validators for MCP tool inputs.
   * Throw descriptive errors on invalid input.
   */

  const VERSION_MAX_LEN = 64;
  const CLASS_MAX_LEN = 200;
  const SHELL_META = /[;&|`$<>\\'"*?{}[\]!#~]/;

  /**
   * Validate a database record ID: must be a positive integer.
   */
  export function validateDbId(id: number): number {
      if (!Number.isInteger(id) || id < 1) {
          throw new Error(`Invalid dbId: expected a positive integer, got ${id}`);
      }
      return id;
  }

  /**
   * Validate a Minecraft version string.
   * Must be non-empty, ≤64 chars, no shell metacharacters.
   */
  export function validateVersion(version: string): string {
      if (!version || version.length === 0) {
          throw new Error(`Invalid version: must not be empty`);
      }
      if (version.length > VERSION_MAX_LEN) {
          throw new Error(`Invalid version: too long (max ${VERSION_MAX_LEN} chars)`);
      }
      if (SHELL_META.test(version)) {
          throw new Error(`Invalid version: contains illegal characters`);
      }
      return version;
  }

  /**
   * Validate a Java class name (slash- or dot-separated binary format).
   * Must be non-empty, ≤200 chars, no path traversal, no shell metacharacters.
   */
  export function validateClassName(className: string): string {
      if (!className || className.length === 0) {
          throw new Error(`Invalid className: must not be empty`);
      }
      if (className.length > CLASS_MAX_LEN) {
          throw new Error(`Invalid className: too long (max ${CLASS_MAX_LEN} chars)`);
      }
      if (className.includes("..")) {
          throw new Error(`Invalid className: path traversal sequence detected`);
      }
      if (SHELL_META.test(className)) {
          throw new Error(`Invalid className: contains illegal characters`);
      }
      return className;
  }
  ```

- [ ] **Run tests — expect PASS**

  ```powershell
  npx vitest run src/validate.test.ts
  ```
  Expected: all tests pass.

- [ ] **Commit**

  ```powershell
  git add src/validate.ts src/validate.test.ts
  git commit -m "feat: validateDbId/validateVersion/validateClassName input guards with tests"
  ```

---

## Task 2: Apply guards to high-risk tool entry points

Apply at the top of each public tool function, before any DB/filesystem access.

- [ ] **`src/tools/source.ts` — `getModSource` and `searchSource`**

  ```typescript
  import { validateDbId, validateClassName } from "../validate.js";

  export async function getModSource(dbId: number, path?: string): Promise<string> {
      validateDbId(dbId);
      // ... rest unchanged
  }

  export async function searchSource(query: string, dbId?: number, isRegex = false, limit = 50) {
      if (dbId !== undefined) validateDbId(dbId);
      // ... rest unchanged
  }
  ```

- [ ] **`src/tools/ingest.ts` — `reindexClasses`**

  ```typescript
  import { validateDbId } from "../validate.js";

  export async function reindexClasses(dbId?: number) {
      if (dbId !== undefined) validateDbId(dbId);
      // ... rest unchanged
  }
  ```

- [ ] **`src/tools/vanilla.ts` — `getMinecraftSource`, `getMcClassBytecode`, `getMcClassMembers`, `searchMcCode`**

  ```typescript
  import { validateVersion, validateClassName } from "../validate.js";

  export async function getMinecraftSource(version: string, className: string, ...) {
      validateVersion(version);
      validateClassName(className);
      // ... rest unchanged
  }
  // Apply similarly to getMcClassBytecode, getMcClassMembers, searchMcCode
  ```

- [ ] **`src/tools/bytecode.ts` — `searchModClass`, `getModClassBytecode`, `getModClassMembers`**

  ```typescript
  import { validateDbId, validateClassName } from "../validate.js";

  export async function getModClassBytecode(dbId: number, className: string) {
      validateDbId(dbId);
      validateClassName(className);
      // ... rest unchanged
  }
  // Apply similarly to searchModClass, getModClassMembers
  ```

- [ ] **Run type-check and full test suite**

  ```powershell
  npx tsc --noEmit
  npm test
  ```
  Expected: clean, all pass.

- [ ] **Commit**

  ```powershell
  git add src/tools/source.ts src/tools/ingest.ts src/tools/vanilla.ts src/tools/bytecode.ts
  git commit -m "fix: apply input validation guards to high-risk tool entry points"
  ```
