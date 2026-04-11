import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRunbook,
  renderRunbookPage,
  renderRunbookPageWithFreshness,
  extractFreshnessSnapshot,
  checkRunbookFreshness,
  hasRunbookContent,
  classifyScriptName,
} from "../src/wiki/runbook.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-runbook-test-"));
}

describe("classifyScriptName", () => {
  it("classifies dev commands", () => {
    expect(classifyScriptName("dev")).toBe("dev");
    expect(classifyScriptName("dev:watch")).toBe("dev");
    expect(classifyScriptName("serve")).toBe("dev");
    expect(classifyScriptName("watch")).toBe("dev");
  });
  it("classifies start commands", () => {
    expect(classifyScriptName("start")).toBe("start");
    expect(classifyScriptName("launch")).toBe("start");
  });
  it("classifies test commands", () => {
    expect(classifyScriptName("test")).toBe("test");
    expect(classifyScriptName("test:unit")).toBe("test");
    expect(classifyScriptName("test:e2e")).toBe("test");
    expect(classifyScriptName("e2e")).toBe("test");
    expect(classifyScriptName("unit")).toBe("test");
  });
  it("classifies build commands", () => {
    expect(classifyScriptName("build")).toBe("build");
    expect(classifyScriptName("compile")).toBe("build");
    expect(classifyScriptName("bundle")).toBe("build");
  });
  it("classifies lint commands", () => {
    expect(classifyScriptName("lint")).toBe("lint");
    expect(classifyScriptName("eslint")).toBe("lint");
  });
  it("classifies typecheck commands", () => {
    expect(classifyScriptName("typecheck")).toBe("typecheck");
    expect(classifyScriptName("tsc")).toBe("typecheck");
    expect(classifyScriptName("type-check")).toBe("typecheck");
  });
  it("falls back to other for unknowns", () => {
    expect(classifyScriptName("deploy")).toBe("other");
    expect(classifyScriptName("release")).toBe("other");
    expect(classifyScriptName("preflight")).toBe("other");
  });
});

describe("detectRunbook — Node projects", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts node scripts from package.json", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        engines: { node: ">=20" },
        scripts: {
          dev: "vite",
          build: "vite build",
          test: "vitest run",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
        },
      })
    );

    const data = detectRunbook(dir);

    expect(data.languages).toEqual([
      { name: "node", version: ">=20", source: "package.json" },
    ]);
    expect(data.scripts.map((s) => s.command).sort()).toEqual(
      [
        "npm run dev",
        "npm run build",
        "npm test",
        "npm run lint",
        "npm run typecheck",
      ].sort()
    );
    expect(data.scripts.find((s) => s.command === "npm test")?.intent).toBe("test");
    expect(data.scripts.find((s) => s.command === "npm run dev")?.intent).toBe("dev");
    expect(data.sources).toContain("package.json");
  });

  it("respects .nvmrc when engines is missing", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(join(dir, ".nvmrc"), "20.12.0\n");

    const data = detectRunbook(dir);

    expect(data.languages[0].version).toBe("20.12.0");
    expect(data.languages[0].source).toBe(".nvmrc");
    expect(data.sources).toContain(".nvmrc");
  });

  it("uses pnpm when package.json declares it", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        packageManager: "pnpm@9.0.0",
        scripts: { dev: "vite", test: "vitest" },
      })
    );

    const data = detectRunbook(dir);

    expect(data.scripts.find((s) => s.intent === "dev")?.command).toBe("pnpm dev");
    expect(data.scripts.find((s) => s.intent === "test")?.command).toBe("pnpm test");
  });

  it("uses yarn when packageManager is yarn", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        packageManager: "yarn@4.0.0",
        scripts: { dev: "vite", build: "vite build" },
      })
    );

    const data = detectRunbook(dir);

    expect(data.scripts.find((s) => s.intent === "dev")?.command).toBe("yarn dev");
    expect(data.scripts.find((s) => s.intent === "build")?.command).toBe("yarn build");
  });
});

