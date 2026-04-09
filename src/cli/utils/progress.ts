/**
 * Progress display utilities for CLI commands.
 * No external dependencies — uses chalk for colors only.
 */

/**
 * Render a text-based progress bar.
 * @param current - Current progress value
 * @param total - Total value (must be > 0)
 * @param width - Character width of the bar (default 20)
 */
export function progressBar(current: number, total: number, width: number = 20): string {
  if (total <= 0) return "░".repeat(width) + "   0%";
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = Math.round(ratio * 100);
  return `${bar}  ${pct}%`;
}

/**
 * Format a byte count as a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * Format a duration in milliseconds as a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

/**
 * Format a USD cost with a ~ prefix and $ sign.
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `~$${usd.toFixed(4)}`;
  return `~$${usd.toFixed(2)}`;
}

/**
 * Format a token count with locale separators and ~ prefix.
 */
export function formatTokens(count: number): string {
  return `~${count.toLocaleString()}`;
}
