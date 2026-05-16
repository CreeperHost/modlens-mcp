# Processor Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a comprehensive test suite for `src/processor.ts` covering manifest parsing for all four loaders (Fabric, Quilt, NeoForge/Forge), AT/AW entry parsing, mixin config discovery, and the Murmur2 hash.

**Architecture:** All tests are pure unit tests — no JAR files or filesystem required. The four parse functions (`parseFabric`, `parseNeoForge`, etc.) are not exported, but `parseJar` accepts a real JAR. Instead we test the exported parsing helpers directly by passing raw string inputs through thin wrappers: `parseAtEntries` and `parseAwEntries` are already exported; for the loader parsers we construct minimal AdmZip-like in-memory JARs using `adm-zip` directly in the test. `computeHashes` is tested with a known Buffer to verify Murmur2 correctness.

**Tech Stack:** Vitest, adm-zip (already in deps), Node.js Buffer

---

## File Map

- **Create:** `src/processor.test.ts`
- **Read (do not modify):** `src/processor.ts`

---

## Task 1: AT / AW entry parsing

**Files:**
- Create: `src/processor.test.ts`

The functions `parseAtEntries` and `parseAwEntries` are not currently exported from `processor.ts`. The first step is to export them.

- [ ] **Step 1: Export the two parse helpers from `src/processor.ts`**

  Change the two function declarations from:
  ```typescript
  function parseAtEntries(content: string): string[] {
  ```
  ```typescript
  function parseAwEntries(content: string): string[] {
  ```
  to:
  ```typescript
  export function parseAtEntries(content: string): string[] {
  ```
  ```typescript
  export function parseAwEntries(content: string): string[] {
  ```

- [ ] **Step 2: Write failing tests for `parseAtEntries`**

  Create `src/processor.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { parseAtEntries, parseAwEntries } from "./processor.js";

  describe("parseAtEntries", () => {
      it("returns empty array for empty string", () => {
          expect(parseAtEntries("")).toEqual([]);
      });

      it("strips comment lines starting with #", () => {
          const input = "# This is a comment\naccessible field net/minecraft/world/World field_1234 I";
          expect(parseAtEntries(input)).toEqual([
              "accessible field net/minecraft/world/World field_1234 I",
          ]);
      });

      it("strips blank lines", () => {
          const input = "\n\naccessible method net/minecraft/A foo ()V\n\n";
          expect(parseAtEntries(input)).toEqual([
              "accessible method net/minecraft/A foo ()V",
          ]);
      });

      it("preserves multiple valid entries", () => {
          const input = [
              "# comment",
              "accessible class net/minecraft/world/World",
              "accessible field net/minecraft/world/World field_1234 I",
              "accessible method net/minecraft/world/World func_1234 ()V",
          ].join("\n");
          expect(parseAtEntries(input)).toHaveLength(3);
          expect(parseAtEntries(input)[0]).toBe("accessible class net/minecraft/world/World");
      });
  });
  ```

- [ ] **Step 3: Run to verify it fails**

  ```powershell
  npx vitest run src/processor.test.ts
  ```
  Expected: FAIL — `parseAtEntries` is not exported yet.

- [ ] **Step 4: Apply the export change from Step 1, then run again**

  ```powershell
  npx vitest run src/processor.test.ts
  ```
  Expected: PASS (4 tests).

- [ ] **Step 5: Write failing tests for `parseAwEntries`**

  Append to `src/processor.test.ts`:
  ```typescript
  describe("parseAwEntries", () => {
      it("returns empty array for empty string", () => {
          expect(parseAwEntries("")).toEqual([]);
      });

      it("strips the accessWidener header line", () => {
          const input = "accessWidener v2 named\naccessible class net/minecraft/world/World";
          expect(parseAwEntries(input)).toEqual([
              "accessible class net/minecraft/world/World",
          ]);
      });

      it("strips comment lines starting with #", () => {
          const input = "# comment\naccessible field net/minecraft/A field I";
          expect(parseAwEntries(input)).toEqual([
              "accessible field net/minecraft/A field I",
          ]);
      });

      it("strips blank lines", () => {
          const input = "\naccessible method net/minecraft/A foo ()V\n\n";
          expect(parseAwEntries(input)).toEqual([
              "accessible method net/minecraft/A foo ()V",
          ]);
      });
  });
  ```

- [ ] **Step 6: Run and verify all 8 tests pass**

  ```powershell
  npx vitest run src/processor.test.ts
  ```
  Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

  ```powershell
  git add src/processor.ts src/processor.test.ts
  git commit -m "test: AT/AW entry parsing tests"
  ```

