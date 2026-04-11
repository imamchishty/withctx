/**
 * Resilient fetch wrapper with retry, backoff, rate-limit handling, and timeout.
 * Drop-in replacement for native fetch() on API calls.
 */

/**
 * Default upper bound on the size of a single response body. 50 MB is
 * well above any legitimate Jira/Confluence/GitHub JSON payload but
 * comfortably below memory pressure. Callers that genuinely need more
 * (e.g. fetching a large tarball) can raise it per-call.
 */
export const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * Thrown when a response body exceeds `maxBodyBytes`. We surface it as
 * a distinct error class so callers can tell apart "server misbehaved"
 * (MaxBodyExceededError) from "network glitch" (generic Error).
 */
export class MaxBodyExceededError extends Error {
  readonly url: string;
  readonly limit: number;
  constructor(url: string, limit: number) {
    super(
      `Response body from ${url} exceeded ${limit} byte limit — refusing to read further to protect memory`,
    );
    this.name = "MaxBodyExceededError";
    this.url = url;
    this.limit = limit;
  }
}

export interface ResilientFetchOptions {
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  baseDelay?: number;
  /** Maximum delay cap in ms. Default: 30000 */
  maxDelay?: number;
  /** Header name to read for rate-limit reset (e.g. "retry-after", "x-ratelimit-reset"). */
  rateLimitHeader?: string;
  /** Request timeout in ms. Default: 30000 */
  timeout?: number;
  /** Optional callback fired before each retry. */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /**
   * Maximum body size in bytes. If the server advertises a larger
   * Content-Length we refuse the response without reading the body.
   * Default: 50 MB. Use {@link readBodyWithLimit} to enforce the same
   * cap when you actually read the body (handles chunked/streamed
   * responses that omit Content-Length).
   */
  maxBodyBytes?: number;
}

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch with automatic retries, exponential backoff + jitter, rate-limit
 * header support, and AbortController-based timeout.
 *
 * Does NOT retry on 401, 403, 404 or other non-retryable status codes.
 */
export async function resilientFetch(
  url: string | URL,
  init?: RequestInit,
  options?: ResilientFetchOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelay ?? 1000;
  const maxDelay = options?.maxDelay ?? 30_000;
  const timeout = options?.timeout ?? 30_000;
  const rateLimitHeader = options?.rateLimitHeader?.toLowerCase();
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // --- timeout via AbortController ---
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Merge caller's signal with our timeout signal
    const callerSignal = init?.signal;
    if (callerSignal?.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // If caller supplied their own signal, listen for it
    const onCallerAbort = callerSignal
      ? () => controller.abort()
      : undefined;
    if (callerSignal && onCallerAbort) {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (callerSignal && onCallerAbort) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }

      // Refuse oversized responses before the caller touches .text()/.json().
      // This is a fast-path check against the server-advertised Content-Length.
      // A malicious or misconfigured server can omit the header; callers that
      // read the body should additionally use readBodyWithLimit() to enforce
      // the same cap on streamed responses.
      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          // Drain and discard the body so the connection can be reused.
          try {
            await response.body?.cancel();
          } catch {
            /* ignore cancel errors */
          }
          throw new MaxBodyExceededError(String(url), maxBodyBytes);
        }
      }

      // Success — return immediately
      if (response.ok) {
        return response;
      }

      // Non-retryable error — throw immediately
      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }

      // Retryable error — compute delay
      if (attempt < maxRetries) {
        const delay = computeDelay(
          response,
          attempt,
          baseDelay,
          maxDelay,
          rateLimitHeader,
        );
        const err = new Error(
          `HTTP ${response.status} from ${String(url)}`,
        );

        if (options?.onRetry) {
          options.onRetry(attempt + 1, err, delay);
        } else {
          process.stderr.write(
            `[withctx] Retry ${attempt + 1}/${maxRetries} for ${String(url)} (HTTP ${response.status}, waiting ${delay}ms)\n`,
          );
        }

        await sleep(delay);
        lastError = err;
        continue;
      }

      // Out of retries
      throw new Error(
        `Request to ${String(url)} failed after ${maxRetries} retries with HTTP ${response.status}`,
      );
    } catch (error) {
      clearTimeout(timeoutId);
      if (callerSignal && onCallerAbort) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }

      // Oversized body is a deterministic safety guard — retrying would
      // just make the same bad server send the same oversized response.
      // Propagate immediately so the caller can surface it to the user.
      if (error instanceof MaxBodyExceededError) {
        throw error;
      }

      // Abort from timeout
      if (error instanceof DOMException && error.name === "AbortError") {
        const timeoutErr = new Error(
          `Request to ${String(url)} timed out after ${timeout}ms`,
        );

        if (attempt < maxRetries) {
          const delay = Math.min(baseDelay * 2 ** attempt + jitter(), maxDelay);

          if (options?.onRetry) {
            options.onRetry(attempt + 1, timeoutErr, delay);
          } else {
            process.stderr.write(
              `[withctx] Retry ${attempt + 1}/${maxRetries} for ${String(url)} (timeout, waiting ${delay}ms)\n`,
            );
          }

          await sleep(delay);
          lastError = timeoutErr;
          continue;
        }

        throw new Error(
          `Request to ${String(url)} timed out after ${maxRetries} retries (${timeout}ms timeout)`,
        );
      }

      // Network-level error (DNS, connection refused, etc.)
      const networkErr =
        error instanceof Error
          ? error
          : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * 2 ** attempt + jitter(), maxDelay);

        if (options?.onRetry) {
          options.onRetry(attempt + 1, networkErr, delay);
        } else {
          process.stderr.write(
            `[withctx] Retry ${attempt + 1}/${maxRetries} for ${String(url)} (${networkErr.message}, waiting ${delay}ms)\n`,
          );
        }

        await sleep(delay);
        lastError = networkErr;
        continue;
      }

      throw new Error(
        `Request to ${String(url)} failed after ${maxRetries} retries: ${networkErr.message}`,
      );
    }
  }

  // Should never reach here, but just in case
  throw lastError ?? new Error(`Request to ${String(url)} failed`);
}

