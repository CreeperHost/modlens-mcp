# Security: GitHub Source Download SHA Verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `downloadSource` in `src/tools/platform.ts` fetches a ZIP from GitHub and extracts it to disk with zero integrity verification. A MITM attacker or a compromised CDN could serve a tampered archive. We should verify the downloaded ZIP against the SHA-256 of the file provided by the platform metadata (CurseForge/Modrinth) before extracting.

**Approach:**
- Modrinth version objects include `files[].hashes.sha1` and `files[].hashes.sha512`.
- CurseForge file objects include `fileFingerprint` (Murmur2) but no SHA-256 of the source ZIP.
- For GitHub ZIPs (no platform hash available): compute SHA-256 of the downloaded ZIP and store it in the mod's `metadata.sourceZipSha256` for future auditing. Do not block extraction — warn instead.
- For Modrinth-linked mods: compare downloaded file SHA against `files[0].hashes.sha512`.
- Add helper `verifyFileHash(filePath, expectedSha512)` to `src/security.ts`.

**Files to modify:** `src/tools/platform.ts`, `src/security.ts`, `src/security.test.ts`

---

## Task 1: Add `verifyFileHash` to security helpers

- [ ] **Append to `src/security.ts`**

  ```typescript
  import { createHash } from "crypto";
  import { readFile } from "fs/promises";

  /**
   * Compute the SHA-512 hex digest of a file on disk.
   */
  export async function fileSha512(filePath: string): Promise<string> {
      const buf = await readFile(filePath);
      return createHash("sha512").update(buf).digest("hex");
  }

  /**
   * Verify a file's SHA-512 against an expected value.
   * Throws `HashMismatchError` if they differ.
   */
  export class HashMismatchError extends Error {
      constructor(filePath: string, expected: string, actual: string) {
          super(`SHA-512 mismatch for ${filePath}:\n  expected: ${expected}\n  actual:   ${actual}`);
          this.name = "HashMismatchError";
      }
  }

  export async function verifyFileHash(filePath: string, expectedSha512: string): Promise<void> {
      const actual = await fileSha512(filePath);
      if (actual !== expectedSha512.toLowerCase()) {
          throw new HashMismatchError(filePath, expectedSha512.toLowerCase(), actual);
      }
  }
  ```

- [ ] **Write tests first in `src/security.test.ts`**

  Append:
  ```typescript
  import { fileSha512, verifyFileHash, HashMismatchError } from "./security.js";
  import { writeFile } from "fs/promises";
  import { join } from "path";
  import { createHash } from "crypto";

  describe("fileSha512", () => {
      it("returns hex SHA-512 of a known buffer", async () => {
          const content = Buffer.from("hello world", "utf8");
          const expected = createHash("sha512").update(content).digest("hex");
          const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
          await writeFile(tmpFile, content);
          try {
              expect(await fileSha512(tmpFile)).toBe(expected);
          } finally {
              await import("fs/promises").then((f) => f.unlink(tmpFile).catch(() => {}));
          }
      });
  });

  describe("verifyFileHash", () => {
      it("resolves without error when hash matches", async () => {
          const content = Buffer.from("test data", "utf8");
          const expected = createHash("sha512").update(content).digest("hex");
          const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
          await writeFile(tmpFile, content);
          try {
              await expect(verifyFileHash(tmpFile, expected)).resolves.toBeUndefined();
          } finally {
              await import("fs/promises").then((f) => f.unlink(tmpFile).catch(() => {}));
          }
      });

      it("throws HashMismatchError when hash does not match", async () => {
          const content = Buffer.from("real data", "utf8");
          const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
          await writeFile(tmpFile, content);
          try {
              const wrong = "a".repeat(128);
              await expect(verifyFileHash(tmpFile, wrong)).rejects.toBeInstanceOf(HashMismatchError);
          } finally {
              await import("fs/promises").then((f) => f.unlink(tmpFile).catch(() => {}));
          }
      });

      it("HashMismatchError carries expected and actual in message", async () => {
          const content = Buffer.from("data", "utf8");
          const tmpFile = join(tmpdir(), `security-test-${Date.now()}.bin`);
          await writeFile(tmpFile, content);
          try {
              try {
                  await verifyFileHash(tmpFile, "0".repeat(128));
              } catch (e) {
                  expect(e).toBeInstanceOf(HashMismatchError);
                  expect((e as Error).message).toContain("expected");
                  expect((e as Error).message).toContain("actual");
              }
          } finally {
              await import("fs/promises").then((f) => f.unlink(tmpFile).catch(() => {}));
          }
      });
  });
  ```