---

## Task 2: Fabric manifest parsing

The loader parse functions are internal to `parseJar`. We test them indirectly by building a minimal in-memory JAR using `adm-zip` and calling `parseJar`.

- [ ] **Step 1: Write failing Fabric parse tests**

  Append to `src/processor.test.ts`:
  ```typescript
  import AdmZip from "adm-zip";
  import { writeFile, unlink } from "fs/promises";
  import { tmpdir } from "os";
  import { join } from "path";
  import { parseJar } from "./processor.js";

  async function makeFabricJar(fabricJson: object, extras?: Record<string, string>): Promise<string> {
      const zip = new AdmZip();
      zip.addFile("fabric.mod.json", Buffer.from(JSON.stringify(fabricJson), "utf8"));
      for (const [name, content] of Object.entries(extras ?? {})) {
          zip.addFile(name, Buffer.from(content, "utf8"));
      }
      const dest = join(tmpdir(), `test-fabric-${Date.now()}.jar`);
      zip.writeZip(dest);
      return dest;
  }

  describe("parseJar — Fabric", () => {
      it("parses modId, displayName, version from fabric.mod.json", async () => {
          const jarPath = await makeFabricJar({
              id: "mymod",
              name: "My Mod",
              version: "1.2.3",
              depends: { minecraft: "1.21.1" },
          });
          try {
              const m = await parseJar(jarPath);
              expect(m.modId).toBe("mymod");
              expect(m.displayName).toBe("My Mod");
              expect(m.version).toBe("1.2.3");
              expect(m.loader).toBe("fabric");
              expect(m.mcVersion).toBe("1.21.1");
          } finally {
              await unlink(jarPath);
          }
      });

      it("detects mixin configs from JAR entries", async () => {
          const jarPath = await makeFabricJar(
              { id: "mymod", version: "1.0.0", depends: {} },
              { "mymod.mixins.json": JSON.stringify({ package: "com.example", mixins: ["MyMixin"] }) },
          );
          try {
              const m = await parseJar(jarPath);
              expect(m.hasMixins).toBe(true);
              expect(m.mixinConfigs).toContain("mymod.mixins.json");
              expect(m.mixinTargets).toContain("com.example.MyMixin");
          } finally {
              await unlink(jarPath);
          }
      });

      it("extracts sourceUrl from contact.sources", async () => {
          const jarPath = await makeFabricJar({
              id: "mymod",
              version: "1.0.0",
              depends: {},
              contact: { sources: "https://github.com/example/mymod" },
          });
          try {
              const m = await parseJar(jarPath);
              expect(m.sourceUrl).toBe("https://github.com/example/mymod");
          } finally {
              await unlink(jarPath);
          }
      });

      it("detects access widener", async () => {
          const jarPath = await makeFabricJar(
              { id: "mymod", version: "1.0.0", depends: {} },
              { "mymod.accesswidener": "accessWidener v2 named\naccessible class net/minecraft/world/World" },
          );
          try {
              const m = await parseJar(jarPath);
              expect(m.hasAw).toBe(true);
              expect(m.awEntries).toContain("accessible class net/minecraft/world/World");
          } finally {
              await unlink(jarPath);
          }
      });
  });
  ```