// ─── Helpers ────────────────────────────────────────────────

function computeDelay(
  response: Response,
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  rateLimitHeader?: string,
): number {
  // Check Retry-After header (standard)
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const parsed = parseRetryAfter(retryAfter);
    if (parsed !== null) return Math.min(parsed, maxDelay);
  }

  // Check custom rate-limit header (e.g. x-ratelimit-reset)
  if (rateLimitHeader && rateLimitHeader !== "retry-after") {
    const resetValue = response.headers.get(rateLimitHeader);
    if (resetValue) {
      const parsed = parseRateLimitReset(resetValue);
      if (parsed !== null) return Math.min(parsed, maxDelay);
    }
  }

  // Exponential backoff with jitter
  return Math.min(baseDelay * 2 ** attempt + jitter(), maxDelay);
}

/**
 * Parse Retry-After header. Supports both:
 * - Seconds: "120"
 * - HTTP-date: "Thu, 01 Dec 2024 16:00:00 GMT"
 */
function parseRetryAfter(value: string): number | null {
  const seconds = Number(value);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }

  return null;
}

/**
 * Parse X-RateLimit-Reset header. Supports:
 * - Unix timestamp in seconds: "1701456000"
 * - Seconds until reset: "30"
 */
function parseRateLimitReset(value: string): number | null {
  const num = Number(value);
  if (isNaN(num) || num < 0) return null;

  // If the number looks like a Unix timestamp (> year 2000 in seconds)
  if (num > 946_684_800) {
    const ms = num * 1000 - Date.now();
    return ms > 0 ? ms : 0;
  }

  // Otherwise treat as seconds until reset
  return num * 1000;
}

function jitter(): number {
  return Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a Response body as text, enforcing a hard byte cap.
 *
 * The Content-Length pre-check in {@link resilientFetch} catches
 * servers that advertise oversized payloads, but a malicious or
 * misconfigured server can omit the header and then stream forever.
 * This helper reads the body chunk by chunk, aborts as soon as the
 * cumulative size exceeds `maxBytes`, and cancels the underlying
 * stream so the socket can be reused.
 *
 * Usage:
 *   const res = await resilientFetch(url, init, { maxBodyBytes });
 *   const text = await readBodyWithLimit(res, maxBodyBytes, url);
 *   const json = JSON.parse(text);
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
  urlForError?: string,
): Promise<string> {
  const label = urlForError ?? response.url ?? "<response>";

  // Fast path: re-check Content-Length in case the caller bypassed
  // resilientFetch or raised the cap between call and read.
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new MaxBodyExceededError(label, maxBytes);
    }
  }

  if (!response.body) {
    // Some runtimes (mocked Response) don't expose a stream. Fall
    // back to .text() but still enforce the cap afterwards.
    const text = await response.text();
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      throw new MaxBodyExceededError(label, maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new MaxBodyExceededError(label, maxBytes);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    // Flush any buffered multi-byte sequences.
    chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  return chunks.join("");
}
