import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAssertions,
  runAssertion,
  verifyPage,
  applyVerification,
  looksLikePath,
  type Assertion,
} from "../src/wiki/verify.js";
import { parsePage } from "../src/wiki/metadata.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ctx-verify-"));
}

function fixedDate(): Date {
  return new Date("2026-04-10T12:00:00.000Z");
}

// ── looksLikePath ────────────────────────────────────────────────────

describe("looksLikePath", () => {
  it("accepts top-level project dirs", () => {
    expect(looksLikePath("src/cli/index.ts")).toBe(true);
    expect(looksLikePath("tests/foo.test.ts")).toBe(true);
    expect(looksLikePath("docs/guide/01-quickstart.md")).toBe(true);
    expect(looksLikePath(".github/workflows/ci.yml")).toBe(true);
  });

  it("accepts paths with recognised extensions even if the head dir is unknown", () => {
    expect(looksLikePath("foo/bar/baz.ts")).toBe(true);
    expect(looksLikePath("a/b.json")).toBe(true);
  });

  it("rejects code-ish tokens", () => {
    expect(looksLikePath("useState")).toBe(false);
    expect(looksLikePath("Array.from")).toBe(false);
    expect(looksLikePath("git status")).toBe(false);
    expect(looksLikePath("--help")).toBe(false);
    expect(looksLikePath("/etc/passwd")).toBe(false);
    expect(looksLikePath("https://example.com/x")).toBe(false);
  });

  it("rejects empty / whitespace tokens", () => {
    expect(looksLikePath("")).toBe(false);
    expect(looksLikePath("foo bar")).toBe(false);
  });
});

// ── extractAssertions: auto-detection ────────────────────────────────

describe("extractAssertions: auto", () => {
  it("picks up backticked paths from prose", () => {
    const body = "We compile pages from `src/wiki/compiler.ts` and store them in `.ctx/context/`.\n";
    const a = extractAssertions(body);
    // .ctx/context/ has no extension, but .ctx is a known top dir.
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ kind: "path-exists", target: "src/wiki/compiler.ts", origin: "auto" });
    expect(a[1]).toMatchObject({ kind: "path-exists", target: ".ctx/context/", origin: "auto" });
  });

  it("ignores backticks inside fenced code blocks", () => {
    const body = [
      "Outside fence: `src/cli/index.ts`",
      "```ts",
      "import x from `src/should-be-ignored.ts`;",
      "```",
      "After fence: `tests/post.test.ts`",
    ].join("\n");
    const a = extractAssertions(body);
    expect(a.map((x) => x.target)).toEqual([
      "src/cli/index.ts",
      "tests/post.test.ts",
    ]);
  });

  it("de-dupes the same path mentioned twice", () => {
    const body = "First mention `src/foo.ts`. Second mention `src/foo.ts` again.\n";
    const a = extractAssertions(body);
    expect(a).toHaveLength(1);
  });

  it("explicitOnly skips auto-detection entirely", () => {
    const body = "Path-ish: `src/cli/index.ts`. No assertions wanted.\n";
    expect(extractAssertions(body, { explicitOnly: true })).toEqual([]);
  });
});

// ── extractAssertions: explicit ctx-assert blocks ────────────────────

describe("extractAssertions: explicit blocks", () => {
  it("parses path-exists, grep, regex, no-match", () => {
    const body = [
      "# Page",
      "",
      "```ctx-assert",
      "# comment line",
      "path-exists src/cli/index.ts",
      'grep package.json "withctx"',
      "regex src/foo.ts /export\\s+function/",
      'no-match src/legacy.ts "TODO"',
      "```",
    ].join("\n");
    const a = extractAssertions(body);
    expect(a).toHaveLength(4);
    expect(a[0]).toMatchObject({ kind: "path-exists", target: "src/cli/index.ts", origin: "explicit" });
    expect(a[1]).toMatchObject({ kind: "grep", target: "package.json", pattern: "withctx" });
    expect(a[2]).toMatchObject({ kind: "regex", target: "src/foo.ts", pattern: "/export\\s+function/" });
    expect(a[3]).toMatchObject({ kind: "no-match", target: "src/legacy.ts", pattern: "TODO" });
  });

  it("explicit assertions are not double-counted as auto", () => {
    const body = [
      "Auto-eligible: `src/foo.ts`",
      "",
      "```ctx-assert",
      "path-exists src/foo.ts",
      "```",
    ].join("\n");
    const a = extractAssertions(body);
    // Only one assertion for src/foo.ts, marked explicit (or auto — we
    // de-dupe by key, so the survivor is whichever came first).
    const targets = a.filter((x) => x.target === "src/foo.ts");
    expect(targets).toHaveLength(1);
  });

  it("ignores blank lines and comments inside blocks", () => {
    const body = [
      "```ctx-assert",
      "",
      "# this is a comment",
      "path-exists package.json",
      "",
      "```",
    ].join("\n");
    const a = extractAssertions(body);
    expect(a).toHaveLength(1);
    expect(a[0].target).toBe("package.json");
  });
});

