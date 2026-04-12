#!/usr/bin/env node
/**
 * On-prem smoke test — exercise the Jira, Confluence, and GitHub
 * connectors against REAL servers (on-prem or cloud) and report the
 * first failure in plain English.
 *
 * PREREQUISITE: run `npm run build` first so dist/ exists.
 *
 * Usage:
 *
 *   # Jira on-prem (PAT auth)
 *   JIRA_BASE_URL=https://jira.corp.com \
 *   JIRA_TOKEN=$PAT \
 *   JIRA_PROJECT=ABC \
 *     node scripts/smoke-onprem.mjs jira
 *
 *   # Confluence Cloud
 *   CONFLUENCE_BASE_URL=https://acme.atlassian.net \
 *   CONFLUENCE_EMAIL=alice@acme.com \
 *   CONFLUENCE_TOKEN=$TOKEN \
 *   CONFLUENCE_SPACE=ENG \
 *     node scripts/smoke-onprem.mjs confluence
 *
 *   # GitHub Enterprise Server
 *   GITHUB_BASE_URL=https://github.corp.com \
 *   GITHUB_TOKEN=$PAT \
 *   GITHUB_OWNER=my-org GITHUB_REPO=my-repo \
 *     node scripts/smoke-onprem.mjs github
 *
 *   # Everything at once (each connector still reads its own env vars)
 *     node scripts/smoke-onprem.mjs all
 *
 * For TLS / proxy:
 *
 *   NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem   # corporate CA bundle
 *   HTTPS_PROXY=http://proxy.corp.com:8080     # corporate proxy
 *
 * This script is deliberately NOT wired to vitest — it makes real
 * network calls and would flake CI. Run it by hand the first time you
 * point withctx at a new server.
 */

import { initNetwork, getNetworkDiagnostics } from "../dist/connectors/network-bootstrap.js";
import { JiraConnector } from "../dist/connectors/jira.js";
import { ConfluenceConnector } from "../dist/connectors/confluence.js";
import { GitHubConnector } from "../dist/connectors/github.js";

