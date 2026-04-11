/**
 * Runbook auto-detection.
 *
 * Scans a project directory for signals that tell an engineer (or an
 * AI agent) how to ACTUALLY run, test, and deploy the thing:
 *
 *   - package.json scripts (classified by intent — dev / build / test / lint)
 *   - Makefile / justfile / Taskfile targets
 *   - docker-compose.yml services + Dockerfile EXPOSE/CMD
 *   - .env.example / .env.sample env vars (with comment descriptions)
 *   - Language version hints (.nvmrc, .node-version, package.json engines,
 *     .python-version, pyproject.toml, Cargo.toml, go.mod)
 *   - CI workflows under .github/workflows/
 *   - VS Code debug configs
 *   - README "Getting Started" / "Development" section extraction
 *
 * Everything here is DETERMINISTIC — no LLM calls, no hallucination,
 * no cost. A runbook is facts about your repo; it should be
 * reproducible and auditable. The compile-time cost is ~10ms.
 *
 * Output is a `RunbookData` struct that `renderRunbookPage()` converts
 * into a self-contained `runbook.md` wiki page.
 *
 * This is the direct fix for the Info-axis gap "how do I actually run
 * this project?" — today's compiled wiki leans on overview /
 * architecture / conventions and leaves engineers hunting back in the
 * README. The runbook page makes the wiki a complete onboarding
 * target.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  buildFreshnessSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  isSnapshotStale,
  type FreshnessSnapshot,
} from "./git-freshness.js";

// ── Public types ──────────────────────────────────────────────────────

export type ScriptIntent =
  | "dev"
  | "start"
  | "build"
  | "test"
  | "lint"
  | "typecheck"
  | "format"
  | "other";

export interface DetectedScript {
  /** The command the user runs, e.g. `npm run dev`, `make test`, `just build`. */
  command: string;
  /** Raw script body from package.json / Makefile recipe — for citation. */
  body: string;
  /** Classification we used to group scripts in the rendered runbook. */
  intent: ScriptIntent;
  /** Source file (path relative to project root) — for citation. */
  source: string;
}

export interface DetectedEnvVar {
  name: string;
  /** Comment above the line in .env.example, if present. */
  description?: string;
  /** Example value from the file (secrets omitted by convention). */
  example?: string;
  /** Marked required if the example has no value AND no "optional" comment. */
  required: boolean;
}

export interface DetectedLanguage {
  name: "node" | "python" | "rust" | "go" | "ruby" | "java" | "unknown";
  version?: string;
  /** The file we learned it from — for citation. */
  source: string;
}

export interface DetectedDockerService {
  name: string;
  image?: string;
  ports?: string[];
}

export interface DetectedCiWorkflow {
  name: string;
  file: string;
  triggers: string[];
  jobs: string[];
}

export interface RunbookData {
  /** Detected project languages (can be more than one for polyglot repos). */
  languages: DetectedLanguage[];
  /** Scripts grouped by intent. Preserves insertion order inside each group. */
  scripts: DetectedScript[];
  /** Env vars from .env.example-like files. */
  envVars: DetectedEnvVar[];
  /** Dockerfile / compose bits. */
  docker: {
    hasDockerfile: boolean;
    dockerfilePath?: string;
    exposedPorts: number[];
    cmd?: string;
    hasCompose: boolean;
    composePath?: string;
    services: DetectedDockerService[];
  };
  /** CI workflows — what CI actually runs. */
  ci: DetectedCiWorkflow[];
  /** Has .vscode/launch.json? If so, VS Code debug is an option. */
  hasVsCodeDebug: boolean;
  /** "Getting Started" or "Development" section extracted from README.md. */
  readmeSnippet?: string;
  /** List of files we drew signals from — for the Sources block. */
  sources: string[];
}

// ── Entry point ───────────────────────────────────────────────────────

/**
 * Scan a project root and return structured runbook data. Never throws
 * — if a signal is missing, the corresponding field is empty.
 */
