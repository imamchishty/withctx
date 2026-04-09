/**
 * Wrapper for async generators that isolates per-item errors.
 * Prevents a single bad document from crashing the entire ingest pipeline.
 */

export interface SafeGenerateOptions {
  /** Human-readable name of the source (for error messages). */
  sourceName: string;
  /** Optional callback invoked on each error. */
  onError?: (error: Error, index: number) => void;
  /** Stop iterating after this many errors. Default: 10 */
  maxErrors?: number;
}

/**
 * Wraps an async generator so that individual yield errors are caught,
 * logged, and skipped instead of killing the whole pipeline.
 *
 * After `maxErrors` consecutive or total errors the generator stops
 * early to avoid infinite error loops.
 */
export async function* safeGenerate<T>(
  generator: AsyncGenerator<T>,
  options: SafeGenerateOptions,
): AsyncGenerator<T> {
  const maxErrors = options.maxErrors ?? 10;
  let errorCount = 0;
  let index = 0;

  while (true) {
    let result: IteratorResult<T>;

    try {
      result = await generator.next();
    } catch (error) {
      errorCount++;
      const err =
        error instanceof Error ? error : new Error(String(error));

      if (options.onError) {
        options.onError(err, index);
      } else {
        process.stderr.write(
          `[withctx] Error in ${options.sourceName} at document ${index}: ${err.message}\n`,
        );
      }

      if (errorCount >= maxErrors) {
        process.stderr.write(
          `[withctx] Stopping ${options.sourceName} after ${maxErrors} errors\n`,
        );
        return;
      }

      index++;
      continue;
    }

    if (result.done) {
      return;
    }

    yield result.value;
    index++;
  }
}
