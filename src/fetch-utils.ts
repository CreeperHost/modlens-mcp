/**
 * Resilient fetch with automatic retry, exponential backoff, and timeout.
 * - Retries transient failures (5xx, network errors) up to `retries` times.
 * - Never retries 4xx responses (caller decides how to handle them).
 * - Aborts the request if `timeoutMs` elapses without a response.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export interface FetchRetryOptions {
    /** Max retry attempts after the first try (default: 3). */
    retries?: number;
    /** Abort timeout per attempt in ms (default: 10 000). */
    timeoutMs?: number;
    /** Base backoff in ms; doubles each retry (default: 500). */
    backoffMs?: number;
}

/** Suitable for large JAR downloads where the transfer itself takes time. */
export const DOWNLOAD_OPTS: FetchRetryOptions = { timeoutMs: 120_000, retries: 2 };

export async function fetchWithRetry(
    url: string,
    init?: RequestInit,
    opts?: FetchRetryOptions,
): Promise<Response> {
    const retries  = opts?.retries  ?? MAX_RETRIES;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const backoffMs = opts?.backoffMs ?? BASE_BACKOFF_MS;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            await new Promise<void>((resolve) =>
                setTimeout(resolve, backoffMs * 2 ** (attempt - 1))
            );
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            clearTimeout(timer);

            // 4xx = client error — caller handles, no retry
            if (res.status >= 400 && res.status < 500) return res;

            // 5xx = transient server error — retry if we have attempts left
            if (!res.ok && attempt < retries) {
                lastError = new Error(`HTTP ${res.status} from ${url}`);
                continue;
            }

            return res;
        } catch (err) {
            clearTimeout(timer);
            lastError = err;
            if (attempt >= retries) break;
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`fetch failed: ${String(lastError)}`);
}