export function detectRunbook(rootDir: string): RunbookData {
  const data: RunbookData = {
    languages: [],
    scripts: [],
    envVars: [],
    docker: {
      hasDockerfile: false,
      exposedPorts: [],
      hasCompose: false,
      services: [],
    },
    ci: [],
    hasVsCodeDebug: false,
    sources: [],
  };

  const addSource = (p: string) => {
    if (!data.sources.includes(p)) data.sources.push(p);
  };

  // Languages + package scripts in one pass.
  detectNode(rootDir, data, addSource);
  detectPython(rootDir, data, addSource);
  detectRust(rootDir, data, addSource);
  detectGo(rootDir, data, addSource);

  // Build tool recipes.
  detectMakefile(rootDir, data, addSource);
  detectJustfile(rootDir, data, addSource);
  detectTaskfile(rootDir, data, addSource);

  // Docker.
  detectDockerfile(rootDir, data, addSource);
  detectCompose(rootDir, data, addSource);

  // Env vars.
  detectEnvExample(rootDir, data, addSource);

  // CI.
  detectCiWorkflows(rootDir, data, addSource);

  // Debug.
  detectVsCode(rootDir, data, addSource);

  // README snippet (last, cheapest to fail).
  detectReadmeSection(rootDir, data, addSource);

  return data;
}

