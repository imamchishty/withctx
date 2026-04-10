import type { WikiPage, LintIssue } from "../../types/page.js";
import type { LLMProvider } from "../../llm/types.js";

/**
 * Detects contradictions between pairs of wiki pages using the configured LLM.
 */
export async function detectContradictions(
  pages: WikiPage[],
  claude: LLMProvider
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // Generate pairs to compare — skip trivially short pages
  const meaningful = pages.filter((p) => p.content.length > 100);
  const pairs: Array<[WikiPage, WikiPage]> = [];

  for (let i = 0; i < meaningful.length; i++) {
    for (let j = i + 1; j < meaningful.length; j++) {
      pairs.push([meaningful[i], meaningful[j]]);
    }
  }

  // Cap pairs to avoid excessive LLM calls
  const maxPairs = 50;
  const selected = pairs.slice(0, maxPairs);

  for (const [a, b] of selected) {
    try {
      const response = await claude.prompt(
        `You are a technical documentation auditor. Compare these two wiki pages and identify any contradictions — places where they make conflicting claims about the same topic.

Page 1 (${a.path}):
${a.content.slice(0, 3000)}

Page 2 (${b.path}):
${b.content.slice(0, 3000)}

Respond ONLY in this JSON format (no markdown fences):
{"contradictions": [{"description": "...", "suggestion": "..."}]}

If there are no contradictions, return: {"contradictions": []}`,
        { maxTokens: 1024 }
      );

      const parsed = parseContradictionResponse(response.content);

      for (const c of parsed) {
        issues.push({
          type: "contradiction",
          severity: "error",
          page: a.path,
          relatedPage: b.path,
          message: c.description,
          suggestion: c.suggestion,
        });
      }
    } catch {
      // Skip pairs that fail — don't block the entire lint
    }
  }

  return issues;
}

interface ContradictionEntry {
  description: string;
  suggestion?: string;
}

function parseContradictionResponse(raw: string): ContradictionEntry[] {
  try {
    // Strip markdown fences if present
    const cleaned = raw
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const data = JSON.parse(cleaned);
    if (Array.isArray(data.contradictions)) {
      return data.contradictions;
    }
    return [];
  } catch {
    return [];
  }
}
