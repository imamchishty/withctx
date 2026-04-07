import type { RawDocument, FetchOptions, SourceStatus, SourceType } from "../types/source.js";

/**
 * Interface that all source connectors must implement.
 * Each connector handles one source type (local files, PDF, Jira, etc.)
 */
export interface SourceConnector {
  /** The source type identifier */
  readonly type: SourceType;

  /** Human-readable name for this connector instance */
  readonly name: string;

  /**
   * Validate that the connector can reach its source.
   * Returns true if credentials/paths are valid.
   */
  validate(): Promise<boolean>;

  /**
   * Fetch documents from the source.
   * Yields RawDocument objects as they are retrieved.
   * Supports incremental fetching via options.since.
   */
  fetch(options?: FetchOptions): AsyncGenerator<RawDocument>;

  /**
   * Get the current status of this connector.
   */
  getStatus(): SourceStatus;
}