// ── ANSI minimal so we don't pull in chalk for a standalone script ──

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function req(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(C.red(`✗ ${name} is not set`));
    process.exit(2);
  }
  return v.trim();
}
function opt(name) {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function banner(title) {
  console.log();
  console.log(C.bold(C.cyan(`── ${title} `.padEnd(60, "─"))));
}

function explainError(err) {
  if (!(err instanceof Error)) return String(err);
  const chain = [err.message];
  let cursor = err;
  for (let i = 0; i < 4; i++) {
    if (cursor && typeof cursor === "object" && "cause" in cursor) {
      const next = cursor.cause;
      if (next instanceof Error) {
        chain.push(`  cause: ${next.message}`);
        cursor = next;
        continue;
      }
    }
    break;
  }
  return chain.join("\n");
}

// ── Jira ────────────────────────────────────────────────────────────

async function smokeJira() {
  banner("Jira");
  const baseUrl = req("JIRA_BASE_URL");
  const token = req("JIRA_TOKEN");
  const project = req("JIRA_PROJECT");
  const email = opt("JIRA_EMAIL");

  const mode = email ? "Cloud (Basic auth)" : "Server/DC (Bearer PAT)";
  console.log(`  base_url: ${baseUrl}`);
  console.log(`  project:  ${project}`);
  console.log(`  mode:     ${mode}`);
  console.log();

  const source = {
    name: "smoke-jira",
    base_url: baseUrl,
    token,
    project,
    ...(email ? { email } : {}),
  };

  const c = new JiraConnector(source);

  try {
    const ok = await c.validate();
    if (!ok) {
      const st = c.getStatus();
      console.log(C.red("  ✗ validate() returned false"));
      if (st.error) console.log(C.dim(`    ${st.error}`));
      return false;
    }
    console.log(C.green("  ✓ validate() — credentials accepted"));
  } catch (err) {
    console.log(C.red("  ✗ validate() threw:"));
    console.log(explainError(err).split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }

  try {
    let count = 0;
    const start = Date.now();
    for await (const doc of c.fetch({ limit: 3 })) {
      count++;
      console.log(C.dim(`    [${count}] ${doc.title}`));
      if (count >= 3) break;
    }
    const ms = Date.now() - start;
    console.log(C.green(`  ✓ fetch() — pulled ${count} issue(s) in ${ms}ms`));
    return count > 0;
  } catch (err) {
    console.log(C.red("  ✗ fetch() threw:"));
    console.log(explainError(err).split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }
}

// ── Confluence ──────────────────────────────────────────────────────

async function smokeConfluence() {
  banner("Confluence");
  const baseUrl = req("CONFLUENCE_BASE_URL");
  const token = req("CONFLUENCE_TOKEN");
  const space = req("CONFLUENCE_SPACE");
  const email = opt("CONFLUENCE_EMAIL");

  const mode = email ? "Cloud (Basic auth)" : "Server/DC (Bearer PAT)";
  console.log(`  base_url: ${baseUrl}`);
  console.log(`  space:    ${space}`);
  console.log(`  mode:     ${mode}`);
  console.log();

  const source = {
    name: "smoke-confluence",
    base_url: baseUrl,
    token,
    space,
    ...(email ? { email } : {}),
  };

  const c = new ConfluenceConnector(source);

  const effective = c.baseUrl;
  if (effective && effective !== baseUrl) {
    console.log(C.dim(`  note: connector normalised base_url → ${effective}`));
  }

  try {
    const ok = await c.validate();
    if (!ok) {
      const st = c.getStatus();
      console.log(C.red("  ✗ validate() returned false"));
      if (st.error) console.log(C.dim(`    ${st.error}`));
      return false;
    }
    console.log(C.green("  ✓ validate() — credentials accepted"));
  } catch (err) {
    console.log(C.red("  ✗ validate() threw:"));
    console.log(explainError(err).split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }

  try {
    let count = 0;
    const start = Date.now();
    for await (const doc of c.fetch({ limit: 3 })) {
      count++;
      console.log(C.dim(`    [${count}] ${doc.title}`));
      if (count >= 3) break;
    }
    const ms = Date.now() - start;
    console.log(C.green(`  ✓ fetch() — pulled ${count} page(s) in ${ms}ms`));
    return count > 0;
  } catch (err) {
    console.log(C.red("  ✗ fetch() threw:"));
    console.log(explainError(err).split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }
}

// ── GitHub ──────────────────────────────────────────────────────────

async function smokeGitHub() {
  banner("GitHub");
  const token = opt("GITHUB_TOKEN") ?? opt("GH_TOKEN");
  const owner = req("GITHUB_OWNER");
  const repo = opt("GITHUB_REPO");
  const baseUrl = opt("GITHUB_BASE_URL");

  const deployment =
    baseUrl && baseUrl.includes("github.com") === false
      ? "GitHub Enterprise Server"
      : "github.com";

  console.log(`  deployment: ${deployment}`);
  console.log(`  owner:      ${owner}`);
  if (repo) console.log(`  repo:       ${repo}`);
  if (baseUrl) console.log(`  base_url:   ${baseUrl}`);
  console.log();

  if (!token) {
    console.log(C.red("  ✗ no token — set GITHUB_TOKEN or GH_TOKEN"));
    return false;
  }

  const source = {
    name: "smoke-github",
    owner,
    token,
    ...(repo ? { repo } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
  };

  let c;
  try {
    c = new GitHubConnector(source);
  } catch (err) {
    console.log(C.red("  ✗ constructor threw:"));
    console.log(explainError(err).split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }

  if (c.effectiveBaseUrl && baseUrl && c.effectiveBaseUrl !== baseUrl) {
    console.log(C.dim(`  note: connector normalised base_url → ${c.effectiveBaseUrl}`));
  }

  try {
    const ok = await c.validate();
    if (!ok) {
      console.log(C.red("  ✗ validate() returned false"));
      return false;
    }
    console.log(C.green("  ✓ validate() — token accepted"));
  } catch (err) {
    console.log(C.red("  ✗ validate() threw:"));
    console.log(explainError(err).split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }

  try {
    let count = 0;
    const start = Date.now();
    for await (const doc of c.fetch({ limit: 3 })) {
      count++;
      console.log(C.dim(`    [${count}] ${doc.title}`));
      if (count >= 3) break;
    }
    const ms = Date.now() - start;
    console.log(C.green(`  ✓ fetch() — pulled ${count} doc(s) in ${ms}ms`));
    return count > 0;
  } catch (err) {
    console.log(C.red("  ✗ fetch() threw:"));
    console.log(explainError(err).split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }
}

// ── Entry point ─────────────────────────────────────────────────────

async function main() {
  console.log(C.bold("withctx on-prem smoke test"));
  console.log(C.dim("Exercises real connectors against real servers. No mocks."));
  console.log();

  await initNetwork();
  const diag = getNetworkDiagnostics();
  if (diag) {
    console.log(C.bold("Network"));
    console.log(`  TLS CA bundle:   ${diag.caBundle ?? C.dim("<node default>")}`);
    if (diag.caBundleError) console.log(C.red(`    ✗ ${diag.caBundleError}`));
    console.log(`  HTTPS_PROXY:     ${diag.httpsProxy ?? C.dim("<none>")}`);
    console.log(`  Proxy installed: ${diag.proxyAgentInstalled ? "yes" : "no"}`);
    if (diag.tlsVerificationDisabled) {
      console.log(C.red("  ⚠ NODE_TLS_REJECT_UNAUTHORIZED=0 — TLS verification DISABLED"));
    }
  }

  const target = (process.argv[2] ?? "all").toLowerCase();

  const results = [];

  if (target === "jira" || target === "all") {
    try {
      results.push({ name: "Jira", ok: await smokeJira() });
    } catch (err) {
      console.log(C.red(`  Jira smoke crashed: ${explainError(err)}`));
      results.push({ name: "Jira", ok: false });
    }
  }
  if (target === "confluence" || target === "all") {
    try {
      results.push({ name: "Confluence", ok: await smokeConfluence() });
    } catch (err) {
      console.log(C.red(`  Confluence smoke crashed: ${explainError(err)}`));
      results.push({ name: "Confluence", ok: false });
    }
  }
  if (target === "github" || target === "all") {
    try {
      results.push({ name: "GitHub", ok: await smokeGitHub() });
    } catch (err) {
      console.log(C.red(`  GitHub smoke crashed: ${explainError(err)}`));
      results.push({ name: "GitHub", ok: false });
    }
  }

  console.log();
  console.log(C.bold("Summary"));
  for (const r of results) {
    const badge = r.ok ? C.green("PASS") : C.red("FAIL");
    console.log(`  ${badge}  ${r.name}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(C.red("smoke-onprem crashed:"));
  console.error(explainError(err));
  process.exit(1);
});