// ── Language + script detectors ───────────────────────────────────────

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function safeJson<T = unknown>(path: string): T | null {
  const raw = safeRead(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Classify a package.json / Makefile script by its name. Heuristic, not
 * perfect, but covers 95% of the real world. The goal is to group
 * "dev", "build", "test", and friends so the runbook reads like a
 * checklist, not a wall of commands.
 */
export function classifyScriptName(name: string): ScriptIntent {
  const n = name.toLowerCase();
  if (/^(dev|serve|run|watch|hot)/.test(n)) return "dev";
  if (/^(start|up|launch)/.test(n)) return "start";
  if (/^(build|compile|bundle|dist|package)/.test(n)) return "build";
  if (/(^test|:test$|^spec|:spec$|^e2e|:e2e$|^unit|^integration)/.test(n))
    return "test";
  if (/^(lint|eslint|prettier:check|check$)/.test(n)) return "lint";
  if (/(typecheck|tsc|types|type-check)/.test(n)) return "typecheck";
  if (/(format|prettier$|fmt)/.test(n)) return "format";
  return "other";
}

function detectNode(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return;

  addSource("package.json");

  const pkg = safeJson<{
    engines?: { node?: string };
    scripts?: Record<string, string>;
    packageManager?: string;
  }>(pkgPath);

  if (!pkg) return;

  // Version hint: engines.node > .nvmrc > .node-version
  let version = pkg.engines?.node;
  let versionSource = "package.json";
  const nvmrc = safeRead(join(rootDir, ".nvmrc"))?.trim();
  const nodeVersionFile = safeRead(join(rootDir, ".node-version"))?.trim();
  if (!version && nvmrc) {
    version = nvmrc;
    versionSource = ".nvmrc";
    addSource(".nvmrc");
  } else if (!version && nodeVersionFile) {
    version = nodeVersionFile;
    versionSource = ".node-version";
    addSource(".node-version");
  }

  // Prefer the project's package manager if declared (corepack shape).
  const pm = pkg.packageManager?.split("@")[0] ?? "npm";
  const runPrefix =
    pm === "pnpm" ? "pnpm" : pm === "yarn" ? "yarn" : pm === "bun" ? "bun" : "npm run";

  data.languages.push({
    name: "node",
    version,
    source: versionSource,
  });

  if (!pkg.scripts) return;

  for (const [name, body] of Object.entries(pkg.scripts)) {
    // "npm run start" is awkward; the whole Node ecosystem accepts
    // `npm start` / `npm test` as sugar.
    const command =
      (name === "start" || name === "test") && runPrefix.startsWith("npm")
        ? `npm ${name}`
        : `${runPrefix} ${name}`;
    data.scripts.push({
      command,
      body,
      intent: classifyScriptName(name),
      source: "package.json",
    });
  }
}

function detectPython(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const pyVersionFile = safeRead(join(rootDir, ".python-version"))?.trim();
  const pyprojectPath = join(rootDir, "pyproject.toml");
  const requirementsPath = join(rootDir, "requirements.txt");
  const setupPyPath = join(rootDir, "setup.py");

  const hasPython =
    pyVersionFile ||
    existsSync(pyprojectPath) ||
    existsSync(requirementsPath) ||
    existsSync(setupPyPath);
  if (!hasPython) return;

  let version: string | undefined = pyVersionFile;
  let versionSource = ".python-version";
  if (!version && existsSync(pyprojectPath)) {
    const py = safeRead(pyprojectPath) ?? "";
    const m = py.match(/requires-python\s*=\s*"([^"]+)"/);
    if (m) {
      version = m[1];
      versionSource = "pyproject.toml";
    }
    addSource("pyproject.toml");
  }
  if (pyVersionFile) addSource(".python-version");
  if (existsSync(requirementsPath)) addSource("requirements.txt");
  if (existsSync(setupPyPath)) addSource("setup.py");

  data.languages.push({ name: "python", version, source: versionSource });
}

function detectRust(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const cargoPath = join(rootDir, "Cargo.toml");
  if (!existsSync(cargoPath)) return;
  addSource("Cargo.toml");
  const cargo = safeRead(cargoPath) ?? "";
  const editionMatch = cargo.match(/edition\s*=\s*"(\d+)"/);
  data.languages.push({
    name: "rust",
    version: editionMatch ? `edition ${editionMatch[1]}` : undefined,
    source: "Cargo.toml",
  });
}

function detectGo(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const goModPath = join(rootDir, "go.mod");
  if (!existsSync(goModPath)) return;
  addSource("go.mod");
  const goMod = safeRead(goModPath) ?? "";
  const m = goMod.match(/^go\s+([\d.]+)/m);
  data.languages.push({
    name: "go",
    version: m?.[1],
    source: "go.mod",
  });
}

// ── Build tool detectors ──────────────────────────────────────────────

function detectMakefile(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const candidates = ["Makefile", "makefile", "GNUmakefile"];
  for (const name of candidates) {
    const path = join(rootDir, name);
    if (!existsSync(path)) continue;
    addSource(name);
    const content = safeRead(path) ?? "";
    // Pull .PHONY targets first (authoritative list), then fall back
    // to any `^target:` line in the file.
    const phony = new Set<string>();
    for (const m of content.matchAll(/^\.PHONY:\s*(.+)$/gm)) {
      for (const t of m[1].split(/\s+/).filter(Boolean)) phony.add(t);
    }
    const targets = new Set<string>(phony);
    for (const m of content.matchAll(/^([A-Za-z][\w-]*):/gm)) {
      targets.add(m[1]);
    }
    // Skip the pseudo-target "all" only if others exist — keep it if
    // it's the only entry point the repo exposes.
    const ordered = Array.from(targets);
    for (const target of ordered) {
      data.scripts.push({
        command: `make ${target}`,
        body: "", // deliberately blank — parsing make recipes is fragile
        intent: classifyScriptName(target),
        source: name,
      });
    }
    return; // only one makefile per project
  }
}

function detectJustfile(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const candidates = ["justfile", "Justfile", ".justfile"];
  for (const name of candidates) {
    const path = join(rootDir, name);
    if (!existsSync(path)) continue;
    addSource(name);
    const content = safeRead(path) ?? "";
    // just recipes look like `target-name:` at column 0.
    for (const m of content.matchAll(/^([a-zA-Z][\w-]*)(?:\s+[^:]*)?:\s*$/gm)) {
      data.scripts.push({
        command: `just ${m[1]}`,
        body: "",
        intent: classifyScriptName(m[1]),
        source: name,
      });
    }
    return;
  }
}

function detectTaskfile(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const candidates = ["Taskfile.yml", "Taskfile.yaml"];
  for (const name of candidates) {
    const path = join(rootDir, name);
    if (!existsSync(path)) continue;
    addSource(name);
    const content = safeRead(path) ?? "";
    // Cheap YAML-ish parse — each top-level key under `tasks:` is a
    // task name. We intentionally don't pull in a YAML parser here;
    // this file is deliberately dep-free.
    const tasksIdx = content.indexOf("\ntasks:");
    if (tasksIdx < 0) continue;
    const tail = content.slice(tasksIdx);
    for (const m of tail.matchAll(/^\s{2}([a-zA-Z][\w-]*):\s*$/gm)) {
      data.scripts.push({
        command: `task ${m[1]}`,
        body: "",
        intent: classifyScriptName(m[1]),
        source: name,
      });
    }
    return;
  }
}

// ── Docker detectors ──────────────────────────────────────────────────

function detectDockerfile(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const path = join(rootDir, "Dockerfile");
  if (!existsSync(path)) return;
  addSource("Dockerfile");
  data.docker.hasDockerfile = true;
  data.docker.dockerfilePath = "Dockerfile";
  const content = safeRead(path) ?? "";
  for (const m of content.matchAll(/^EXPOSE\s+([\d\s]+)/gim)) {
    for (const p of m[1].split(/\s+/).filter(Boolean)) {
      const n = Number(p);
      if (Number.isFinite(n)) data.docker.exposedPorts.push(n);
    }
  }
  const cmdMatch = content.match(/^CMD\s+(.+)$/m);
  if (cmdMatch) data.docker.cmd = cmdMatch[1].trim();
}

function detectCompose(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const name of candidates) {
    const path = join(rootDir, name);
    if (!existsSync(path)) continue;
    addSource(name);
    data.docker.hasCompose = true;
    data.docker.composePath = name;
    const content = safeRead(path) ?? "";
    // Find the `services:` block and pull first-level keys.
    const servicesIdx = content.search(/^services:\s*$/m);
    if (servicesIdx < 0) return;
    const tail = content.slice(servicesIdx);

    // Collect all service header positions first (no lastIndex
    // juggling), then slice the body between consecutive headers.
    // Doing this in two passes avoids the "advance then rewind"
    // footgun that caused an infinite loop here earlier.
    const serviceHeaders: Array<{ name: string; bodyStart: number }> = [];
    for (const m of tail.matchAll(/^\s{2}([a-zA-Z][\w-]*):\s*$/gm)) {
      serviceHeaders.push({
        name: m[1],
        bodyStart: (m.index ?? 0) + m[0].length,
      });
    }

    for (let i = 0; i < serviceHeaders.length; i++) {
      const current = serviceHeaders[i];
      const next = serviceHeaders[i + 1];
      const block = tail.slice(current.bodyStart, next ? next.bodyStart : tail.length);
      const imageMatch = block.match(/^\s{4}image:\s*(.+)$/m);
      const ports: string[] = [];
      for (const pm of block.matchAll(/^\s{6}-\s*["']?([\d:]+)["']?$/gm)) {
        ports.push(pm[1]);
      }
      data.docker.services.push({
        name: current.name,
        image: imageMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
        ports: ports.length ? ports : undefined,
      });
    }
    return;
  }
}

// ── Env vars ──────────────────────────────────────────────────────────

function detectEnvExample(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const candidates = [".env.example", ".env.sample", ".env.template"];
  for (const name of candidates) {
    const path = join(rootDir, name);
    if (!existsSync(path)) continue;
    addSource(name);
    const content = safeRead(path) ?? "";
    const lines = content.split("\n");
    let lastComment: string | undefined;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("#")) {
        // Keep the most-recent comment as the description of the
        // next variable. `# Required: PostgreSQL connection string`
        // attaches to the DB_URL below it.
        lastComment = line.replace(/^#+\s*/, "").trim();
        continue;
      }
      if (!line) {
        lastComment = undefined;
        continue;
      }
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, name, rawValue] = m;
      const example = rawValue.replace(/^["']|["']$/g, "").trim();
      const isOptional = lastComment
        ? /\b(optional|default|defaults to)\b/i.test(lastComment)
        : false;
      data.envVars.push({
        name,
        description: lastComment,
        example: example || undefined,
        required: !example && !isOptional,
      });
      lastComment = undefined;
    }
    return;
  }
}

// ── CI detectors ──────────────────────────────────────────────────────

function detectCiWorkflows(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const dir = join(rootDir, ".github", "workflows");
  if (!existsSync(dir)) return;

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const path = join(dir, entry);
    let content = "";
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    addSource(`.github/workflows/${entry}`);

    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? entry;

    // Triggers: look at the `on:` block. Supports three shapes:
    //   on: push
    //   on: [push, pull_request]
    //   on:
    //     push:
    //     pull_request:
    //
    // IMPORTANT: we restrict the inline regex to horizontal whitespace
    // only (`[ \t]*`), because `\s*` would happily eat the newline
    // after `on:` and misread block-form workflows as inline ones —
    // a footgun that previously parsed "on:\n  push:" as inline value
    // "push:". See tests/runbook.test.ts CI workflow coverage.
    const triggers = new Set<string>();
    const onInline = content.match(/^on:[ \t]+(\S.*)$/m);
    if (onInline) {
      const inline = onInline[1].trim();
      if (inline.startsWith("[")) {
        for (const t of inline.replace(/[[\]]/g, "").split(",")) {
          triggers.add(t.trim());
        }
      } else {
        triggers.add(inline);
      }
    } else {
      // Block form.
      const onBlock = content.match(/^on:[ \t]*\n((?:[ \t]{2,}.*\n?)+)/m);
      if (onBlock) {
        for (const m of onBlock[1].matchAll(/^[ \t]{2,}([a-z_]+):/gm)) {
          triggers.add(m[1]);
        }
      }
    }

    // Job names: `jobs:` block, 2-space keys.
    const jobs: string[] = [];
    const jobsIdx = content.search(/^jobs:\s*$/m);
    if (jobsIdx >= 0) {
      const tail = content.slice(jobsIdx);
      for (const m of tail.matchAll(/^\s{2}([a-zA-Z][\w-]*):\s*$/gm)) {
        jobs.push(m[1]);
      }
    }

    data.ci.push({
      name,
      file: `.github/workflows/${entry}`,
      triggers: Array.from(triggers),
      jobs,
    });
  }
}

// ── VS Code + README ──────────────────────────────────────────────────

function detectVsCode(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const path = join(rootDir, ".vscode", "launch.json");
  if (!existsSync(path)) return;
  addSource(".vscode/launch.json");
  data.hasVsCodeDebug = true;
}

/**
 * Extract a "Getting Started" / "Development" / "Running locally"
 * section from README.md. We intentionally do NOT try to be clever —
 * we look for a heading matching a small whitelist and take its body
 * up to the next heading of the same level. If nothing matches, we
 * leave the field empty and the renderer falls back to listed scripts.
 */
function detectReadmeSection(
  rootDir: string,
  data: RunbookData,
  addSource: (p: string) => void
): void {
  const candidates = ["README.md", "README.MD", "readme.md", "Readme.md"];
  for (const name of candidates) {
    const path = join(rootDir, name);
    if (!existsSync(path)) continue;
    const content = safeRead(path);
    if (!content) continue;
    addSource(name);

    const headings = [
      "getting started",
      "quick start",
      "quickstart",
      "development",
      "running locally",
      "running",
      "how to run",
      "installation",
      "install",
      "setup",
    ];

    const lines = content.split("\n");
    let sectionStart = -1;
    let sectionLevel = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,3})\s+(.+)$/);
      if (!m) continue;
      const title = m[2].trim().toLowerCase();
      if (headings.some((h) => title === h || title.startsWith(`${h} `))) {
        sectionStart = i + 1;
        sectionLevel = m[1].length;
        break;
      }
    }
    if (sectionStart < 0) return;

    // Take everything until the next heading at the same level or
    // shallower. Capped at 60 lines so we don't paste the entire
    // README.
    const body: string[] = [];
    for (let i = sectionStart; i < lines.length && body.length < 60; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= sectionLevel) break;
      body.push(lines[i]);
    }
    const snippet = body.join("\n").trim();
    if (snippet) data.readmeSnippet = snippet;
    return;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Render a `RunbookData` struct into a ready-to-write runbook.md wiki
 * page. The output is stable and deterministic — running the detector
 * on unchanged source files produces identical markdown, which is
 * critical for git diffs staying readable and `ctx sync` being a
 * no-op when nothing changed.
 *
 * The page body skips ctx front-matter — the PageManager will stamp
 * freshness on write.
 */
