# Sosie

**Your AI agent sees a double of your data. Never the real thing.**

Sosie sits between your data and your AI agent. The agent, your app and its
tools query it as they would the real thing, and every value comes back as a
realistic fake. The same real value is always the same fake, so joins hold and
code written against the fakes runs unchanged on the real data. Real records,
credentials and hostnames stay on your side.

> *Sosie* is French for a lookalike, after the servant in Molière's
> *Amphitryon* whose exact double the god Mercury becomes.

## Status

Sosie works end to end in front of PostgreSQL 15 to 18, REST APIs and GraphQL
APIs, on Node 26 and 24. It is not published yet. The [MVP](docs/mvp.md), the [high-level design](docs/hld.md)
and the [low-level design](docs/lld.md) say what it does and how.

## How it works

In your own terminal, not the agent's:

```sh
export SOSIE_UPSTREAM='postgres://readonly:…@db.internal:5432/app'
npx @sosie/cli
```

```
  ✓ db.internal:5432/app, read-only: 42 tables, 3 views
  ✓ Every value is faked; 3 fields pass (sosie.yml)

  Your agent, app and psql:  postgres://localhost:7674/app
  Claude Code:               claude mcp add sosie -- npx @sosie/cli mcp
```

Without `SOSIE_UPSTREAM`, Sosie asks for the connection string at a hidden
prompt. It is never an argument: arguments show in shell history and the
process list, where an agent can read them.

Then point the agent, the app and its tests at the address Sosie printed:

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  749.20
 Janick Dach      | paid      |    3.38
 Cristian Kuhlman | shipped   | 8274.94
```

Every value is a fake of the real one, of the same type and format. The same
real value is always the same fake, so joins hold, and a value the agent saw
finds its row again: `WHERE email = 'van29@example.com'` reads the real row
behind that fake. Writes are refused.

When it matters, check that nothing real reached a transcript:

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✓ No real values found in 412 files.
```

That is the whole tool: three commands, no config to start, and an optional
`sosie.yml` for the fields you decide may pass unchanged:

```yaml
pass:
  - orders.status
  - countries.*
format:
  users.handle: username
```

Installed once with `npm i -g @sosie/cli`, the command is just `sosie`.
Options: `--port` (7674, or the next free one), `--host` (127.0.0.1), `--rules`
(`./sosie.yml`) and `--max-rows` (1000). Several Sosies, one per upstream, share
one store, so a person is the same fake in each, and `sosie mcp` serves them
all.

Tested with `psql`, `node-postgres`, `postgres.js`, Drizzle and Prisma.

### In front of your API

The same, for your team's own REST API: the agent reads it through Sosie, and a
person is the same fake from the API as from the database.

```sh
export SOSIE_UPSTREAM='https://api.internal/v1'
export SOSIE_UPSTREAM_HEADERS="$(cat ~/.config/api.headers)"   # Authorization: Bearer …
npx @sosie/cli
```

```
  ✓ api.internal/v1, read-only: OpenAPI 3.1, 24 schemas, 41 GET paths
  ✓ Every value is faked

  Your agent, app and curl:  http://localhost:7675/v1
```

Only `GET` and `HEAD` reach the API, with Sosie's credentials, never the
agent's; read them from a file or a secret manager, as above, so they stay out
of your shell's history. Sosie reads the API's OpenAPI document when it serves one, or the one
in `SOSIE_OPENAPI`; without one, it names each value by where it sits. Links in
the API's answers point at Sosie with every value in them faked, and following
one reads the record it names; a word that looks like the API's own, a
collection's name or a lowercase query name, stays as written.

A GraphQL API works the same way: point `SOSIE_UPSTREAM` at its endpoint
(`https://api.internal/graphql`). Sosie reads the schema by introspection, or
from `SOSIE_GRAPHQL_SCHEMA`, answers the client's introspection from it, and
sends only queries on, never mutations.

Postgres, REST and GraphQL are the first sources. More databases come next, each
a package behind the same interface.

## Good to know

- **Order and ranges follow the real values.** `ORDER BY id` sorts by the
  real ids, so the fakes come back out of order; `WHERE total > 100`
  compares real totals.
- **Values a query computes are faked by type.** `length(email)` or
  `max(id)` are not the length or maximum of the fakes. `count(…)` passes
  unchanged.
- **Partial matches do not find fakes.** `LIKE '%van%'` filters the real
  values, so a piece of a fake finds nothing.
- **Results are text.** Drivers that ask for binary results get an error that
  says so.

## What Sosie is not

- **Not a service.** It runs on your machine, or on a host you choose. Your
  data never goes to anyone, us included.
- **Not a writer.** It never changes your database.
- **Not a wall against an agent hunting for secrets** on the machine Sosie runs
  on. For that, run Sosie on another host and give the agent only its address.
  See the [threat model](docs/hld.md#threat-model).

## Develop

```sh
npm install
npm run check   # typecheck, build, and every test
```

The end-to-end tests start an embedded PostgreSQL 18. To run them against
another server, set `SOSIE_TEST_DATABASE_URL` to a superuser connection
string; the tests create their own database and role, and drop them after.
The `psql` tests run when `psql` is on the PATH, or at `PSQL`.

## License

MIT
