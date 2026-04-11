#!/usr/bin/env bash
# End-to-end smoke test for the withctx trust pipeline.
#
# Exercises the full chain built in session 2:
#     approve → verify (pass) → verify (fail after deletion) →
#     verify (re-pass) → review --drift → teach --reveal → status
#
# Also asserts that the `ctx bless` hidden alias still routes to the
# same command so existing scripts don't break after the rename.
#
# Uses ZERO LLM credits. The wiki page is hand-authored so we don't need
# a live Claude call to seed content. Everything downstream of sync is
# deterministic and offline.
#
# Run from the withctx repo root:
#     bash scripts/smoke-trust-pipeline.sh
#
# Exit code is 0 on success, non-zero on first failing step.

set -euo pipefail

WITHCTX_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTX_BIN="node ${WITHCTX_ROOT}/dist/cli/index.js"

# Every step below touches this throwaway sandbox. It's cleaned up on exit
# so re-running the script leaves no residue.
TMP="$(mktemp -d -t withctx-smoke-XXXXXXXX)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. Build, if dist/ is missing or stale ─────────────────────────────
if [[ ! -f "${WITHCTX_ROOT}/dist/cli/index.js" ]]; then
  step "Building withctx (dist/ not found)"
  (cd "$WITHCTX_ROOT" && npm run build >/dev/null)
  ok "Build complete"
fi

# ── 1. Seed a throwaway project ────────────────────────────────────────
step "Seeding throwaway project at $TMP"
mkdir -p "$TMP/src/auth" "$TMP/src/routes" "$TMP/docs"
cat > "$TMP/src/auth/session.ts" <<'EOF'
// Minimal session handler used by the smoke test.
export function startSession() { return { id: "s1" }; }
EOF
cat > "$TMP/src/routes/index.ts" <<'EOF'
export function registerRoutes() { /* noop */ }
EOF
cat > "$TMP/README.md" <<'EOF'
# Demo project
Used by the withctx smoke test.
EOF
ok "Source tree created"

# ── 2. Scaffold .ctx/ without running Claude ───────────────────────────
# `ctx setup --demo` is the zero-cost scaffold path. It writes ctx.yaml
# and an empty wiki skeleton without calling the LLM.
step "Running ctx setup --demo"
(cd "$TMP" && $CTX_BIN setup --demo -y >/dev/null 2>&1) || fail "ctx setup --demo failed"
[[ -d "$TMP/.ctx/context" ]] || fail ".ctx/context/ was not created"
ok ".ctx/ scaffolded"

# ── 3. Hand-author a wiki page with assertions ─────────────────────────
# We skip `ctx sync` (which would need a real API key) and write the
# wiki page directly. This lets us exercise bless/verify/review/teach
# without any network calls.
step "Authoring architecture.md with assertions"
mkdir -p "$TMP/.ctx/context"
cat > "$TMP/.ctx/context/architecture.md" <<'EOF'
---
title: architecture
tier: manual
---

# Architecture

The session layer lives in `src/auth/session.ts` and the HTTP router is wired
from `src/routes/index.ts`. Both files must exist for the system to boot.

## Session management

Sessions are created via `startSession()` defined in `src/auth/session.ts`.
This is the single source of truth for auth state.

```ctx-assert
path-exists src/auth/session.ts
path-exists src/routes/index.ts
grep src/auth/session.ts "startSession"
```
EOF
ok "Wiki page written"

# ── 4. Approve the page — tier should promote manual → asserted ──────
step "ctx approve architecture.md"
(cd "$TMP" && $CTX_BIN approve architecture.md >/dev/null 2>&1) || fail "ctx approve failed"
grep -q "tier: asserted" "$TMP/.ctx/context/architecture.md" \
  || fail "Tier did not promote to 'asserted' after approve"
grep -q "blessed_by:" "$TMP/.ctx/context/architecture.md" \
  || fail "approval stamp missing (YAML field is still blessed_by — storage layer)"
ok "Tier promoted to 'asserted'"

# ── 4b. Legacy alias — `ctx bless` should still route to the same command ─
step "ctx bless alias round-trip"
(cd "$TMP" && $CTX_BIN approve architecture.md --revoke >/dev/null 2>&1) \
  || fail "ctx approve --revoke failed"
(cd "$TMP" && $CTX_BIN bless architecture.md >/dev/null 2>&1) \
  || fail "ctx bless (alias) failed — rename broke backward compatibility"
grep -q "tier: asserted" "$TMP/.ctx/context/architecture.md" \
  || fail "Tier did not promote via the bless alias"
ok "Legacy 'ctx bless' alias still works"