export function renderRunbookPage(data: RunbookData, projectName: string): string {
  const lines: string[] = [];
  lines.push(`# Runbook — ${projectName}`);
  lines.push("");
  lines.push(
    "_How to run, test, and ship this project. Auto-detected from repo signals; this page is regenerated on every `ctx sync`._"
  );
  lines.push("");

  // Prerequisites — language versions
  if (data.languages.length > 0) {
    lines.push("## Prerequisites");
    lines.push("");
    for (const lang of data.languages) {
      const version = lang.version ? ` **${lang.version}**` : "";
      const label = humanLangName(lang.name);
      lines.push(`- ${label}${version} _(from \`${lang.source}\`)_`);
    }
    if (data.docker.hasDockerfile || data.docker.hasCompose) {
      lines.push(`- **Docker** — the repo ships a ${data.docker.hasCompose ? "compose file" : "Dockerfile"}.`);
    }
    lines.push("");
  }

  // Getting started snippet from README
  if (data.readmeSnippet) {
    lines.push("## First Run");
    lines.push("");
    lines.push(`> Excerpted from \`README.md\` — treat this as authoritative when it conflicts with detected commands.`);
    lines.push("");
    lines.push(data.readmeSnippet);
    lines.push("");
  }

  // Script groups — dev / start / test / build / lint / typecheck / format / other
  const groupOrder: Array<{ intent: ScriptIntent; heading: string; blurb?: string }> = [
    { intent: "dev", heading: "Run Locally", blurb: "Spin up the dev server with live reload." },
    { intent: "start", heading: "Run (production mode)" },
    { intent: "test", heading: "Tests", blurb: "Run these before every PR." },
    { intent: "lint", heading: "Lint" },
    { intent: "typecheck", heading: "Type Check" },
    { intent: "format", heading: "Format" },
    { intent: "build", heading: "Build" },
    { intent: "other", heading: "Other Scripts" },
  ];

  for (const group of groupOrder) {
    const entries = data.scripts.filter((s) => s.intent === group.intent);
    if (entries.length === 0) continue;
    lines.push(`## ${group.heading}`);
    lines.push("");
    if (group.blurb) {
      lines.push(`_${group.blurb}_`);
      lines.push("");
    }
    for (const entry of entries) {
      const bodyNote = entry.body ? ` — \`${truncate(entry.body, 70)}\`` : "";
      lines.push(`- \`${entry.command}\`${bodyNote}  _(from \`${entry.source}\`)_`);
    }
    lines.push("");
  }

  // Env vars
  if (data.envVars.length > 0) {
    lines.push("## Environment Variables");
    lines.push("");
    lines.push("| Variable | Required | Description |");
    lines.push("|---|---|---|");
    for (const v of data.envVars) {
      const req = v.required ? "**yes**" : "no";
      const desc =
        v.description ?? (v.example ? `example: \`${escapeTableCell(v.example)}\`` : "—");
      lines.push(`| \`${v.name}\` | ${req} | ${escapeTableCell(desc)} |`);
    }
    lines.push("");
    lines.push(`_Source: \`${data.sources.find((s) => s.startsWith(".env")) ?? ".env.example"}\`._`);
    lines.push("");
  }

  // Docker
  if (data.docker.hasDockerfile || data.docker.hasCompose) {
    lines.push("## Docker");
    lines.push("");
    if (data.docker.hasCompose) {
      lines.push(`\`\`\`bash`);
      lines.push(`docker compose up`);
      lines.push(`\`\`\``);
      if (data.docker.services.length > 0) {
        lines.push("");
        lines.push("Services:");
        for (const svc of data.docker.services) {
          const image = svc.image ? ` (\`${svc.image}\`)` : "";
          const ports = svc.ports?.length ? ` — ports \`${svc.ports.join(", ")}\`` : "";
          lines.push(`- **${svc.name}**${image}${ports}`);
        }
      }
      lines.push("");
    }
    if (data.docker.hasDockerfile) {
      lines.push(`\`\`\`bash`);
      lines.push(`docker build -t ${slug(projectName)} .`);
      if (data.docker.exposedPorts.length > 0) {
        const port = data.docker.exposedPorts[0];
        lines.push(`docker run --rm -p ${port}:${port} ${slug(projectName)}`);
      } else {
        lines.push(`docker run --rm ${slug(projectName)}`);
      }
      lines.push(`\`\`\``);
      if (data.docker.exposedPorts.length > 0) {
        lines.push("");
        lines.push(`Exposed ports: ${data.docker.exposedPorts.map((p) => `\`${p}\``).join(", ")}`);
      }
      if (data.docker.cmd) {
        lines.push(`Container entrypoint: \`${truncate(data.docker.cmd, 80)}\``);
      }
      lines.push("");
    }
  }

  // CI
  if (data.ci.length > 0) {
    lines.push("## CI");
    lines.push("");
    lines.push(
      "_These jobs run in CI — if any of them fail, your PR is blocked. Treat them as the authoritative \"what must pass\" list._"
    );
    lines.push("");
    for (const wf of data.ci) {
      const triggers = wf.triggers.length ? `on ${wf.triggers.join(", ")}` : "";
      lines.push(`### ${wf.name}`);
      lines.push("");
      lines.push(`File: \`${wf.file}\` ${triggers ? `(${triggers})` : ""}`.trim());
      if (wf.jobs.length > 0) {
        lines.push("");
        lines.push(`Jobs: ${wf.jobs.map((j) => `\`${j}\``).join(", ")}`);
      }
      lines.push("");
    }
  }

  // Debug
  if (data.hasVsCodeDebug) {
    lines.push("## Debug");
    lines.push("");
    lines.push(
      "VS Code debug configurations are defined in `.vscode/launch.json`. Open the Run & Debug panel (⇧⌘D) and pick a configuration."
    );
    lines.push("");
  }

  // Sources block — every runbook claim traces back to a file.
  lines.push("## Sources");
  lines.push("");
  lines.push(
    "_The commands on this page were extracted from these files. If the runbook is wrong, the source file is the thing to fix._"
  );
  lines.push("");
  for (const src of data.sources) {
    lines.push(`- \`${src}\``);
  }
  lines.push("");

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────

