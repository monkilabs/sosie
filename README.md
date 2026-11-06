<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/sosie-logo-white.svg">
    <img alt="Sosie" src="assets/sosie-logo-black.svg" height="56">
  </picture>
</h1>

**Your AI agent sees a double of your data. Never the real thing.**

Sosie sits between your data and your AI agent. The agent, your app and its
tools query it as they would the real thing, and every value comes back as a
realistic fake. The same real value is always the same fake, so joins hold and
code written against the fakes runs unchanged on the real data. Real records,
credentials and hostnames stay on your side.

> *Sosie* is French for a lookalike, after the servant in Molière's
> *Amphitryon* whose exact double the god Mercury becomes.

**[Docs and the full story: monkilabs.github.io/sosie](https://monkilabs.github.io/sosie/)**

## Status

Sosie 0.4.0 is on npm as [`@sosie/cli`](https://www.npmjs.com/package/@sosie/cli). It works end to end in front of
PostgreSQL 15 to 18, MySQL 8.4 and 9, MongoDB 6.0 to 8.0, REST APIs and GraphQL APIs, on Node 26 and 24. The [MVP](docs/mvp.md), the
[high-level design](docs/hld.md) and the [low-level design](docs/lld.md) say what it does and how.

## How it works

In your project's folder, in your own terminal, not the agent's:

```sh
npx @sosie/cli
```

The first time, Sosie asks for your first source's connection string at a hidden prompt, and writes a `sosie.yml`
that names the variable to keep it in, never the string itself:

```
  No sosie.yml here yet: one, with the first database or API Sosie reads.

  Its connection string, or the API's URL (hidden):
  ✓ A Postgres database: db.internal:5432/app
  A name for it (app):
  The variable to keep it in (APP_URL):
  ✓ Wrote sosie.yml: app, its upstream read from ${APP_URL}, never written there. Commit it.
    Set APP_URL in your terminal, and Sosie starts without asking for it.

  ✓ app  db.internal:5432/app, read-only: 42 tables, 3 views
  ✓ Every value is faked

  app:                       postgres://localhost:7674/app
  Claude Code:               claude plugin marketplace add monkilabs/sosie
                             claude plugin install sosie@sosie
  Any MCP client:            npx @sosie/cli mcp
```

The connection string is never an argument: arguments show in shell history and the process list, where an agent can
read them. Next time, set `APP_URL` in your terminal, or type it at the prompt again.

Then point the agent, the app and its tests at the address Sosie printed:

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  512.87
 Janick Dach      | paid      |    7.06
 Cristian Kuhlman | shipped   | 3916.25
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

### One file: sosie.yml

That is the whole tool: three commands, and one file. `sosie.yml` names every source of the project, databases and
APIs, and the fields you decide may pass unchanged. One Sosie serves them all, each at an address of
its own, from 7674 up; a person is the same fake in each, and `sosie mcp` serves them all.

```yaml
pass:
  - orders.status
  - countries.*

sources:
  app:
    upstream: ${APP_URL}
  billing:
    upstream: ${BILLING_API_URL}
    headers:
      Authorization: Bearer ${BILLING_TOKEN}
  catalog:
    upstream: ${CATALOG_URL}     # https://api.internal/graphql
```

A connection string or a token is never written in it: each `${NAME}` is read from the terminal Sosie starts in, or
asked for at a hidden prompt. The first time a source is to send one, a token in a header, Sosie says where and asks,
so an edit an agent makes cannot send one elsewhere unasked. It is all there is to configure: there are no flags, and no variable of Sosie's own but
`SOSIE_HOME`, where its store is.
Installed once with `npm i -g @sosie/cli`, the command is just `sosie`.
[Configuration](https://monkilabs.github.io/sosie/docs/configuration/) has every key.

Tested with `psql`, `node-postgres`, `postgres.js`, Drizzle and Prisma; in
binary, checked by hand with asyncpg and pgJDBC.

### In front of your API

The same, for your team's own REST API: the agent reads it through Sosie, and a
person is the same fake from the API as from the database. Only `GET` and `HEAD`
reach the API, with Sosie's credentials from the source's `headers`, never the
agent's. Sosie reads the API's OpenAPI document when it serves one, or the one the
source's `schema` names; without one, it names each value by where it sits. Links in
the API's answers point at Sosie with every value in them faked, and following
one reads the record it names; a word that is the API's own, a collection's
name or a query name its document or its answers show, stays as written.

A GraphQL API works the same way, at its endpoint (`https://api.internal/graphql`, or Supabase's `/graphql/v1`; one
at another path with `kind: graphql`). Sosie reads the schema by introspection, or from the source's `schema`, answers
the client's introspection from it, and sends only queries on, never mutations. A query field that writes, like a
`GET` that writes, is the API's to guard.

### In front of MySQL

A source with a `mysql://` connection string. The `mysql` client and your app read through it: statements as text,
several to a query, and prepared, as mysql2's `execute()` and the `mariadb` driver send them. MySQL 8.4 and 9 are
tested. Give the login `SELECT` and `SHOW VIEW`, so a view's columns share their tables' fakes.

### In front of MongoDB

A source with a `mongodb://` or `mongodb+srv://` connection string. The Node.js driver (Mongoose's), mongosh and your
app read through it. MongoDB says nothing of where a value came from, so Sosie reads it from the command: each value of
a `find` or a pipeline is faked by the collection field it comes from, or by its BSON type when a stage computed it.
Every ObjectId shares one domain, so references between collections hold. MongoDB 6.0, 7.0 and 8.0 are tested. Give
the login the `read` role.

Postgres, MySQL, MongoDB, REST and GraphQL are the first sources. SQL Server comes
next, each a package behind the same interface ([how Sosie grows](docs/hld.md#how-sosie-grows)).

### In your assistant

Sosie is also a plugin for Claude Code, GitHub Copilot, VS Code, Cursor, Codex,
Kiro and Devin: its MCP server, and a skill that tells the agent how to read
through Sosie, what the fakes mean and why a result can look wrong.

```sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
```

Copilot and Codex add the same marketplace (`copilot plugin marketplace add
monkilabs/sosie`, `codex plugin marketplace add monkilabs/sosie`); Cursor
imports it under Dashboard → Plugins → Team Marketplaces. With `--scope project`
on both commands, Claude Code records them in the repository's
`.claude/settings.json`, for the whole team.

In Claude Code, Copilot CLI and VS Code the plugin does two more things. When a
session starts, it tells the agent which Sosies are running, or, in a project
with a `sosie.yml` and none running, to ask you to start one. When a session
ends, or in VS Code after each turn, it scans the session's transcript, and the
next session tells you if a real value reached it.

The plugin starts no Sosie and holds no credentials: Sosie still starts in your
own terminal, in the project's folder, as above.

## Good to know

- **Order and ranges follow the real values.** `ORDER BY id` sorts by the
  real ids, so the fakes come back out of order; `WHERE total > 100`
  compares real totals.
- **Values a query computes are faked by type.** `length(email)` or
  `max(id)` are not the length or maximum of the fakes. `count(…)` passes
  unchanged.
- **Partial matches do not find fakes.** `LIKE '%van%'` filters the real
  values, so a piece of a fake finds nothing.
- **Binary results,** as asyncpg, pgx and JDBC ask for them, are the fakes
  written as Postgres would send them. A type Sosie cannot write that way
  (`regclass`, `money`, composites, ranges) is refused in binary, with an error that
  names it.

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

The end-to-end tests start an embedded PostgreSQL 18, and MySQL 8.4 and MongoDB
8 from their own binaries, downloaded on the first run. To run them against
other servers, set `SOSIE_TEST_DATABASE_URL`, `SOSIE_TEST_MYSQL_URL` and
`SOSIE_TEST_MONGODB_URL` to a superuser's or root's connection string; the tests
create their own database and login, and drop them after.
The `psql` tests run when `psql` is on the PATH, or at `PSQL`.

## License

MIT