# ── 5. Verify — every assertion should pass, tier → verified ──────────
step "ctx verify architecture.md (all assertions pass)"
(cd "$TMP" && $CTX_BIN verify architecture.md) || fail "ctx verify failed on green state"
grep -q "tier: verified" "$TMP/.ctx/context/architecture.md" \
  || fail "Tier did not promote to 'verified' after all-pass verify"
ok "Tier promoted to 'verified'"

# ── 6. Verify --json — exercise the machine-readable path ──────────────
step "ctx verify --json architecture.md"
(cd "$TMP" && $CTX_BIN verify architecture.md --json 2>/dev/null) | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    const j = JSON.parse(data);
    if (!j.totals || typeof j.totals.passed !== 'number') {
      throw new Error('missing totals.passed');
    }
    if (typeof j.totals.failed !== 'number') {
      throw new Error('missing totals.failed');
    }
    if (!Array.isArray(j.results) || j.results.length === 0) {
      throw new Error('results not a non-empty array');
    }
    if (!Array.isArray(j.results[0].assertions)) {
      throw new Error('results[0].assertions not an array');
    }
  });
" || fail "verify --json shape check failed"
ok "--json output has the expected shape"

# ── 7. Break the tree → verify should fail and demote ──────────────────
step "Deleting src/auth/session.ts to force a failure"
rm "$TMP/src/auth/session.ts"
set +e
(cd "$TMP" && $CTX_BIN verify architecture.md >/dev/null 2>&1)
RC=$?
set -e
[[ $RC -ne 0 ]] || fail "verify should have exited non-zero after file deletion"
grep -q "tier: asserted" "$TMP/.ctx/context/architecture.md" \
  || fail "Tier did not demote back to 'asserted' after failure"
ok "Failure path: tier demoted to 'asserted', exit code non-zero"

# ── 8. Restore the file → verify should pass and re-promote ────────────
step "Restoring src/auth/session.ts"
cat > "$TMP/src/auth/session.ts" <<'EOF'
export function startSession() { return { id: "s1" }; }
EOF
(cd "$TMP" && $CTX_BIN verify architecture.md >/dev/null 2>&1) \
  || fail "verify failed after restore"
grep -q "tier: verified" "$TMP/.ctx/context/architecture.md" \
  || fail "Tier did not re-promote to 'verified' after restore"
ok "Recovery path: tier back to 'verified'"

# ── 9. Drift check via a synthetic diff ────────────────────────────────
# Build a diff that changes src/routes/index.ts and feed it to
# `ctx review --drift`. The page is verified and references the file, so
# drift classification should flag it and exit non-zero.
step "ctx review --drift (synthetic diff)"
cat > "$TMP/fake.diff" <<'EOF'
diff --git a/src/routes/index.ts b/src/routes/index.ts
index 0000001..0000002 100644
--- a/src/routes/index.ts
+++ b/src/routes/index.ts
@@ -1,1 +1,2 @@
 export function registerRoutes() { /* noop */ }
+export function registerHealthcheck() { /* new */ }
EOF
set +e
(cd "$TMP" && $CTX_BIN review ./fake.diff --drift >/dev/null 2>&1)
RC=$?
set -e
[[ $RC -ne 0 ]] || fail "review --drift should have exited non-zero for a drifted blessed page"
ok "Drift check correctly flagged the blessed page"

# ── 10. JSON drift path ────────────────────────────────────────────────
step "ctx review --drift --json"
DRIFT_JSON="$(cd "$TMP" && $CTX_BIN review ./fake.diff --drift --json 2>/dev/null || true)"
echo "$DRIFT_JSON" | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    const j = JSON.parse(data);
    if (!j.summary) throw new Error('missing summary');
    if (!Array.isArray(j.affected)) throw new Error('affected not an array');
    if (j.summary.drifted < 1) throw new Error('expected at least one drifted page');
  });
" || fail "drift --json shape check failed"
ok "Drift JSON has summary + affected array"

# ── 11. Teach in reveal mode (deterministic, no prompts) ───────────────
step "ctx teach architecture.md --reveal"
TEACH_OUT="$(cd "$TMP" && $CTX_BIN teach architecture.md --reveal --seed 1 2>/dev/null || true)"
echo "$TEACH_OUT" | grep -q "ctx teach --reveal" || fail "teach output missing header"
echo "$TEACH_OUT" | grep -q "architecture.md" || fail "teach did not cite source page"
ok "Teach generated at least one question"

# ── 12. Status — the final smoke ───────────────────────────────────────
step "ctx status"
(cd "$TMP" && $CTX_BIN status >/dev/null 2>&1) || fail "ctx status crashed"
ok "ctx status runs clean"

printf '\n\033[1;32mAll smoke-test steps passed.\033[0m\n'
printf '\033[2m(sandbox at %s — removed on exit)\033[0m\n' "$TMP"