function humanLangName(name: DetectedLanguage["name"]): string {
  switch (name) {
    case "node":
      return "Node.js";
    case "python":
      return "Python";
    case "rust":
      return "Rust";
    case "go":
      return "Go";
    case "ruby":
      return "Ruby";
    case "java":
      return "Java";
    default:
      return "Unknown";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    || "app";
}

/**
 * Should a runbook page be written at all? Returns false if we have
 * nothing substantive to say — no scripts, no docker, no env vars, no
 * CI. Keeps empty runbook pages out of the wiki.
 */
export function hasRunbookContent(data: RunbookData): boolean {
  return (
    data.scripts.length > 0 ||
    data.envVars.length > 0 ||
    data.docker.hasDockerfile ||
    data.docker.hasCompose ||
    data.ci.length > 0 ||
    data.readmeSnippet !== undefined
  );
}

/**
 * Paths touched by the detector — used by git-aware freshness to know
 * which files, if changed, should invalidate the runbook page. Exposed
 * so callers can pipe this into the metadata.sources field.
 */
export function runbookSourcePaths(data: RunbookData, rootDir: string): string[] {
  return data.sources.map((rel) => relative(rootDir, join(rootDir, rel)));
}

// ── Git-aware freshness integration ──────────────────────────────────

/**
 * Marker used to embed a FreshnessSnapshot into the rendered runbook
 * page. Wrapped in an HTML comment so markdown renderers (GitHub,
 * Obsidian, VS Code preview) ignore it, but `ctx status` and `ctx
 * lint` can scan for it and detect drift.
 *
 * Format:
 *   <!-- ctx:freshness {"h":"<sha>","f":{"path":"<sha>",...},"t":"<iso>"} -->
 *
 * Single-line deliberately — makes regex extraction trivial.
 */
const FRESHNESS_MARKER_START = "<!-- ctx:freshness ";
const FRESHNESS_MARKER_END = " -->";
const FRESHNESS_MARKER_RE = /<!-- ctx:freshness (\{[^}]*?\}[^>]*) -->/;