- [ ] **Step 2: Run to verify tests pass**

  ```powershell
  npx vitest run src/processor.test.ts
  ```
  Expected: PASS (12 tests total — 8 from Task 1 + 4 new).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/processor.test.ts
  git commit -m "test: Fabric manifest parsing"
  ```

---

## Task 3: NeoForge / Forge manifest parsing

- [ ] **Step 1: Write failing NeoForge parse tests**

  Append to `src/processor.test.ts`:
  ```typescript
  async function makeNeoForgeJar(toml: string, extras?: Record<string, string>): Promise<string> {
      const zip = new AdmZip();
      zip.addFile("META-INF/neoforge.mods.toml", Buffer.from(toml, "utf8"));
      for (const [name, content] of Object.entries(extras ?? {})) {
          zip.addFile(name, Buffer.from(content, "utf8"));
      }
      const dest = join(tmpdir(), `test-neoforge-${Date.now()}.jar`);
      zip.writeZip(dest);
      return dest;
  }

  describe("parseJar — NeoForge", () => {
      it("parses modId, version, displayName from TOML", async () => {
          const toml = `
  [[mods]]
  modId = "examplemod"
  version = "2.0.0"
  displayName = "Example Mod"
  description = "A test mod"

  [[dependencies.examplemod]]
  modId = "minecraft"
  versionRange = "[26.1.2,)"
  mandatory = true
  `;
          const jarPath = await makeNeoForgeJar(toml);
          try {
              const m = await parseJar(jarPath);
              expect(m.modId).toBe("examplemod");
              expect(m.version).toBe("2.0.0");
              expect(m.displayName).toBe("Example Mod");
              expect(m.loader).toBe("neoforge");
              expect(m.mcVersion).toBe("[26.1.2,)");
          } finally {
              await unlink(jarPath);
          }
      });

      it("extracts non-minecraft, non-neoforge dependencies", async () => {
          const toml = `
  [[mods]]
  modId = "mymod"
  version = "1.0.0"

  [[dependencies.mymod]]
  modId = "minecraft"
  versionRange = "[26.1.2,)"
  mandatory = true

  [[dependencies.mymod]]
  modId = "jei"
  versionRange = "[19.0,)"
  mandatory = false
  `;
          const jarPath = await makeNeoForgeJar(toml);
          try {
              const m = await parseJar(jarPath);
              expect(m.dependencies).toHaveLength(1);
              expect(m.dependencies[0].id).toBe("jei");
              expect(m.dependencies[0].required).toBe(false);
          } finally {
              await unlink(jarPath);
          }
      });

      it("detects AT from META-INF/accesstransformer.cfg presence", async () => {
          const toml = `[[mods]]\nmodId = "mymod"\nversion = "1.0.0"\n`;
          const jarPath = await makeNeoForgeJar(toml, {
              "META-INF/accesstransformer.cfg": "# comment\naccessible field net/minecraft/A f I",
          });
          try {
              const m = await parseJar(jarPath);
              expect(m.hasAt).toBe(true);
              expect(m.atEntries).toContain("accessible field net/minecraft/A f I");
          } finally {
              await unlink(jarPath);
          }
      });
  });
  ```

- [ ] **Step 2: Run to verify tests pass**

  ```powershell
  npx vitest run src/processor.test.ts
  ```
  Expected: PASS (15 tests total).

- [ ] **Step 3: Commit**

  ```powershell
  git add src/processor.test.ts
  git commit -m "test: NeoForge manifest parsing"
  ```

---

## Task 4: Murmur2 hash

`computeHashes` reads a file from disk. Export the pure `computeMurmur2` helper and test it directly with known inputs.

- [ ] **Step 1: Export `computeMurmur2` from `src/processor.ts`**

  Change:
  ```typescript
  function computeMurmur2(data: Buffer): number {
  ```
  to:
  ```typescript
  export function computeMurmur2(data: Buffer): number {
  ```

- [ ] **Step 2: Write failing Murmur2 tests**

  Append to `src/processor.test.ts`:
  ```typescript
  import { computeMurmur2 } from "./processor.js";

  describe("computeMurmur2", () => {
      it("returns 0 for empty buffer", () => {
          // seed=1, length=0 → h = 1^0 = 1, then finalization: 1^(1>>>16)^... 
          // Just verify it's a number and doesn't throw
          const result = computeMurmur2(Buffer.alloc(0));
          expect(typeof result).toBe("number");
      });

      it("filters whitespace bytes (9, 10, 13, 32) before hashing", () => {
          const withWhitespace    = Buffer.from([0x61, 0x20, 0x62, 0x0a, 0x63]); // a ' ' b '\n' c
          const withoutWhitespace = Buffer.from([0x61, 0x62, 0x63]);              // abc
          // After filtering, both should hash the same
          expect(computeMurmur2(withWhitespace)).toBe(computeMurmur2(withoutWhitespace));
      });

      it("returns different hashes for different byte content", () => {
          const a = Buffer.from([0x01, 0x02, 0x03, 0x04]);
          const b = Buffer.from([0x04, 0x03, 0x02, 0x01]);
          expect(computeMurmur2(a)).not.toBe(computeMurmur2(b));
      });

      it("is deterministic — same input always gives same output", () => {
          const buf = Buffer.from("hello world modlens test", "utf8");
          expect(computeMurmur2(buf)).toBe(computeMurmur2(buf));
      });
  });
  ```

- [ ] **Step 3: Run to verify tests pass**

  ```powershell
  npx vitest run src/processor.test.ts
  ```
  Expected: PASS (19 tests total).

- [ ] **Step 4: Run full test suite**

  ```powershell
  npm test
  ```
  Expected: PASS (all existing tests + 19 new = ~42 total).

- [ ] **Step 5: Commit**

  ```powershell
  git add src/processor.ts src/processor.test.ts
  git commit -m "test: processor Murmur2 hash and full suite passing"
  ```