// ── runAssertion ─────────────────────────────────────────────────────

describe("runAssertion: path-exists", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpProject();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when the file exists", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src/index.ts"), "export {};");
    const a: Assertion = {
      kind: "path-exists",
      source: "src/index.ts",
      target: "src/index.ts",
      line: 0,
      origin: "auto",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(true);
  });

  it("fails when the file is missing", () => {
    const a: Assertion = {
      kind: "path-exists",
      source: "src/missing.ts",
      target: "src/missing.ts",
      line: 0,
      origin: "auto",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("does not exist");
  });

  it("rejects absolute targets", () => {
    const a: Assertion = {
      kind: "path-exists",
      source: "/etc/passwd",
      target: "/etc/passwd",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("absolute");
  });

  it("rejects path traversal", () => {
    const a: Assertion = {
      kind: "path-exists",
      source: "../../../etc/passwd",
      target: "../../../etc/passwd",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("escapes");
  });

  it("rejects path traversal hidden inside a legitimate prefix", () => {
    // `src/../../etc/passwd` normalises to `../etc/passwd`, which must
    // be caught even though the first segment (`src`) looks innocent.
    mkdirSync(join(tmp, "src"), { recursive: true });
    const a: Assertion = {
      kind: "path-exists",
      source: "src/../../etc/passwd",
      target: "src/../../etc/passwd",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("escapes");
  });

  it("rejects a NUL byte in the target", () => {
    const a: Assertion = {
      kind: "path-exists",
      source: "foo.ts\0.txt",
      target: "foo.ts\0.txt",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("NUL");
  });

  it("rejects a symlink that escapes the project root", () => {
    // Only POSIX — Windows symlink creation needs admin and the
    // containment guard has a per-platform test story.
    if (process.platform === "win32") return;
    // Create a project-relative symlink `escape` → /etc so a reader
    // of `escape/passwd` would leak /etc/passwd. The realpath check
    // should catch it.
    const target = "/etc";
    try {
      symlinkSync(target, join(tmp, "escape"));
    } catch {
      // Some CI sandboxes forbid symlink creation entirely. In that
      // case we can't exercise the branch, so skip.
      return;
    }
    const a: Assertion = {
      kind: "path-exists",
      source: "escape/passwd",
      target: "escape/passwd",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("escapes");
  });

  it("rejects a .env file target even if it exists inside the project", () => {
    // The threat: a ctx-assert block with `grep .env SECRET_KEY` would
    // turn the verifier into a one-bit oracle against the contents of
    // the developer's local env file. We refuse those paths outright.
    writeFileSync(join(tmp, ".env"), "SECRET=sk-ant-fake\n");
    const a: Assertion = {
      kind: "path-exists",
      source: ".env",
      target: ".env",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("sensitive");
  });

  it("rejects a grep against .env.production", () => {
    writeFileSync(join(tmp, ".env.production"), "ANTHROPIC_API_KEY=sk-ant-fake\n");
    const a: Assertion = {
      kind: "grep",
      source: 'grep .env.production "sk-ant"',
      target: ".env.production",
      pattern: "sk-ant",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("sensitive");
  });

  it("rejects anything under .ssh/", () => {
    mkdirSync(join(tmp, ".ssh"), { recursive: true });
    writeFileSync(join(tmp, ".ssh", "id_rsa"), "PRIVATE KEY\n");
    const a: Assertion = {
      kind: "path-exists",
      source: ".ssh/id_rsa",
      target: ".ssh/id_rsa",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("sensitive");
  });

  it("rejects a .pem file regardless of directory", () => {
    mkdirSync(join(tmp, "certs"), { recursive: true });
    writeFileSync(join(tmp, "certs", "tls.pem"), "-----BEGIN CERT-----\n");
    const a: Assertion = {
      kind: "path-exists",
      source: "certs/tls.pem",
      target: "certs/tls.pem",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("sensitive");
  });

  it("accepts an ordinary source file alongside the sensitive blocklist", () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "index.ts"), "export const ok = true;\n");
    const a: Assertion = {
      kind: "path-exists",
      source: "src/index.ts",
      target: "src/index.ts",
      line: 0,
      origin: "explicit",
    };
    const r = runAssertion(a, { projectRoot: tmp });
    expect(r.ok).toBe(true);
  });
});

describe("runAssertion: grep", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpProject();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes when the substring is present", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "withctx" }));
    const r = runAssertion(
      {
        kind: "grep",
        source: 'grep package.json "withctx"',
        target: "package.json",
        pattern: "withctx",
        line: 0,
        origin: "explicit",
      },
      { projectRoot: tmp }
    );
    expect(r.ok).toBe(true);
  });

  it("fails when the substring is absent", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "other" }));
    const r = runAssertion(
      {
        kind: "grep",
        source: 'grep package.json "withctx"',
        target: "package.json",
        pattern: "withctx",
        line: 0,
        origin: "explicit",
      },
      { projectRoot: tmp }
    );
    expect(r.ok).toBe(false);
  });
});

