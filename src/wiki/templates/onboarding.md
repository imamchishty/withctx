# {{title}}

_Scope: {{scope}} | Last updated: {{updatedAt}}_

## Welcome

{{welcomeMessage}}

## What We Build

{{projectOverview}}

## Architecture at a Glance

{{architectureOverview}}

## Team & Contacts

| Role | Name | Reach out for |
|------|------|---------------|
{{#team}}
| {{role}} | {{name}} | {{responsibility}} |
{{/team}}

## Local Setup

### Prerequisites

{{#prerequisites}}
- [ ] {{item}} — {{instructions}}
{{/prerequisites}}

### Clone & Install

```bash
{{cloneInstructions}}
```

### Environment Setup

```bash
{{envSetup}}
```

### Run Locally

```bash
{{runCommand}}
```

### Verify It Works

```bash
{{verifyCommand}}
```

## Key Concepts & Glossary

| Term | Definition |
|------|-----------|
{{#glossary}}
| **{{term}}** | {{definition}} |
{{/glossary}}

## Your First PR

1. {{#firstPrSteps}}{{.}}
{{/firstPrSteps}}

### Branch Naming

{{branchNaming}}

### Code Style

{{codeStyle}}

### Testing Requirements

{{testingRequirements}}

### PR Checklist

{{#prChecklist}}
- [ ] {{.}}
{{/prChecklist}}

## Important Links

{{#links}}
- [{{label}}]({{url}}) — {{description}}
{{/links}}

## Common Issues & Fixes

{{#commonIssues}}
### {{problem}}

**Fix:** {{solution}}

{{/commonIssues}}

## Next Steps

{{#nextSteps}}
1. {{.}}
{{/nextSteps}}

---

_Source: {{source}}_
_Generated: {{compiledAt}}_
