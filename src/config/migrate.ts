/**
 * ctx.yaml schema migration — the Setup-axis guarantee that a config
 * written by an older withctx still loads cleanly on a newer one.
 *
 * Every migration step is a pure function over the parsed-YAML object
 * (before zod validation). Steps are chained in `CURRENT_VERSION`
 * order, and the loader records whether any step fired so the CLI can
 * print a one-line "migrated 1.3 → 1.4" notice on the first load.
 *
 * Migrations are deliberately lossless and additive:
 *   - We never DELETE a user-supplied field during migration.
 *   - We rewrite legacy fields into their new home but leave the old
 *     ones in place, marked in the warning, so a rollback to the
 *     previous binary still works.
 *   - We never touch the file on disk — the loader writes the
 *     upgraded version back only when the user explicitly runs
 *     `ctx config --migrate`.
 */

export const CURRENT_VERSION = "1.4";

export interface MigrationResult {
  config: Record<string, unknown>;
  /** Version the config was at BEFORE migration. `null` if missing. */
  fromVersion: string | null;
  /** Version the config ended up at — always `CURRENT_VERSION`. */
  toVersion: string;
  /** Human-readable notes describing each migration step that fired. */
  notes: string[];
}

type MigrationStep = (
  config: Record<string, unknown>,
  notes: string[]
) => Record<string, unknown>;

// ── Individual migration steps ────────────────────────────────────────

/**
 * 1.3 → 1.4: `costs.model` and `costs.model_override` were the
 * original home for LLM model config. 1.4 moved them under `ai.model`
 * and `ai.models`. The old fields still work (the loader reads them
 * as a fallback), but new configs should use the `ai` block.
 *
 * This step copies any legacy values into `ai.*` without removing the
 * old ones — rollback-safe.
 */
const migrateCostsModelToAi: MigrationStep = (config, notes) => {
  const costs = config.costs as Record<string, unknown> | undefined;
  if (!costs) return config;

  const ai = (config.ai as Record<string, unknown> | undefined) ?? {};
  let touched = false;

  if (typeof costs.model === "string" && !ai.model) {
    ai.model = costs.model;
    touched = true;
  }
  if (costs.model_override && typeof costs.model_override === "object" && !ai.models) {
    ai.models = costs.model_override;
    touched = true;
  }

  if (touched) {
    config.ai = ai;
    notes.push(
      "Copied legacy `costs.model` / `costs.model_override` → `ai.model` / `ai.models`."
    );
  }
  return config;
};

// ── Orchestrator ──────────────────────────────────────────────────────
//
// Each migration step MUST only push a note when it actually
// changed something. Noisy "nothing to do" notes spam every test run
// and train users to ignore the migration channel entirely.

const STEPS_1_3_TO_1_4: MigrationStep[] = [
  migrateCostsModelToAi,
];

/**
 * Apply any pending migrations to a parsed-YAML config object. Safe
 * to call on a config that's already at `CURRENT_VERSION` — it's a
 * no-op.
 */
export function migrateConfig(
  raw: unknown
): MigrationResult {
  if (!raw || typeof raw !== "object") {
    return {
      config: (raw as Record<string, unknown>) ?? {},
      fromVersion: null,
      toVersion: CURRENT_VERSION,
      notes: [],
    };
  }

  const config = { ...(raw as Record<string, unknown>) };
  const fromVersionRaw = config.version;
  const fromVersion =
    typeof fromVersionRaw === "string" && fromVersionRaw.length > 0
      ? fromVersionRaw
      : null;

  const notes: string[] = [];

  // Anything without a version or < 1.4 runs the 1.4 migration chain.
  // When we add 1.5 we'll chain from here in order.
  if (fromVersion === null || fromVersion < "1.4") {
    let working = config;
    for (const step of STEPS_1_3_TO_1_4) {
      working = step(working, notes);
    }
    working.version = CURRENT_VERSION;
    return {
      config: working,
      fromVersion,
      toVersion: CURRENT_VERSION,
      notes,
    };
  }

  // Already current — still stamp the version to be sure.
  config.version = CURRENT_VERSION;
  return {
    config,
    fromVersion,
    toVersion: CURRENT_VERSION,
    notes: [],
  };
}
