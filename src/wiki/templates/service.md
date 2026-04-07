# {{serviceName}}

_Type: {{serviceType}} | Owner: {{owner}} | Status: {{status}}_

## Overview

{{description}}

## Tech Stack

| Component | Technology |
|-----------|-----------|
{{#techStack}}
| {{component}} | {{technology}} |
{{/techStack}}

## Architecture

{{architecture}}

## API Endpoints

{{#endpoints}}
### `{{method}} {{path}}`

{{description}}

**Request:**
```{{requestFormat}}
{{requestExample}}
```

**Response:**
```{{responseFormat}}
{{responseExample}}
```

{{/endpoints}}

## Dependencies

### Upstream (this service depends on)

{{#upstreamDeps}}
- [{{name}}]({{link}}) — {{reason}}
{{/upstreamDeps}}

### Downstream (depends on this service)

{{#downstreamDeps}}
- [{{name}}]({{link}}) — {{reason}}
{{/downstreamDeps}}

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
{{#config}}
| `{{name}}` | {{description}} | `{{default}}` |
{{/config}}

## Monitoring & Health

- **Health check:** `{{healthCheckUrl}}`
- **Dashboard:** {{dashboardUrl}}
- **Alerts:** {{alertsConfig}}

## Deployment

- **Environment:** {{environment}}
- **Deploy method:** {{deployMethod}}
- **Rollback:** {{rollbackProcedure}}

## Known Issues

{{#knownIssues}}
- **{{title}}** — {{description}}
{{/knownIssues}}

---

_Source: {{source}}_
_Last compiled: {{compiledAt}}_
