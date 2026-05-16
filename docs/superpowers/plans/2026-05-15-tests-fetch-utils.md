# Tests: fetchWithRetry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `src/fetch-utils.ts` exports `fetchWithRetry` — the retry/backoff/timeout wrapper used for all external HTTP calls (Modrinth, CurseForge, Mojang). It is completely untested. With `vi.stubGlobal("fetch", ...)` we can simulate 5xx responses, network failures, timeouts, and 4xx pass-throughs without any real network access.

**Tech:** Vitest, `vi.stubGlobal`, `vi.fn`, `vi.useFakeTimers` (to avoid real backoff delays)

---

## File Map

- **Create:** `src/fetch-utils.test.ts`
- **Read (do not modify):** `src/fetch-utils.ts`

---

## Task 1: 4xx pass-through and happy path

`fetchWithRetry` must not retry 4xx responses — it returns them immediately.

- [ ] **Create `src/fetch-utils.test.ts`**

  ```typescript
  import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
  import { fetchWithRetry, DOWNLOAD_OPTS } from "./fetch-utils.js";

  function mockFetch(...responses: Array<{ status: number; ok: boolean; body?: string }>) {
      let call = 0;
      return vi.fn().mockImplementation(() => {
          const r = responses[Math.min(call++, responses.length - 1)];
          return Promise.resolve({
              ok: r.ok,
              status: r.status,
              text: async () => r.body ?? "",
          });
      });
  }

  beforeEach(() => {
      vi.useFakeTimers();
  });

  afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
  });

  describe("fetchWithRetry — happy path", () => {
      it("returns a 200 response immediately", async () => {
          vi.stubGlobal("fetch", mockFetch({ status: 200, ok: true }));
          const res = await fetchWithRetry("https://example.com/api");
          expect(res.status).toBe(200);
          expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      });
  });

  describe("fetchWithRetry — 4xx pass-through (no retry)", () => {
      it("returns 404 without retrying", async () => {
          const fakeFetch = mockFetch({ status: 404, ok: false });
          vi.stubGlobal("fetch", fakeFetch);
          const res = await fetchWithRetry("https://example.com/api");
          expect(res.status).toBe(404);
          expect(fakeFetch.mock.calls).toHaveLength(1);
      });

      it("returns 401 without retrying", async () => {
          const fakeFetch = mockFetch({ status: 401, ok: false });
          vi.stubGlobal("fetch", fakeFetch);
          const res = await fetchWithRetry("https://example.com/api");
          expect(res.status).toBe(401);
          expect(fakeFetch.mock.calls).toHaveLength(1);
      });
  });
  ```

- [ ] **Run — expect PASS**

  ```powershell
  npx vitest run src/fetch-utils.test.ts
  ```
  Expected: 3 tests pass.

- [ ] **Commit**

  ```powershell
  git add src/fetch-utils.test.ts
  git commit -m "test: fetchWithRetry happy path and 4xx pass-through"
  ```

---

## Task 2: 5xx retry behaviour

`fetchWithRetry` should retry up to `MAX_RETRIES` (3) times on 5xx, with exponential backoff. We use `vi.useFakeTimers()` + `vi.runAllTimersAsync()` to skip real delays.

