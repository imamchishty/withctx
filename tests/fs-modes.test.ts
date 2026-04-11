import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readSecretFile, writeSecretFile } from "../src/security/fs-modes.js";

const isPosix = process.platform !== "win32";

describe("writeSecretFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `withctx-fs-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a file with mode 0600 on POSIX", () => {
    const p = join(tempDir, "secret.yaml");
    writeSecretFile(p, "api_key: sk-ant-fake\n");
    if (isPosix) {
      const mode = statSync(p).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("tightens an existing world-readable file to 0600", () => {
    if (!isPosix) return;
    const p = join(tempDir, "existing.yaml");
    writeFileSync(p, "old: content\n");
    chmodSync(p, 0o644);
    expect(statSync(p).mode & 0o777).toBe(0o644);

    writeSecretFile(p, "new: content\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("readSecretFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `withctx-fs-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads a single-line token and trims the newline", () => {
    const p = join(tempDir, "token");
    writeSecretFile(p, "ghp_fake_token_12345\n");
    expect(readSecretFile(p)).toBe("ghp_fake_token_12345");
  });

  it("throws on missing file", () => {
    expect(() => readSecretFile(join(tempDir, "nope"))).toThrow(
      /Token file not found/
    );
  });

  it("throws on empty file", () => {
    const p = join(tempDir, "empty");
    writeSecretFile(p, "");
    expect(() => readSecretFile(p)).toThrow(/empty/);
  });

  it("throws on whitespace-only file", () => {
    const p = join(tempDir, "blank");
    writeSecretFile(p, "   \n\n  \n");
    expect(() => readSecretFile(p)).toThrow(/empty/);
  });

  it("rejects a world-readable token file on POSIX", () => {
    if (!isPosix) return;
    const p = join(tempDir, "leaky");
    writeFileSync(p, "ghp_leaky_token\n");
    chmodSync(p, 0o644);
    expect(() => readSecretFile(p)).toThrow(/permissions 644.*chmod 600/);
  });

  it("rejects a group-readable token file on POSIX", () => {
    if (!isPosix) return;
    const p = join(tempDir, "group-leaky");
    writeFileSync(p, "ghp_leaky_token\n");
    chmodSync(p, 0o640);
    expect(() => readSecretFile(p)).toThrow(/permissions 640.*chmod 600/);
  });

  it("accepts a 0400 (owner-read-only) file", () => {
    if (!isPosix) return;
    const p = join(tempDir, "readonly");
    writeFileSync(p, "ghp_readonly_token\n");
    chmodSync(p, 0o400);
    expect(readSecretFile(p)).toBe("ghp_readonly_token");
  });

  it("returns only the first non-blank line if the file is multi-line", () => {
    const p = join(tempDir, "multi");
    // A user accidentally piped an entire env file into --token-file.
    // We should return only the first real line, not the whole blob.
    writeSecretFile(p, "\nghp_first_line\nextra_noise\nmore_noise\n");
    expect(readSecretFile(p)).toBe("ghp_first_line");
  });

  it("strips trailing whitespace on the token line", () => {
    const p = join(tempDir, "padded");
    writeSecretFile(p, "ghp_padded_token   \t\n");
    expect(readSecretFile(p)).toBe("ghp_padded_token");
  });
});