describe("detectRunbook — Makefile and justfile", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("pulls Makefile .PHONY targets", () => {
    writeFileSync(
      join(dir, "Makefile"),
      [
        ".PHONY: build test lint clean",
        "",
        "build:",
        "\tgo build ./...",
        "",
        "test:",
        "\tgo test ./...",
        "",
        "lint:",
        "\tgolangci-lint run",
        "",
        "clean:",
        "\trm -rf bin/",
      ].join("\n")
    );

    const data = detectRunbook(dir);
    const commands = data.scripts.map((s) => s.command);

    expect(commands).toContain("make build");
    expect(commands).toContain("make test");
    expect(commands).toContain("make lint");
    expect(commands).toContain("make clean");
    expect(data.scripts.find((s) => s.command === "make test")?.intent).toBe("test");
    expect(data.sources).toContain("Makefile");
  });

  it("pulls justfile targets", () => {
    writeFileSync(
      join(dir, "justfile"),
      [
        "dev:",
        "    cargo run",
        "",
        "test:",
        "    cargo test",
        "",
        "build:",
        "    cargo build --release",
      ].join("\n")
    );

    const data = detectRunbook(dir);
    const commands = data.scripts.map((s) => s.command);
    expect(commands).toContain("just dev");
    expect(commands).toContain("just test");
    expect(commands).toContain("just build");
  });
});

describe("detectRunbook — Docker", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects Dockerfile EXPOSE + CMD", () => {
    writeFileSync(
      join(dir, "Dockerfile"),
      [
        "FROM node:20-alpine",
        "WORKDIR /app",
        "COPY . .",
        "RUN npm ci",
        "EXPOSE 3000",
        "CMD [\"node\", \"server.js\"]",
      ].join("\n")
    );

    const data = detectRunbook(dir);
    expect(data.docker.hasDockerfile).toBe(true);
    expect(data.docker.exposedPorts).toEqual([3000]);
    expect(data.docker.cmd).toContain("node");
  });

  it("detects docker-compose services", () => {
    writeFileSync(
      join(dir, "docker-compose.yml"),
      [
        "version: '3.8'",
        "services:",
        "  api:",
        "    image: node:20-alpine",
        "    ports:",
        "      - '3000:3000'",
        "  db:",
        "    image: postgres:15",
        "    ports:",
        "      - '5432:5432'",
      ].join("\n")
    );

    const data = detectRunbook(dir);
    expect(data.docker.hasCompose).toBe(true);
    expect(data.docker.services.map((s) => s.name).sort()).toEqual(["api", "db"]);
    expect(data.docker.services.find((s) => s.name === "api")?.image).toBe("node:20-alpine");
    expect(data.docker.services.find((s) => s.name === "db")?.image).toBe("postgres:15");
  });
});

describe("detectRunbook — env vars", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts env vars with descriptions and required flag", () => {
    writeFileSync(
      join(dir, ".env.example"),
      [
        "# Database connection",
        "DATABASE_URL=",
        "",
        "# API key (optional, defaults to anonymous)",
        "API_KEY=",
        "",
        "# App port",
        "PORT=3000",
      ].join("\n")
    );

    const data = detectRunbook(dir);
    const byName = Object.fromEntries(data.envVars.map((v) => [v.name, v]));

    expect(byName.DATABASE_URL.required).toBe(true);
    expect(byName.DATABASE_URL.description).toBe("Database connection");
    expect(byName.API_KEY.required).toBe(false);
    expect(byName.PORT.example).toBe("3000");
    expect(byName.PORT.required).toBe(false);
  });
});

describe("detectRunbook — CI workflows", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts workflow name, triggers, and jobs", () => {
    const wfDir = join(dir, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "ci.yml"),
      [
        "name: CI",
        "on:",
        "  push:",
        "  pull_request:",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm run build",
      ].join("\n")
    );

    const data = detectRunbook(dir);
    expect(data.ci.length).toBe(1);
    expect(data.ci[0].name).toBe("CI");
    expect(data.ci[0].triggers.sort()).toEqual(["pull_request", "push"]);
    expect(data.ci[0].jobs.sort()).toEqual(["build", "test"]);
  });
});

