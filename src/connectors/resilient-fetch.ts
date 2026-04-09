/**
 * Resilient fetch wrapper with retry, backoff, rate-limit handling, and timeout.
 * Drop-in replacement for native fetch() on API calls.
 */

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