- [ ] **Run tests — expect PASS**

  ```powershell
  npx vitest run src/security.test.ts
  ```
  Expected: all tests pass (10 existing + 4 new = 14).

- [ ] **Commit**

  ```powershell
  git add src/security.ts src/security.test.ts
  git commit -m "feat(security): fileSha512 + verifyFileHash helpers with tests"
  ```

---

## Task 2: Apply SHA verification in `downloadSource`

The download flow in `src/tools/platform.ts` (`downloadSource`):
1. Fetches GitHub ZIP → writes to `zipPath`
2. Extracts to `outDir` with `zip.extractAllTo()`

The mod may have Modrinth metadata with `files[0].hashes.sha512`. We retrieve that before download and verify after writing the ZIP. If the mod isn't Modrinth-linked, we compute and store the SHA for auditability.

- [ ] **Edit `src/tools/platform.ts`**

  Add import:
  ```typescript
  import { fileSha512, verifyFileHash, HashMismatchError } from "../security.js";
  import { getModMetadata } from "../repositories/mod.js";
  ```

  After the ZIP write (after the `pipeline(...)` calls complete), add:
  ```typescript
  // ── Integrity check ────────────────────────────────────────────────────────
  const meta = mod.metadata as Record<string, unknown>;
  const expectedSha512 = meta.modrinthFileSha512 as string | undefined;

  if (expectedSha512) {
      // Hard failure: platform-provided hash does not match
      try {
          await verifyFileHash(zipPath, expectedSha512);
      } catch (e) {
          if (e instanceof HashMismatchError) {
              // Remove the tampered ZIP before throwing
              await import("fs/promises").then((f) => f.unlink(zipPath).catch(() => {}));
              throw new Error(`Source ZIP integrity check FAILED for mod #${dbId}: ${e.message}`);
          }
          throw e;
      }
  } else {
      // No expected hash — record actual hash for future auditing
      const actualSha = await fileSha512(zipPath);
      await updateMod(dbId, {
          metadata: { ...(mod.metadata as object), sourceZipSha256: actualSha } as any,
      });
  }
  ```

  Wrap `zip.extractAllTo(outDir, true)` in try/catch:
  ```typescript
  try {
      zip.extractAllTo(outDir, true);
  } catch (e) {
      throw new Error(`Failed to extract source ZIP for mod #${dbId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  ```

- [ ] **Run type-check and full tests**

  ```powershell
  npx tsc --noEmit
  npm test
  ```
  Expected: clean.

- [ ] **Commit**

  ```powershell
  git add src/tools/platform.ts
  git commit -m "fix(security): verify GitHub source ZIP integrity before extraction"
  ```

---

## Task 3: Store Modrinth file SHA during platform sync

When `syncModrinth` runs, it calls `getMrProject` / `lookupBySha512` but doesn't persist the file's SHA-512. We need to store it in metadata so `downloadSource` can use it.

- [ ] **Edit `src/tools/ingest.ts` `lookupPlatforms`**

  In the Modrinth branch, the `ver` object (a Modrinth version) has `ver.files[0].hashes.sha512`. Store it:
  ```typescript
  // After resolving the project:
  return {
      platform: "modrinth" as const,
      projectId: ver.project_id,
      slug: proj?.slug,
      sourceUrl: proj?.source_url,
      fileSha512: ver.files?.[0]?.hashes?.sha512 ?? null,   // ← add this
  };
  ```

  Then in `ingestMod`, when updating the mod's metadata with the Modrinth hit, include `modrinthFileSha512`:
  ```typescript
  merged = {
      ...merged,
      modrinthSlug: hit.slug,
      sourceUrl: merged.sourceUrl ?? hit.sourceUrl,
      modrinthFileSha512: (hit as { fileSha512?: string | null }).fileSha512 ?? merged.modrinthFileSha512,
  };
  ```

- [ ] **Run type-check and full tests**

  ```powershell
  npx tsc --noEmit
  npm test
  ```
  Expected: clean.

- [ ] **Commit**

  ```powershell
  git add src/tools/ingest.ts
  git commit -m "feat: persist Modrinth file SHA-512 in metadata for download verification"
  ```
