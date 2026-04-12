/**
 * Single source of truth for turning a `ctx.yaml` into a live
 * {@link ConnectorRegistry}. Both `ctx ingest` and `ctx sync` call
 * this — historically each command built its own registry and only
 * wired up `LocalFilesConnector`, which meant Jira/Confluence/GitHub/
 * Teams/SharePoint sources silently did nothing even though the
 * connector classes existed. Centralising here means every new
 * connector type is picked up by every pipeline automatically.
 *
 * Design rules:
 *
 *   1. A misconfigured single source must never take down the whole
 *      registry — we warn to stderr and keep going. `ctx doctor` is
 *      the canonical place to surface config issues.
 *
 *   2. Path-based sources go through `safeResolve` so an
 *      attacker-controlled ctx.yaml can't sneak out of the project
 *      root via `../../etc/passwd` or `/etc/hosts`.
 *
 *   3. Connectors that need network access rely on
 *      `initNetwork()` having already run — the CLI bootstrap calls
 *      it before `program.parse(process.argv)`, so by the time this
 *      function is called, HTTPS_PROXY and NODE_EXTRA_CA_CERTS are
 *      already wired into undici's global dispatcher.
 *
 *   4. A connector whose constructor throws (e.g. GitHub with no
 *      token resolvable from env or config) is reported and skipped
 *      — same "keep going" policy as rule 1.
 *
 *   5. The `--source <name>` filter in `ctx sync` is honoured: if
 *      the caller passes `sourceFilter`, only that source is
 *      registered, everything else is dropped silently.
 */

import chalk from "chalk";
import type { CtxConfig } from "../types/config.js";
import { ConnectorRegistry } from "./registry.js";
import { LocalFilesConnector } from "./local-files.js";
import { JiraConnector } from "./jira.js";
import { ConfluenceConnector } from "./confluence.js";
import { GitHubConnector } from "./github.js";
import { TeamsConnector } from "./teams.js";
import { SharePointConnector } from "./sharepoint.js";
import { safeResolve } from "../security/paths.js";
import { CtxDirectory } from "../storage/ctx-dir.js";

export interface BuildConnectorsOptions {
  /**
   * If set, only a source whose `name` matches this will be
   * registered. Everything else is silently dropped. Used by
   * `ctx sync --source <name>`.
   */
  sourceFilter?: string;
  /**
   * Cache directory for connectors that need to persist fetched
   * binary blobs to disk (currently: SharePoint, which downloads
   * files via Microsoft Graph). Falls back to `.ctx/sources` under
   * the project root if not supplied.
   */
  cacheDir?: string;
}

/**
 * Build a populated {@link ConnectorRegistry} from a loaded ctx.yaml.
 *
 * Safe to call repeatedly — each call produces a fresh registry, no
 * global state is mutated. Per-source errors are warned on stderr
 * and do not throw.
 */
export function buildConnectors(
  config: CtxConfig,
  projectRoot: string,
  options: BuildConnectorsOptions = {},
): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  const sources = config.sources;
  if (!sources) return registry;

  const filter = options.sourceFilter;
  const cacheDir =
    options.cacheDir ?? new CtxDirectory(projectRoot).sourcesPath;

  // ── local files ──────────────────────────────────────────────────
  //
  // Path is resolved through `safeResolve` so ctx.yaml cannot target
  // files outside the project root. A failed resolution drops that
  // entry and warns.
  if (sources.local) {
    for (const source of sources.local) {
      if (filter && source.name !== filter) continue;
      const resolvedPath = safeResolve(source.path, projectRoot);
      if (resolvedPath === null) {
        warn(
          `skipping source "${source.name}" — path "${source.path}" escapes project root`,
        );
        continue;
      }
      tryRegister(registry, () => new LocalFilesConnector(source.name, resolvedPath));
    }
  }

  // ── Jira ─────────────────────────────────────────────────────────
  //
  // Constructor is purely field assignment — it doesn't touch the
  // network. Both Cloud (Basic) and Server/DC (Bearer PAT) modes are
  // supported; the connector auto-picks based on whether `email` is
  // set.
  if (sources.jira) {
    for (const source of sources.jira) {
      if (filter && source.name !== filter) continue;
      tryRegister(registry, () => new JiraConnector(source));
    }
  }

  // ── Confluence ──────────────────────────────────────────────────
  if (sources.confluence) {
    for (const source of sources.confluence) {
      if (filter && source.name !== filter) continue;
      tryRegister(registry, () => new ConfluenceConnector(source));
    }
  }

  // ── GitHub ──────────────────────────────────────────────────────
  //
  // GitHubConnector's constructor DOES throw when it can't resolve a
  // token from any of (config.token, GITHUB_TOKEN, GH_TOKEN). That's
  // the loudest possible signal for a misconfigured release, so we
  // catch + report + move on rather than hard-failing the whole
  // pipeline.
  if (sources.github) {
    for (const source of sources.github) {
      if (filter && source.name !== filter) continue;
      tryRegister(registry, () => new GitHubConnector(source));
    }
  }

  // ── Teams ───────────────────────────────────────────────────────
  if (sources.teams) {
    for (const source of sources.teams) {
      if (filter && source.name !== filter) continue;
      tryRegister(registry, () => new TeamsConnector(source));
    }
  }

  // ── SharePoint ──────────────────────────────────────────────────
  //
  // Each SharePoint site is a separate connector registration — that
  // way the progress UI can show per-site counts and the
  // `--source <name>` filter in `ctx sync` can target an individual
  // site. The `sources.sharepoint` array is an explicit list so a
  // single ctx.yaml can pull from many sites in one run.
  if (sources.sharepoint) {
    for (const source of sources.sharepoint) {
      if (filter && source.name !== filter) continue;
      tryRegister(
        registry,
        () =>
          new SharePointConnector(
            source.name,
            {
              site: source.site,
              paths: source.paths,
              files: source.files,
              filetypes: source.filetypes,
            },
            cacheDir,
          ),
      );
    }
  }

  return registry;
}

// ── Internal helpers ───────────────────────────────────────────────

function tryRegister(
  registry: ConnectorRegistry,
  factory: () => { name: string; type: string },
): void {
  try {
    const connector = factory() as Parameters<ConnectorRegistry["register"]>[0];
    registry.register(connector);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`failed to register connector: ${msg}`);
  }
}

function warn(message: string): void {
  process.stderr.write(chalk.yellow(`  ⚠ ${message}\n`));
}