describe("detectRunbook — README snippet extraction", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts the Getting Started section", () => {
    writeFileSync(
      join(dir, "README.md"),
      [
        "# My Project",
        "",
        "Some intro text.",
        "",
        "## Getting Started",
        "",
        "Install deps:",
        "",
        "```",
        "npm install",
        "```",
        "",
        "Run the dev server:",
        "",
        "```",
        "npm run dev",
        "```",
        "",
        "## Architecture",
        "",
        "Other stuff here.",
      ].join("\n")
    );

    const data = detectRunbook(dir);
    expect(data.readmeSnippet).toContain("npm install");
    expect(data.readmeSnippet).toContain("npm run dev");
    // Should not bleed into the Architecture section.
    expect(data.readmeSnippet).not.toContain("Other stuff here");
  });
});

describe("renderRunbookPage", () => {
  it("renders a complete runbook page", () => {
    const data = detectRunbook(makeTempDir()); // empty
    data.languages.push({ name: "node", version: "20", source: "package.json" });
    data.scripts.push(
      { command: "npm run dev", body: "vite", intent: "dev", source: "package.json" },
      { command: "npm test", body: "vitest", intent: "test", source: "package.json" }
    );
    data.envVars.push({
      name: "DATABASE_URL",
      required: true,
      description: "Postgres connection string",
    });
    data.sources.push("package.json", ".env.example");

    const page = renderRunbookPage(data, "demo-app");

    expect(page).toContain("# Runbook — demo-app");
    expect(page).toContain("## Run Locally");
    expect(page).toContain("npm run dev");
    expect(page).toContain("## Tests");
    expect(page).toContain("npm test");
    expect(page).toContain("## Environment Variables");
    expect(page).toContain("DATABASE_URL");
    expect(page).toContain("## Sources");
    expect(page).toContain("package.json");
  });
});

describe("hasRunbookContent", () => {
  it("returns false for an empty data struct", () => {
    const data = detectRunbook(makeTempDir());
    expect(hasRunbookContent(data)).toBe(false);
  });
  it("returns true when any signal is present", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );
    const data = detectRunbook(dir);
    expect(hasRunbookContent(data)).toBe(true);
  });
});

// ─ Git-aware freshness integration ────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  }).trim();
}

function initGitRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@withctx.dev"]);
  git(dir, ["config", "user.name", "withctx test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

describe("renderRunbookPageWithFreshness + checkRunbookFreshness", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-runbook-fresh-"));
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stamps a ctx:freshness marker into the rendered page", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-q", "-m", "init"]);

    const data = detectRunbook(dir);
    const page = renderRunbookPageWithFreshness(data, "my-project", dir);
    expect(page).toContain("<!-- ctx:freshness ");
    // Should still contain the normal body headings.
    expect(page).toContain("# Runbook — my-project");
  });

  it("can round-trip the stamped snapshot via extractFreshnessSnapshot", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } })
    );
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-q", "-m", "init"]);

    const data = detectRunbook(dir);
    const page = renderRunbookPageWithFreshness(data, "my-project", dir);
    const snap = extractFreshnessSnapshot(page);
    expect(snap).toBeDefined();
    expect(snap!.files["package.json"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports fresh when sources haven't moved", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-q", "-m", "init"]);

    const data = detectRunbook(dir);
    const page = renderRunbookPageWithFreshness(data, "my-project", dir);
    expect(checkRunbookFreshness(page, dir)).toBe("fresh");
  });

  it("reports stale when a source file was re-committed", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-q", "-m", "init"]);

    const data = detectRunbook(dir);
    const page = renderRunbookPageWithFreshness(data, "my-project", dir);

    // Touch package.json and commit again — SHA moves.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest --run" } })
    );
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-q", "-m", "update test command"]);

    expect(checkRunbookFreshness(page, dir)).toBe("stale");
  });

  it("reports unknown for an older page with no stamped snapshot", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );
    git(dir, ["add", "package.json"]);
    git(dir, ["commit", "-q", "-m", "init"]);

    const data = detectRunbook(dir);
    // Use the plain renderer — no freshness marker.
    const page = renderRunbookPage(data, "my-project");
    expect(checkRunbookFreshness(page, dir)).toBe("unknown");
  });
});