- [ ] **Append to `src/fetch-utils.test.ts`**

  ```typescript
  describe("fetchWithRetry — 5xx retry", () => {
      it("retries up to MAX_RETRIES times on 5xx then returns last response", async () => {
          // 4 calls: 3 failures + 1 eventual success
          const fakeFetch = mockFetch(
              { status: 503, ok: false },
              { status: 503, ok: false },
              { status: 503, ok: false },
              { status: 200, ok: true },
          );
          vi.stubGlobal("fetch", fakeFetch);

          const promise = fetchWithRetry("https://example.com/api", undefined, { retries: 3, backoffMs: 100 });
          // Advance timers to skip all backoff waits
          await vi.runAllTimersAsync();
          const res = await promise;

          expect(res.status).toBe(200);
          expect(fakeFetch.mock.calls).toHaveLength(4);
      });

      it("throws after all retries exhausted on 5xx", async () => {
          // Always 503 — all 4 attempts fail
          const fakeFetch = mockFetch(
              { status: 503, ok: false },
              { status: 503, ok: false },
              { status: 503, ok: false },
              { status: 503, ok: false },
          );
          vi.stubGlobal("fetch", fakeFetch);

          const promise = fetchWithRetry("https://example.com/api", undefined, { retries: 3, backoffMs: 100 });
          await vi.runAllTimersAsync();

          await expect(promise).rejects.toThrow("503");
      });

      it("succeeds on second attempt after one 5xx", async () => {
          const fakeFetch = mockFetch(
              { status: 500, ok: false },
              { status: 200, ok: true },
          );
          vi.stubGlobal("fetch", fakeFetch);

          const promise = fetchWithRetry("https://example.com/api", undefined, { retries: 2, backoffMs: 10 });
          await vi.runAllTimersAsync();
          const res = await promise;

          expect(res.status).toBe(200);
          expect(fakeFetch.mock.calls).toHaveLength(2);
      });
  });
  ```

- [ ] **Run — expect PASS**

  ```powershell
  npx vitest run src/fetch-utils.test.ts
  ```
  Expected: 6 tests pass.

- [ ] **Commit**

  ```powershell
  git add src/fetch-utils.test.ts
  git commit -m "test: fetchWithRetry 5xx retry and exhaustion"
  ```

---

## Task 3: Network error retry and timeout

- [ ] **Append to `src/fetch-utils.test.ts`**

  ```typescript
  describe("fetchWithRetry — network errors", () => {
      it("retries on network error (fetch rejects)", async () => {
          let call = 0;
          const fakeFetch = vi.fn().mockImplementation(() => {
              if (++call < 3) return Promise.reject(new Error("ECONNREFUSED"));
              return Promise.resolve({ ok: true, status: 200, text: async () => "" });
          });
          vi.stubGlobal("fetch", fakeFetch);

          const promise = fetchWithRetry("https://example.com/api", undefined, { retries: 3, backoffMs: 10 });
          await vi.runAllTimersAsync();
          const res = await promise;

          expect(res.status).toBe(200);
          expect(fakeFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
      });

      it("throws the last network error after all retries exhausted", async () => {
          const fakeFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
          vi.stubGlobal("fetch", fakeFetch);

          const promise = fetchWithRetry("https://example.com/api", undefined, { retries: 2, backoffMs: 10 });
          await vi.runAllTimersAsync();

          await expect(promise).rejects.toThrow("ECONNREFUSED");
      });
  });

  describe("fetchWithRetry — options", () => {
      it("respects custom retries=0 — no retry on 5xx", async () => {
          const fakeFetch = mockFetch(
              { status: 500, ok: false },
              { status: 200, ok: true },
          );
          vi.stubGlobal("fetch", fakeFetch);

          const promise = fetchWithRetry("https://example.com/api", undefined, { retries: 0 });
          await vi.runAllTimersAsync();
          // With retries=0, should throw after the single 5xx (not retry to get 200)
          await expect(promise).rejects.toThrow("500");
          expect(fakeFetch.mock.calls).toHaveLength(1);
      });

      it("DOWNLOAD_OPTS has increased timeout and fewer retries", () => {
          expect(DOWNLOAD_OPTS.timeoutMs).toBeGreaterThan(10_000);
          expect(DOWNLOAD_OPTS.retries).toBeLessThan(4);
      });
  });
  ```

- [ ] **Run — expect PASS**

  ```powershell
  npx vitest run src/fetch-utils.test.ts
  ```
  Expected: 10 tests pass.

- [ ] **Run full test suite**

  ```powershell
  npm test
  ```
  Expected: all 98 tests pass.

- [ ] **Commit**

  ```powershell
  git add src/fetch-utils.test.ts
  git commit -m "test: fetchWithRetry network errors, timeout, options coverage"
  ```
