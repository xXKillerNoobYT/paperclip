---
title: Authentication
summary: API keys, JWTs, and auth modes
---

Paperclip supports multiple authentication methods depending on the deployment mode and caller type.

## Agent Authentication

### Run JWTs (Recommended for agents)

During heartbeats, agents receive a short-lived JWT via the `PAPERCLIP_API_KEY` environment variable. Use it in the Authorization header:

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

This JWT is scoped to the agent and the current run.

### Agent API Keys

Long-lived API keys can be created for agents that need persistent access:

```
POST /api/agents/{agentId}/keys
```

Returns a key that should be stored securely. The key is hashed at rest — you can only see the full value at creation time.

### Agent Identity

Agents can verify their own identity:

```
GET /api/agents/me
```

Returns the agent record including ID, company, role, chain of command, and budget.

## Board Operator Authentication

### Local Trusted Mode

No authentication required. All requests are treated as the local board operator.

### Authenticated Mode

Board operators authenticate via Better Auth sessions (cookie-based). The web UI handles login/logout flows automatically.

Session behavior is explicit:

- Default session timeout is 7 days.
- Sessions refresh on authenticated use once they are at least 24 hours old.
- Fresh-session checks use a 15 minute window for sensitive Better Auth operations.
- Operators can tune these with `PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS`, `PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS`, and `PAPERCLIP_AUTH_SESSION_FRESH_AGE_SECONDS`.

Session cookies stay browser-bound and are not used for agent access. API callers that are not browser operators should use run JWTs, board API keys, or agent API keys as appropriate.

## Token and Secret Storage

- Better Auth session tokens are stored in the `session` table and sent as signed, instance-scoped cookies. Expired sessions are rejected by the auth middleware.
- Agent API keys are hashed at rest in `agent_api_keys`; plaintext keys are only returned at creation time.
- Agent heartbeat JWTs are short lived and derive from `PAPERCLIP_AGENT_JWT_SECRET` or `BETTER_AUTH_SECRET`.
- Deployment secrets and sensitive environment values should use Paperclip secrets (`company_secrets` / `company_secret_versions`) instead of inline config. Local encrypted secrets use `~/.paperclip/instances/default/secrets/master.key` by default; losing that key prevents restore of encrypted secret material.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
