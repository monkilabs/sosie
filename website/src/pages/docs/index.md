---
layout: ../../layouts/Docs.astro
title: Getting started
description: Start Sosie in front of your Postgres database or your API, connect your agent, and check that nothing real reached a transcript.
lead: From nothing installed to your agent's first faked query in under a minute, with no config file.
---

## What you need

- **Node 24 or 26.** `npx` comes with it.
- **An upstream:** a PostgreSQL 15 to 18 database, or your team's own REST or GraphQL API.
- **A read-only login** for it. Sosie's own session is read-only either way, but a login that cannot write is
  safer. [Postgres](./postgres/#a-read-only-login) shows one.

## 1. Start Sosie, in your own terminal

Run it in a terminal of yours, not the agent's: the connection string is for Sosie only.

```sh
export SOSIE_UPSTREAM='postgres://readonly:…@db.internal:5432/app'
npx @sosie/cli
```

```
  ✓ db.internal:5432/app, read-only: 42 tables, 3 views
  ✓ Every value is faked

  Your agent, app and psql:  postgres://localhost:7674/app
  Claude Code:               claude mcp add sosie -- npx @sosie/cli mcp
```

Without `SOSIE_UPSTREAM`, Sosie asks for the connection string at a hidden prompt. It is never an argument:
arguments show in shell history and the process list, where an agent can read them.

For an API, `SOSIE_UPSTREAM` is its address, and its credentials go in `SOSIE_UPSTREAM_HEADERS`, read from a file or a
secret manager so they stay out of your shell's history:

```sh
export SOSIE_UPSTREAM='https://api.internal/v1'
export SOSIE_UPSTREAM_HEADERS="$(cat ~/.config/api.headers)"   # Authorization: Bearer …
npx @sosie/cli
```

A URL with `graphql` in its path starts the [GraphQL source](./graphql/); any other `http(s)` URL, the
[REST source](./rest/).

## 2. Point your agent at it

Everything that speaks the upstream's protocol uses the address Sosie printed, unchanged: the agent, your app, its
tests, `psql`, `curl`, any Postgres MCP server.

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  749.20
 Janick Dach      | paid      |    3.38
 Cristian Kuhlman | shipped   | 8274.94
```

Agents that prefer MCP get Sosie's own server, which talks to the running Sosie and never to your database:

```sh
claude mcp add sosie -- npx @sosie/cli mcp
```

Other MCP clients take the same command in their configuration:

```json
{
  "mcpServers": {
    "sosie": { "command": "npx", "args": ["@sosie/cli", "mcp"] }
  }
}
```

[MCP and scan](./mcp-and-scan/) lists its tools.

## 3. Query by what you saw

Every value is a fake of the real one, of the same type and format. The same real value is always the same fake, so a
value the agent saw finds its row again:

```sql
SELECT * FROM users WHERE email = 'van29@example.com';
```

Sosie turns `van29@example.com` back into the real email before the query runs, and fakes the row that comes back. The
same goes for ids in API paths (`/users/87`) and GraphQL arguments (`user(id: "87")`).

## 4. Let through what must be real

If a fake breaks your app's logic, a status that must be a real one, list that field in `sosie.yml` next to your code:

```yaml
pass:
  - orders.status
```

Sosie reads `./sosie.yml` when it starts. [Configuration](./configuration/) has every rule.

## 5. Check the transcripts

When it matters, check that nothing real reached a transcript or a log:

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✓ No real values found in 412 files.
```

It exits 1 when it finds a real value, so CI can run it.

## Install it once

```sh
npm i -g @sosie/cli
```

Then the command is just `sosie`: `sosie`, `sosie mcp` and `sosie scan`.

## Good to know

- **Order and ranges follow the real values.** `ORDER BY id` sorts by the real ids, so the fakes come back out of
  order; `WHERE total > 100` compares real totals.
- **Values a query computes are faked by type.** `length(email)` or `max(id)` are not the length or maximum of the
  fakes. `count(…)` passes unchanged.
- **Partial matches do not find fakes.** `LIKE '%van%'` filters the real values, so a piece of a fake finds nothing.
- **Results are text.** Drivers that ask for binary results (asyncpg, pgx, JDBC after its prepare threshold) get an
  error that says so.
