# Chat

`ctx chat` starts an interactive conversation with your compiled wiki. Unlike `ctx query` (single question, single answer), chat maintains context across multiple turns so you can ask follow-up questions, drill into details, and explore topics.

## Starting a Chat

```bash
ctx chat
```

```
 withctx chat — acme-platform
 Wiki: 14 pages loaded
 Type /help for commands, /exit to quit

You: _
```

## Example Conversation

```
You: How is the API structured?

ctx: The API (api-service) is a Fastify application organized by domain.
     Each domain is a Fastify plugin registered in src/app.ts:

     - users (src/routes/users/) — registration, profiles, preferences
     - orders (src/routes/orders/) — order creation, status, history
     - payments (src/routes/payments/) — payment processing, refunds
     - products (src/routes/products/) — catalog, search, inventory

     Routes follow RESTful conventions. Each route file exports a
     Fastify plugin with route definitions, and handlers are in
     separate files in src/handlers/.

     Sources: repos/api-service.md, api/routes.md

You: What about error handling?

ctx: Errors use a centralized pattern. There's a base AppError class
     in src/errors/app-error.ts that all domain errors extend:

     - ValidationError (400) — input validation failures
     - AuthError (401) — authentication failures
     - ForbiddenError (403) — authorization failures
     - NotFoundError (404) — resource not found
     - ConflictError (409) — duplicate resources

     Handlers throw typed errors, and a global Fastify onError hook
     catches them, maps to HTTP status codes, and formats the response
     as { error: { code, message, details } }.

     This was established as a team convention in ACME-89.

     Sources: repos/api-service.md, api/error-handling.md,
              conventions/coding-standards.md

You: Was there any discussion about using middleware instead?

ctx: Yes. In the Teams architecture-decisions channel (November 2024),
     the team discussed middleware-based error handling vs. the current
     hook-based approach. The hook approach was chosen because Fastify's
     plugin encapsulation makes middleware ordering unpredictable across
     plugins. The onError hook runs after all plugins and provides a
     single consistent error format.

     Sources: architecture/overview.md (compiled from Teams thread)

You: /sources

Last response sources:
  - Teams: Engineering > architecture-decisions, Nov 2024 thread
  - Confluence: ENG/Error Handling Guidelines
  - Jira: ACME-89 "Standardize API error handling"

You: /exit
 Session ended.
```

## In-Session Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/exit` | End the chat session |
| `/save` | Save insights from the conversation to the wiki |
| `/sources` | Show detailed source references for the last response |
| `/scope <section>` | Narrow context to a specific wiki section |
| `/scope` | Reset scope to full wiki |
| `/pages` | List all wiki pages |
| `/clear` | Clear conversation history (start fresh) |

## Scoped Chat

Narrow the conversation to a specific area of the wiki:

```bash
# Start scoped
ctx chat --scope repos/api-service

# Or scope during chat
You: /scope architecture
 Scoped to: architecture/ (4 pages)

You: How do services communicate?

ctx: Services communicate via synchronous HTTP calls and asynchronous
     events. The API service calls auth-service directly for token
     validation. For order processing, it publishes events to an
     SQS queue that the payments service consumes.

     Sources: architecture/overview.md, architecture/infrastructure.md

You: /scope
 Scope reset to full wiki (14 pages)
```

## Saving Insights

When a conversation reveals something useful that should be captured in the wiki, use `/save`:

```
You: Are there any rate limits on the auth endpoints?

ctx: The wiki doesn't have specific rate limit information for auth
     endpoints. The architecture overview mentions "rate limiting" but
     doesn't specify the values.

You: We recently set it to 10 requests per second per IP for /auth/token
     and 3 per minute for /auth/register.

ctx: Good to know. That's not in any of the current sources.

You: /save

 What should be saved?
 [1] Rate limits: /auth/token = 10 req/s/IP, /auth/register = 3 req/min
 [2] Full conversation
 [3] Custom note

You: 1

 Saved to wiki as manual context (type: context, tags: auth, rate-limiting)
 Will be incorporated on next sync.
```

## Using External Context Repos

Chat against a context repo that is not in the current directory:

```bash
# Path to local clone
ctx chat --context ../acme-context

# Or a remote repo
ctx chat --context https://github.com/acme-corp/acme-context
```

## Tips

- Start broad, then use `/scope` to narrow down when you want focused answers.
- If the answer cites a source that seems wrong, use `/sources` to see the full reference and verify upstream.
- Use `/save` liberally. Conversations often surface tribal knowledge that should be in the wiki.
- The chat session does not persist between runs. If you need to save conversation context, use `/save` before `/exit`.
