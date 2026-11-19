# MCP connector proposal format

Call `creator_propose` with `kind: "connector"` and these fields:

- `scope`: `"project"` or `"global"`
- `kind`: `"connector"`
- `name`: lowercase letters, digits, hyphens (`^[a-z0-9][a-z0-9-]{0,39}$`, max 40 chars, never `"cubiq"`)
- `spec`: one of `"stdio"`, `"http"`, or `"sse"`

Maximum serialized `spec` size is 64 KiB.

## Local `stdio` connector

```json
{
  "scope": "global",
  "kind": "connector",
  "name": "postgres-readonly",
  "spec": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-postgres"],
    "env": {
      "DATABASE_URL": "${DATABASE_URL}"
    }
  }
}
```

- `command`: non-empty single-line string (never NUL-containing).
- `args`: optional array of strings.
- `env`: optional string map (`KEY` matches `^[A-Za-z_][A-Za-z0-9_]*$`). Every value must be empty `""` or ONLY `${UPPER_SNAKE_CASE}` placeholders (for example `"${DATABASE_URL}"`).

## Remote `http` / `sse` connector

```json
{
  "scope": "project",
  "kind": "connector",
  "name": "linear",
  "spec": {
    "type": "http",
    "url": "https://mcp.linear.app/mcp",
    "headers": {
      "Authorization": "Bearer ${LINEAR_API_KEY}"
    }
  }
}
```

- `url`: valid `https://` URL, or `http://` only for `localhost` or `127.0.0.1` (no `user:pass@` credentials in URL).
- `headers`: optional string map where every value is empty `""`, only `${UPPER_SNAKE_CASE}` placeholders, or one auth scheme then one placeholder: `"Bearer ${GITHUB_TOKEN}"`, `"Token ${X}"`, `"Basic ${X}"`. Never a literal token.
- `oauth`: optional `{ clientId?: string, scopes?: string, callbackPort?: number }`.

## Secret handling

Never place literal tokens, passwords, or keys anywhere in `env`, `headers`, `args`, or `url`. Use `${UPPER_SNAKE_CASE}` placeholders in `env` or `headers`.
