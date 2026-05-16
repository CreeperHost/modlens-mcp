# Mappings Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a test suite for `src/mappings.ts` covering the two pure functions: `parseTinyV2` (builds the in-memory index from TinyV2 content) and `lookupInIndex` (used internally by `translateSymbol`). Neither function makes HTTP requests or touches the filesystem, so tests are self-contained fixtures.

**Architecture:** `parseTinyV2` and `lookupInIndex` are not currently exported. We export them (non-breaking since they're pure helpers), then write fixture-driven tests. `translateSymbol` is the public API but it is `async` and tries to download mappings — we mock those paths and test indirectly, or test `parseTinyV2` + the structure it returns.

**Tech Stack:** Vitest, inline TinyV2 fixture strings (no file I/O)

---

## File Map

- **Create:** `src/mappings.test.ts`
- **Modify:** `src/mappings.ts` (export 2 helpers)

---

## Task 1: Export `parseTinyV2` and `lookupInIndex`

- [ ] **Step 1: Export `parseTinyV2` from `src/mappings.ts`**

  Change:
  ```typescript
  function parseTinyV2(content: string): TinyV2Index {
  ```
  to:
  ```typescript
  export function parseTinyV2(content: string): TinyV2Index {
  ```

- [ ] **Step 2: Export `lookupInIndex` from `src/mappings.ts`**

  Change:
  ```typescript
  function lookupInIndex(idx: TinyV2Index, symbol: string, reverse: boolean): TranslateResult {
  ```
  to:
  ```typescript
  export function lookupInIndex(idx: TinyV2Index, symbol: string, reverse: boolean): TranslateResult {
  ```

- [ ] **Step 3: Verify type-check still passes**

  ```powershell
  npx tsc --noEmit
  ```
  Expected: no errors.

---

## Task 2: `parseTinyV2` — index structure

Minimal fixture TinyV2 content used throughout this plan:

```
tiny	2	0	official	intermediary
c	net/minecraft/world/World	net/minecraft/class_234
	f	I	field_1234	field_1234_
	m	()V	method_1234	method_1234_
c	net/minecraft/entity/Entity	net/minecraft/class_100
	m	(Ljava/lang/String;)Z	method_5678	method_5678_
```

- [ ] **Step 1: Create `src/mappings.test.ts` with fixture and first tests**

  ```typescript
  import { describe, it, expect } from "vitest";
  import { parseTinyV2, lookupInIndex } from "./mappings.js";

  const FIXTURE_TINY = [
      "tiny\t2\t0\tofficial\tintermediary",
      "c\tnet/minecraft/world/World\tnet/minecraft/class_234",
      "\tf\tI\tfield_1234\tfield_1234_",
      "\tm\t()V\tmethod_1234\tmethod_1234_",
      "c\tnet/minecraft/entity/Entity\tnet/minecraft/class_100",
      "\tm\t(Ljava/lang/String;)Z\tmethod_5678\tmethod_5678_",
  ].join("\n");

  describe("parseTinyV2", () => {
      it("reads namespace headers from first line", () => {
          const idx = parseTinyV2(FIXTURE_TINY);
          expect(idx.ns[0]).toBe("official");
          expect(idx.ns[1]).toBe("intermediary");
      });

      it("maps official class name to intermediary name", () => {
          const idx = parseTinyV2(FIXTURE_TINY);
          expect(idx.classes.get("net/minecraft/world/World")).toBe("net/minecraft/class_234");
          expect(idx.classes.get("net/minecraft/entity/Entity")).toBe("net/minecraft/class_100");
      });

      it("maps method key 'name+descriptor' within the correct class", () => {
          const idx = parseTinyV2(FIXTURE_TINY);
          const worldMethods = idx.methods.get("net/minecraft/world/World");
          expect(worldMethods).toBeDefined();
          expect(worldMethods!.get("method_1234()V")).toBe("method_1234_");
      });

      it("maps field key 'name:descriptor' within the correct class", () => {
          const idx = parseTinyV2(FIXTURE_TINY);
          const worldFields = idx.fields.get("net/minecraft/world/World");
          expect(worldFields).toBeDefined();
          expect(worldFields!.get("field_1234:I")).toBe("field_1234_");
      });

      it("handles class with no fields or methods", () => {
          const tiny = "tiny\t2\t0\tofficial\tintermediary\nc\tnet/minecraft/A\tnet/minecraft/class_1";
          const idx = parseTinyV2(tiny);
          expect(idx.classes.get("net/minecraft/A")).toBe("net/minecraft/class_1");
          expect(idx.methods.get("net/minecraft/A")).toBeDefined();
          expect(idx.methods.get("net/minecraft/A")!.size).toBe(0);
      });

      it("ignores comment lines starting with #", () => {
          const tiny = [
              "tiny\t2\t0\tofficial\tintermediary",
              "# this is a comment",
              "c\tnet/minecraft/A\tnet/minecraft/class_1",
          ].join("\n");
          const idx = parseTinyV2(tiny);
          expect(idx.classes.size).toBe(1);
      });
  });
  ```

- [ ] **Step 2: Run to verify all 6 tests pass**

  ```powershell
  npx vitest run src/mappings.test.ts
  ```
  Expected: FAIL (exports not added yet) → after Step 1 of Task 1: PASS (6 tests).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/mappings.ts src/mappings.test.ts
  git commit -m "test: parseTinyV2 index structure"
  ```

---

## Task 3: `lookupInIndex` — forward and reverse lookups

- [ ] **Step 1: Write failing lookup tests**

  Append to `src/mappings.test.ts`:
  ```typescript
  describe("lookupInIndex — forward (official → intermediary)", () => {
      let idx: ReturnType<typeof parseTinyV2>;
      beforeAll(() => { idx = parseTinyV2(FIXTURE_TINY); });

      it("finds a class by official name", () => {
          const r = lookupInIndex(idx, "net/minecraft/world/World", false);
          expect(r.found).toBe(true);
          expect(r.target).toBe("net/minecraft/class_234");
          expect(r.type).toBe("class");
      });

      it("finds a method by name only (no descriptor)", () => {
          const r = lookupInIndex(idx, "method_1234", false);
          expect(r.found).toBe(true);
          expect(r.target).toBe("method_1234_");
          expect(r.type).toBe("method");
      });

      it("finds a field by name", () => {
          const r = lookupInIndex(idx, "field_1234", false);
          expect(r.found).toBe(true);
          expect(r.target).toBe("field_1234_");
          expect(r.type).toBe("field");
      });

      it("returns found=false for unknown symbol", () => {
          const r = lookupInIndex(idx, "nonexistent_method", false);
          expect(r.found).toBe(false);
      });
  });

  describe("lookupInIndex — reverse (intermediary → official)", () => {
      let idx: ReturnType<typeof parseTinyV2>;
      beforeAll(() => { idx = parseTinyV2(FIXTURE_TINY); });

      it("reverse-finds a class by intermediary name", () => {
          const r = lookupInIndex(idx, "net/minecraft/class_234", true);
          expect(r.found).toBe(true);
          expect(r.target).toBe("net/minecraft/world/World");
          expect(r.type).toBe("class");
      });

      it("reverse-finds a method by intermediary name", () => {
          const r = lookupInIndex(idx, "method_1234_", true);
          expect(r.found).toBe(true);
          expect(r.type).toBe("method");
      });

      it("reverse-finds a field by intermediary name", () => {
          const r = lookupInIndex(idx, "field_1234_", true);
          expect(r.found).toBe(true);
          expect(r.type).toBe("field");
      });

      it("returns found=false for unknown reverse symbol", () => {
          const r = lookupInIndex(idx, "class_9999_unknown", true);
          expect(r.found).toBe(false);
      });
  });
  ```

  Add import for `beforeAll` at the top of the file:
  ```typescript
  import { describe, it, expect, beforeAll } from "vitest";
  ```

- [ ] **Step 2: Run to verify 14 tests pass**

  ```powershell
  npx vitest run src/mappings.test.ts
  ```
  Expected: PASS (14 tests total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/mappings.test.ts
  git commit -m "test: lookupInIndex forward and reverse symbol lookup"
  ```

---

## Task 4: Full test suite validation

- [ ] **Step 1: Run full test suite**

  ```powershell
  npm test
  ```
  Expected: all previous tests still pass plus the new 14 mapping tests.

- [ ] **Step 2: Type-check**

  ```powershell
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit if not already committed**

  ```powershell
  git add -A
  git commit -m "test: mappings parseTinyV2 + lookupInIndex full suite"
  ```
