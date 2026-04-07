# {{repoName}}

_Repository: {{repoUrl}} | Language: {{primaryLanguage}} | Last active: {{lastActive}}_

## Purpose

{{purpose}}

## Tech Stack

{{#techStack}}
- **{{category}}:** {{items}}
{{/techStack}}

## Architecture

{{architecture}}

## Directory Structure

```
{{directoryTree}}
```

### Key Files

{{#keyFiles}}
- `{{path}}` — {{description}}
{{/keyFiles}}

## Key Components

{{#components}}
### {{name}}

{{description}}

{{/components}}

## Entry Points

{{#entryPoints}}
- `{{path}}` — {{description}}
{{/entryPoints}}

## API Surface

{{apiSurface}}

## Configuration

| File | Purpose |
|------|---------|
{{#configFiles}}
| `{{path}}` | {{purpose}} |
{{/configFiles}}

## Scripts & Commands

| Command | Description |
|---------|-------------|
{{#scripts}}
| `{{command}}` | {{description}} |
{{/scripts}}

## Dependencies

### Runtime

{{#runtimeDeps}}
- `{{name}}` ({{version}}) — {{reason}}
{{/runtimeDeps}}

### Development

{{#devDeps}}
- `{{name}}` ({{version}}) — {{reason}}
{{/devDeps}}

## Gotchas

{{#gotchas}}
- **{{title}}:** {{description}}
{{/gotchas}}

## Related Pages

{{#relatedPages}}
- [{{title}}]({{path}})
{{/relatedPages}}

---

_Source: {{source}}_
_Last compiled: {{compiledAt}}_