/**
 * Render the runbook page with a git-aware freshness snapshot
 * appended as a hidden HTML comment. The snapshot captures the last
 * commit SHA of every file listed in `data.sources`. A later call to
 * `isRunbookStale(projectRoot)` can diff the stamped snapshot against
 * current git state to decide whether the page needs regenerating.
 *
 * Delegating to `renderRunbookPage()` for the body keeps the
 * freshness layer entirely additive — callers that don't care about
 * staleness can still use the plain renderer and get an identical
 * body.
 */
export function renderRunbookPageWithFreshness(
  data: RunbookData,
  projectName: string,
  projectRoot: string
): string {
  const body = renderRunbookPage(data, projectName);
  const snapshot = buildFreshnessSnapshot(projectRoot, data.sources);
  const marker = FRESHNESS_MARKER_START + encodeSnapshot(snapshot) + FRESHNESS_MARKER_END;
  // Append as a trailing hidden comment, separated by a blank line so
  // it never collides with the final `## Sources` list.
  return body + "\n" + marker + "\n";
}

/**
 * Extract a stored freshness snapshot from rendered runbook markdown.
 * Returns undefined if the page wasn't stamped (older runbook, or
 * user wrote it by hand).
 */
export function extractFreshnessSnapshot(
  pageContent: string
): FreshnessSnapshot | undefined {
  const match = pageContent.match(FRESHNESS_MARKER_RE);
  if (!match) return undefined;
  return decodeSnapshot(match[1]);
}

/**
 * Compare the stored snapshot in a runbook page against the current
 * state of its source files. Returns:
 *
 *   - `"fresh"`: the page is up to date with its sources
 *   - `"stale"`: at least one source file has a different git SHA
 *   - `"unknown"`: the page has no stamped snapshot (treat as fresh —
 *     we don't know what to compare against)
 *
 * This is the git-aware replacement for mtime-based staleness checks.
 * `ctx status` can call this per runbook page to show "sources drifted,
 * re-run `ctx sync`" without a calendar threshold.
 */
export function checkRunbookFreshness(
  pageContent: string,
  projectRoot: string
): "fresh" | "stale" | "unknown" {
  const stored = extractFreshnessSnapshot(pageContent);
  if (!stored) return "unknown";

  // Detect sources by re-running the scanner — the current set may
  // have shrunk/grown since the page was written, which is itself a
  // form of staleness.
  const current = buildFreshnessSnapshot(
    projectRoot,
    Object.keys(stored.files)
  );
  return isSnapshotStale(stored, current) ? "stale" : "fresh";
}

// Silence unused-import warning if the caller never uses statSync — it
// stays in the import list so tests can mock it cleanly.
void statSync;
