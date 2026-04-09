# On-Premises Setup (Confluence & Jira Server/DC)

withctx works with Confluence Server, Confluence Data Center, Jira Server, and Jira Data Center — not just Atlassian Cloud. This guide covers the differences in authentication, network configuration, and common pitfalls when connecting to self-hosted instances.

## When to Use On-Prem Config

Use the on-prem configuration when your Confluence or Jira instance:

- Runs on an internal hostname (e.g., `https://confluence.internal.acme.com`)
- Uses Personal Access Tokens instead of Atlassian Cloud API tokens
- Sits behind a VPN or corporate firewall
- Has a self-signed or internal CA SSL certificate

If your team uses `*.atlassian.net` URLs, you are on Atlassian Cloud and should follow the standard setup in [05-sources.md](05-sources.md).

## Confluence Server / Data Center

### Authentication

Confluence Server and Data Center use **Personal Access Tokens (PAT)** with Bearer auth. Unlike Atlassian Cloud, you do not need an email address — just the token.

To create a PAT:

1. Log in to your Confluence instance
2. Go to your profile (top-right avatar) > **Personal Access Tokens**
3. Click **Create token**, give it a name, and set an expiry
4. Copy the token immediately — it will not be shown again

### Configuration

```yaml
# ctx.yaml — Confluence Server / Data Center
sources:
  - type: confluence
    name: eng-wiki
    config:
      base_url: https://confluence.internal.acme.com
      token: ${CONFLUENCE_TOKEN}
      space: ENG
```

```bash
# .env
CONFLUENCE_TOKEN=NjM2MjE4MDY2NzI5Onm...   # Your PAT
```

Note: there is no `email` field. When `email` is omitted, withctx uses Bearer authentication automatically. When `email` is present, it uses Basic auth (email + token), which is the Atlassian Cloud pattern.

### Multiple Spaces

```yaml
sources:
  - type: confluence
    name: all-docs
    config:
      base_url: https://confluence.internal.acme.com
      token: ${CONFLUENCE_TOKEN}
      space: [ENG, PLATFORM, DEVOPS]
```

---

## Jira Server / Data Center

### Authentication

Jira Server/DC supports two auth methods:

- **Bearer (PAT)** — recommended. Same process as Confluence: profile > Personal Access Tokens > Create.
- **Basic (email + token)** — works if your instance supports it. Provide both `email` and `token`.

### Configuration — Bearer Auth (PAT)

```yaml
# ctx.yaml — Jira Server with PAT
sources:
  - type: jira
    name: jira-server
    config:
      host: https://jira.internal.acme.com
      token: ${JIRA_TOKEN}
      projects:
        - key: ACME
        - key: INFRA
      jql: "status != Cancelled AND updated >= -90d"
```

```bash
# .env
JIRA_TOKEN=MDM2MjE4MDY2Nz...   # Your PAT
```

### Configuration — Basic Auth

```yaml
# ctx.yaml — Jira Server with Basic auth
sources:
  - type: jira
    name: jira-server
    config:
      host: https://jira.internal.acme.com
      email: you@acme.com
      token: ${JIRA_TOKEN}
      auth: basic
      projects:
        - key: ACME
```

```bash
# .env
JIRA_TOKEN=your-api-token-here
```

---

## Self-Signed SSL Certificates

If your Confluence or Jira instance uses a self-signed certificate or an internal CA, you will get errors like:

```
Error: unable to verify the first certificate
Error: self signed certificate in certificate chain
```

### Workaround

Set the `NODE_TLS_REJECT_UNAUTHORIZED` environment variable before running ctx:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 ctx sync
```

Or add it to your `.env`:

```bash
# .env
NODE_TLS_REJECT_UNAUTHORIZED=0
```

This disables TLS certificate verification for all HTTPS requests. Use it only for trusted internal servers — never in production environments talking to external services.

### Better Alternative

If your organization has an internal CA bundle, point Node.js at it:

```bash
NODE_EXTRA_CA_CERTS=/path/to/internal-ca-bundle.pem ctx sync
```

This verifies certificates using your internal CA without disabling TLS entirely.

---

## VPN and Firewall

withctx must be able to reach your Confluence and Jira instances over the network. If they sit behind a VPN or firewall:

- **Run `ctx` from a machine with network access.** This means your laptop while connected to VPN, a CI runner inside the corporate network, or a bastion host.
- **GitHub Actions won't work** unless you use a self-hosted runner inside your network or have a VPN tunnel configured in the workflow.
- **Test connectivity first:** `curl -I https://confluence.internal.acme.com` should return a response. If it times out, ctx will too.

---

## Proxy Support

If your network routes HTTPS traffic through a proxy, set the standard environment variable:

```bash
HTTPS_PROXY=http://proxy.acme.com:8080 ctx sync
```

Or add it to `.env`:

```bash
# .env
HTTPS_PROXY=http://proxy.acme.com:8080
```

This applies to all outbound HTTPS requests from ctx, including Confluence, Jira, and the Anthropic API.

---

## Mixed Setup: Cloud + On-Prem

You can mix cloud and on-prem sources in the same `ctx.yaml`. A common pattern is cloud Confluence with on-prem Jira (or vice versa):

```yaml
# ctx.yaml — Cloud Confluence + On-Prem Jira
project: acme-platform

sources:
  # Atlassian Cloud Confluence (email + token)
  - type: confluence
    name: cloud-wiki
    config:
      base_url: https://acme.atlassian.net/wiki
      email: you@acme.com
      token: ${CONFLUENCE_CLOUD_TOKEN}
      space: ENG

  # On-prem Jira Server (PAT, no email)
  - type: jira
    name: jira-dc
    config:
      host: https://jira.internal.acme.com
      token: ${JIRA_DC_TOKEN}
      projects:
        - key: ACME
        - key: INFRA
```

```bash
# .env
CONFLUENCE_CLOUD_TOKEN=ATATT3xFfGF0...
JIRA_DC_TOKEN=MDM2MjE4MDY2Nz...
```

Each source authenticates independently. Cloud sources use email + token (Basic auth). On-prem sources use token only (Bearer auth).

---

## Troubleshooting

### 401 Unauthorized

```
Error: Confluence auth failed: HTTP 401
```

- **Cloud:** Check that `email` and `token` are both set and correct. The token comes from [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
- **Server/DC:** Check that your PAT has not expired. Create a new one if needed.
- **Wrong auth method:** If you provide `email` for a Server instance that expects Bearer auth, it will fail. Remove the `email` field.

### ECONNREFUSED

```
Error: connect ECONNREFUSED 10.0.1.50:443
```

- The machine running ctx cannot reach the server. Check VPN connection, firewall rules, and that the hostname resolves correctly.
- Try: `curl -I https://confluence.internal.acme.com`

### Certificate Errors

```
Error: unable to verify the first certificate
Error: self signed certificate
```

- See the [Self-Signed SSL Certificates](#self-signed-ssl-certificates) section above.
- Quick fix: `NODE_TLS_REJECT_UNAUTHORIZED=0 ctx sync`
- Proper fix: `NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem ctx sync`

### ETIMEDOUT

```
Error: connect ETIMEDOUT
```

- Network timeout. Usually means the server is unreachable. Check VPN, proxy settings, and DNS resolution.
- If you are behind a proxy, set `HTTPS_PROXY`.

### 403 Forbidden

```
Error: HTTP 403 — Forbidden
```

- Your token is valid but lacks permission. In Confluence Server, ensure your user account has read access to the spaces you configured. In Jira Server, ensure you have browse access to the projects.