describe("runAssertion: regex / no-match", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpProject();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("regex passes a /pattern/flags literal", () => {
    writeFileSync(join(tmp, "foo.ts"), "export function bar() {}\n");
    const r = runAssertion(
      {
        kind: "regex",
        source: "regex foo.ts /export\\s+function/",
        target: "foo.ts",
        pattern: "/export\\s+function/",
        line: 0,
        origin: "explicit",
      },
      { projectRoot: tmp }
    );
    expect(r.ok).toBe(true);
  });

  it("regex fails on an invalid pattern", () => {
    writeFileSync(join(tmp, "foo.ts"), "x");
    const r = runAssertion(
      {
        kind: "regex",
        source: "bad",
        target: "foo.ts",
        pattern: "/(unbalanced/",
        line: 0,
        origin: "explicit",
      },
      { projectRoot: tmp }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("invalid regex");
  });

  it("no-match flags forbidden substrings", () => {
    writeFileSync(join(tmp, "legacy.ts"), "// TODO: rewrite this\n");
    const r = runAssertion(
      {
        kind: "no-match",
        source: 'no-match legacy.ts "TODO"',
        target: "legacy.ts",
        pattern: "TODO",
        line: 0,
        origin: "explicit",
      },
      { projectRoot: tmp }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("forbidden");
  });
});

// ── verifyPage / applyVerification ───────────────────────────────────

describe("verifyPage", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpProject();
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src/index.ts"), "export {};");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns assertions and per-result outcomes", () => {
    const body = "The entry point is `src/index.ts` and the missing one is `src/missing.ts`.";
    const r = verifyPage(body, { projectRoot: tmp, now: fixedDate() });
    expect(r.assertions).toHaveLength(2);
    expect(r.results).toHaveLength(2);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.ranAt).toBe("2026-04-10T12:00:00.000Z");
  });

  it("returns zero counts when there are no assertions", () => {
    const body = "Plain prose with no path-ish backticks.";
    const r = verifyPage(body, { projectRoot: tmp });
    expect(r.assertions).toHaveLength(0);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
  });

  it("strips ctx front-matter before scanning the body", () => {
    const content = [
      "---",
      "ctx:",
      "  refreshed_at: 2026-04-01T00:00:00.000Z",
      "---",
      "",
      "Real body mentions `src/index.ts`.",
    ].join("\n");
    const r = verifyPage(content, { projectRoot: tmp });
    expect(r.assertions).toHaveLength(1);
  });
});

describe("applyVerification", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpProject();
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src/index.ts"), "export {};");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stamps verified counts into the page front-matter", () => {
    const content = "Body mentions `src/index.ts`.\n";
    const out = applyVerification(content, { projectRoot: tmp, now: fixedDate() });
    const parsed = parsePage(out.content);
    expect(parsed.meta.verified?.passed).toBe(1);
    expect(parsed.meta.verified?.failed).toBe(0);
    expect(parsed.meta.verified?.last_run_at).toBe("2026-04-10T12:00:00.000Z");
  });

  it("promotes tier to verified when all assertions pass", () => {
    const content = [
      "---",
      "ctx:",
      "  tier: asserted",
      "---",
      "",
      "Body mentions `src/index.ts`.",
    ].join("\n");
    const out = applyVerification(content, { projectRoot: tmp, now: fixedDate() });
    const parsed = parsePage(out.content);
    expect(parsed.meta.tier).toBe("verified");
  });

  it("does not promote tier when there are zero assertions", () => {
    const content = [
      "---",
      "ctx:",
      "  tier: manual",
      "---",
      "",
      "No assertable content here.",
    ].join("\n");
    const out = applyVerification(content, { projectRoot: tmp });
    const parsed = parsePage(out.content);
    expect(parsed.meta.tier).toBe("manual");
  });

  it("demotes verified→asserted when an assertion fails", () => {
    const content = [
      "---",
      "ctx:",
      "  tier: verified",
      "---",
      "",
      "Body mentions `src/missing.ts`.",
    ].join("\n");
    const out = applyVerification(content, { projectRoot: tmp });
    const parsed = parsePage(out.content);
    expect(parsed.meta.tier).toBe("asserted");
    expect(parsed.meta.verified?.failed).toBe(1);
  });

  it("preserves user-authored front-matter on stamp", () => {
    const content = [
      "---",
      "title: My Page",
      "tags:",
      "  - architecture",
      "ctx:",
      "  tier: asserted",
      "---",
      "",
      "Body mentions `src/index.ts`.",
    ].join("\n");
    const out = applyVerification(content, { projectRoot: tmp });
    expect(out.content).toContain("title: My Page");
    expect(out.content).toContain("- architecture");
    const parsed = parsePage(out.content);
    expect(parsed.meta.tier).toBe("verified");
  });

  it("is idempotent for a clean run", () => {
    const content = "Body mentions `src/index.ts`.\n";
    const first = applyVerification(content, { projectRoot: tmp, now: fixedDate() });
    const second = applyVerification(first.content, { projectRoot: tmp, now: fixedDate() });
    expect(second.content).toBe(first.content);
  });
});
