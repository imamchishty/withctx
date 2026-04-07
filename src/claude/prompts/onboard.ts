import type { WikiPage } from "../../types/page.js";

/**
 * Format a prompt for generating onboarding pages from existing wiki content.
 * Creates start-here, local-setup, and first-pr guides.
 */
export function formatOnboardingPrompt(
  pages: WikiPage[],
  repoName?: string
): string {
  const scope = repoName
    ? `the "${repoName}" repository`
    : "this project/organization";

  const pageContents = pages
    .map((p) => `--- ${p.path} ---\n${p.content}`)
    .join("\n\n");

  const outputBase = repoName
    ? `onboarding/by-repo/${repoName}`
    : "onboarding";

  return `Generate onboarding documentation for ${scope} based on the existing wiki pages below.

Create the following pages:

=== PAGE: ${outputBase}/start-here.md ===
A "Start Here" guide for new developers joining the project. Include:
- What this project/repo does (one paragraph)
- Key architecture decisions and why they were made
- Team structure and who to ask for help (if people pages exist)
- Important links (repos, services, dashboards)
- Glossary of project-specific terms

=== PAGE: ${outputBase}/local-setup.md ===
Step-by-step local development setup guide. Include:
- Prerequisites (languages, tools, accounts needed)
- Clone and install instructions
- Environment variables and configuration
- How to run the project locally
- How to run tests
- Common setup issues and their fixes

=== PAGE: ${outputBase}/first-pr.md ===
Guide for submitting your first pull request. Include:
- Branch naming conventions
- Code style and linting rules
- Testing requirements
- PR template / what to include in PR description
- Review process and who reviews what
- CI/CD pipeline overview

Only include information that can be derived from the wiki pages below. If information for a section is not available, write "TODO: Document <topic>" as a placeholder rather than inventing details.

Cross-reference existing wiki pages where relevant using relative links.

--- Wiki Pages (${pages.length} total) ---
${pageContents}`;
}
