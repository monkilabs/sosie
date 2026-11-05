# Changelog

## Unreleased

**One Sosie for every source of a project, all set up in `sosie.yml`.** This
changes how Sosie starts: see Upgrading, below.

- `sosie.yml` names every source of the project, two databases, a REST API, a
  GraphQL one, each by a name of the team's, with the same keys: `upstream`,
  and where needed `kind`, `schema`, `headers` and `port`. One Sosie serves
  them all, each at an address of its own, from 7674 up; every source connects
  before any serves, and one that cannot stops Sosie, named. Settings at the top
  (`pass`, `format`, `host`, `max-rows`, `timeout`) hold for every source, and
  a source may set its own: a rule at the top holds where its table exists.
- Credentials are never written in `sosie.yml`, nor arguments: each `${NAME}`
  the file names is read from the terminal Sosie starts in, or asked for at a
  hidden prompt. `upstream` is always one whole variable, so a file an agent can
  edit never sends a credential to a host it chose.
- `sosie init` writes `sosie.yml` with the first source, its connection string
  asked for at a hidden prompt; `sosie` without a `sosie.yml` runs it, then
  starts.
- MCP: `describe` lists each source by its name, and a tool takes a `source`
  by that name. With several of its kind, it asks for one rather than guess.
- The plugin's session start names each source, and its kind and address.

Upgrading: `SOSIE_UPSTREAM`, `SOSIE_UPSTREAM_HEADERS`, `SOSIE_OPENAPI`,
`SOSIE_GRAPHQL_SCHEMA` and the flags `--port`, `--host`, `--rules`,
`--max-rows` and `--timeout` are gone, each a key of `sosie.yml` now. A
`sosie.yml` of rules only gets its first source from `sosie init`, its rules
kept. With `SOSIE_UPSTREAM` still set, `upstream: ${SOSIE_UPSTREAM}` reads it;
Sosie says so when one of them is set, and a flag given says where it went.

- Postgres: a column of a domain over another domain, an enum or an array,
  and an enum array a query computes (`array_agg(role)`), are faked by their
  type; they came back `NULL`.
- Postgres: `interval` is faked as another duration in the same form, each
  number another of as many digits, so a computed one (`age(born_on)`) is
  faked too; it came back `NULL`.
- Postgres: ranges and multiranges (`tstzrange`, `int4range`,
  `datemultirange`) are faked bound by bound, as their subtype, and put back
  in order; they came back `NULL`. `describe` shows them as `range(…)`.
- Postgres: `bit` and `varbit` are faked as as many bits, in text and in
  binary; MySQL's `BIT` too, and a single bit, as Hibernate maps a boolean to
  `BIT(1)`, is a flag that flips as a boolean does. They came back `NULL`.
- `timeout` sets how long a statement, a command or a request may run
  upstream, from 1 to 3600 seconds; it was 30 s, with no way to change it.
- REST: a collection named in kebab case (`/line-items`) is learned as one in
  snake case is, so links show it as it is.
- GraphQL: a refusal says why. Sosie stopping is a `503` tagged
  `SOSIE_STOPPING`, a failure of graphql-js's own a `500`; only a query that
  asks too much is tagged `SOSIE_TOO_COSTLY`. An `operationName` that names
  no operation gets `Unknown operation named "…"`.
- MongoDB: a fake compared with a field in `$expr` (`$eq`, `$ne`, `$in`)
  turns back, as one in a filter does.
- (0.1) A command could hang after its work was done, `sosie scan` most of
  all, and with it the plugin's scans and CI: Node's `process.exit()` can wait
  for good on one of V8's own threads (nodejs/node#54918). Each command now
  ends by letting Node's event loop run dry, with its exit code.

## 0.3.0, 5 November 2026

MongoDB, a source of its own; MySQL's prepared statements, several statements to
a query, and its `query` tool; and the fixes a review of everything up to 0.2.0
found, seven of them leaks or a write in released code. All seven packages move
to 0.3.0 together; `@sosie/mongodb` is new, and `@sosie/cli` depends on it.

- MySQL: prepared statements, as mysql2's `execute()` and the `mariadb` driver
  send them (both tested), answered in MySQL's binary protocol. Each runs as
  text upstream, its parameters written in as literals, so it is checked,
  turned back and faked as a statement sent as text is; a fake in a parameter
  finds its row as one in a literal does.
- MySQL: several statements in one query, when the client turns them on. Each
  is checked before the first runs, and sent upstream on its own.
- MySQL: `sosie mcp`'s `query` tool reads a MySQL Sosie as it does a Postgres
  one.
- MySQL: a computed column's name no longer shows a real value. MySQL names
  such a column by its text as Sosie sent it, with the real value in it where
  Sosie turned back a fake (`email = 'real@…'`), a derived table's column in
  its `org_name` too; the name is now taken from the client's own text.
- MySQL: a `tinyint` is faked within its own range, not a `smallint`'s.
- MongoDB, a source of its own (`@sosie/mongodb`): `SOSIE_UPSTREAM=mongodb://…`
  or `mongodb+srv://…` starts a local MongoDB endpoint in front of MongoDB 6.0
  and later (6.0, 7.0 and 8.0 tested). The Node driver reads through it, as
  the tests do; mongosh was checked by hand.
  Commands are allowed by name: `find`, `aggregate`, `count`, `distinct` and the
  schema's; writes, `explain`, JavaScript on the server, stages that write or
  show other sessions, and the `admin`, `local` and `config` databases are
  refused. Each value is faked by the collection field it comes from, read from
  the find's projection or the pipeline stage by stage, or by its BSON type
  where a stage computed it, in its own BSON type; in what a stage computed, a
  key is faked too, unless the client wrote it. A fake compared by equality
  in a filter or a `$match` is turned back. A cursor is its client session's,
  as MongoDB's is. `sosie mcp` adds `find` and `aggregate`.
- The core: an `objectid` type. An ObjectId's fake is 24 hex digits with its
  time shifted, and every field that holds one shares one domain, so a
  reference to a document is the fake of its `_id`.

Fixes from a review of everything up to here. Those marked with a version were
in that release and the ones after it; upgrade.

- Postgres (0.1): `WITH users AS (SELECT * FROM users)` read the inner `users`
  as the CTE, not the table, so the statement read no table and a computed
  column (`users::text`) passed unfaked. A CTE's query now sees only the CTEs
  before it, and with `RECURSIVE` all of them, as Postgres reads it.
- MySQL (0.2.0): `sql_mode` set by number (`SET sql_mode = 1048576`) turned on
  `NO_BACKSLASH_ESCAPES` or `ANSI_QUOTES`, which the guard refused only by name,
  and a literal Sosie wrote could be ended early. `sql_mode` is now set only by
  name, to modes that leave how a statement is read alone.
- GraphQL (0.1): a mutation field asked for through an interface or union the
  mutation type belongs to (`{ operator { deleteUser(id: "1") } }`) was let
  through, and the API ran the write. It is refused now.
- REST (0.1): a fake sent under a paging name (`?limit=<a fake>`) was turned
  back for the API, which repeated the real value in its next link, and the
  link kept it as written. A link now keeps a paging value only when the
  request did not turn it back.
- Postgres (0.1): `pg_roles.rolconfig` and `pg_user.useconfig` showed the role
  settings `pg_db_role_setting` was refused for, secrets included. The two
  views are now read only by their other columns, each named, as psql's `\d`
  and `\du` read them; a `*` or a whole row of either is refused.
- Postgres (0.1): a setting Postgres reports when it changes
  (`application_name`, `search_path`) is relayed only when the client wrote
  that value, and faked otherwise; a function could set one from a row.
- Postgres (0.2.0): a binary array parameter's header is checked before the
  array is built; one that asked for two billion empty arrays ran Sosie out of
  memory.
- MySQL (0.2.0): `SHOW STATUS` is refused, as `SHOW VARIABLES` is: it named
  the server's socket, address and certificate files.
- Postgres (0.1) and MySQL (0.2.0): more settings, views and functions that say
  where the database is or who its clients are are refused (`ssl_crl_dir`,
  `log_directory`, `pg_config`, `pg_stat_ssl`; `@@innodb_doublewrite_dir`,
  `@@mysqlx_ssl_*`, the group replication addresses and more).
- MySQL (0.2.0): a fake compared with a derived table's or a CTE's column turns
  back in that column's field; a recursive CTE reads itself, not a table, so
  what it makes from nothing is not faked.
- REST and GraphQL (0.1): a page number of up to five digits under a paging
  name goes to the API as written, as a link shows it. A page faked in the body
  was turned back into another page, and a client that pages to the end could
  loop.
- REST (0.1): method overrides are read as frameworks read them
  (`?.method=DELETE`, `?_method[]=DELETE`, a value with spaces around it), and
  a path segment an API or a proxy could read as another path is refused (a
  NUL, `..;`, `%252e`, `;params`).
- GraphQL (0.1): a variable named `__proto__` is sent as the client's value; it
  set the copy's prototype and the query asked for everything.
- The core (0.1): JSON that starts with a byte order mark is read, not answered
  with 502.
- The plugin (0.2.0): a scan that finds thousands of real values reports them
  all (past about 7,500 it failed with `ENOBUFS`); a session's findings are told
  in its own project, not in whichever session starts next; and two turns that
  end together start one scan.
- The CLI (0.1): a `--rules` file that is not there is a usage error (exit 2)
  before Sosie connects. A MongoDB list of hosts without ports gets the
  one-host message too.
- The core (0.1.1): `entity.*` in `sosie.yml` holds for the fields a source
  learns later, as REST's without an OpenAPI document and MongoDB's are; it
  passed only those known at start, none for such a source.
- Postgres (0.1) and MySQL (0.2.0): a large message is joined once its chunks
  have all come, not copied with each one.
- MySQL: an execution whose parameter length is cut short gets MySQL's
  `Incorrect arguments`, not a dropped connection.

## 0.2.0, 5 November 2026

MySQL, a source of its own; Postgres in binary, as asyncpg and pgx read it;
and the plugin's hooks in Copilot CLI and VS Code. All six packages move to
0.2.0 together; `@sosie/mysql` is new, and `@sosie/cli` depends on it.

- The plugin's hooks run in Copilot CLI and VS Code as well as Claude Code:
  each session starts knowing which Sosies run, and its transcript is scanned
  when it ends, or in VS Code after each turn. Each finding is reported once,
  and a scan that fails keeps what earlier scans found and says so beside it.
- Postgres: binary results and parameters, as asyncpg and pgx always use them
  and JDBC once it prepares a statement. Sosie still reads and fakes text, and
  writes each fake as Postgres would send it, byte for byte; a fake sent back
  in binary turns back like one sent as text. A type it cannot write from its
  text (`regclass`, composites, ranges) is refused in binary, naming the column.
- Postgres: `set_config` with its value written in the query is checked like
  `SET`, and one given as a parameter may set any setting but those Sosie
  checks, as asyncpg does before it reads the catalog. A value from a row is
  still refused.
- MySQL, a source of its own (`@sosie/mysql`): `SOSIE_UPSTREAM=mysql://…`
  starts a local MySQL endpoint in front of MySQL 8.0 and later (8.4 and 9
  tested). The `mysql` client and mysql2's `query()` read through it, every
  value faked by the column MySQL names, or by its type where it names none (a
  `UNION`'s, anything computed), fakes in literals turned back; writes,
  `mysql`, `performance_schema`, `LOAD_FILE()`, the server's settings and
  settings that say where the database is are refused. Any statement is stopped
  at the time limit, a `SELECT` or not. Prepared statements come later.

## 0.1.1, 4 November 2026

Sosie as a plugin for the agent's assistant, and the fixes a review of 0.1.0
against its design found. All five packages move to 0.1.1 together;
`@sosie/postgres` is unchanged.

- REST: a method override in the query is refused when its method is a fake
  Sosie gave, as when a link that carried one is followed as given: Sosie
  turned the fake back into the method, and sent it on.
- A plugin, in `plugins/sosie`, for Claude Code, GitHub Copilot, VS Code,
  Cursor, Codex, Kiro and Devin: Sosie's MCP server, and a skill that tells the
  agent how to read through Sosie. The repository is its marketplace:
  `claude plugin marketplace add monkilabs/sosie`.
- In Claude Code, the plugin tells the agent which Sosies are running when a
  session starts, and scans each session's transcript when it ends, its
  subagents' transcripts and long tool results included; the next session
  reports a real value it found.
- `sosie` suggests the plugin for Claude Code when it starts, and
  `npx @sosie/cli mcp` for any other MCP client.
- REST without an OpenAPI document: `describe` lists the fields Sosie has met,
  under each collection the API answered with a list.
- REST: a link whose query name Sosie faked into another word (`?jdoe=` as
  `?zleu=`) leads back to the API's own name when followed.
- GraphQL: a 64-bit id written as a variable's default goes with its digits as
  written, turned back, rather than rounded.
- `--port` above 65535 is a usage error, before Sosie connects; and
  `sosie mcp` serves with a flag before the command too (`sosie --rules x mcp`).

## 0.1.0, 29 October 2026

The first release: an AI agent works against a real Postgres database and the
team's own REST and GraphQL APIs, and the model never sees a real value.

- `npx @sosie/cli` starts a local, read-only endpoint in front of your database
  or API. Every value comes back as a realistic fake; the same real value is
  always the same fake, so joins hold and a value the agent saw finds its
  record again.
- Postgres: the Postgres wire protocol, for `psql`, ORMs and any Postgres MCP
  server. PostgreSQL 15 to 18; tested with psql, node-postgres, postgres.js,
  Drizzle and Prisma 7.
- REST: `GET` and `HEAD` only, with Sosie's credentials, never the agent's.
  Values are named from the API's OpenAPI document, or by where they sit;
  links point at Sosie with every value in them faked.
- GraphQL: queries only, checked against the schema; introspection is answered
  from the schema Sosie holds and never reaches the API.
- Several Sosies, one per upstream, share one store, so a person is the same
  fake from the database and from the API.
- `sosie.yml`, optional, lists the fields that may pass unchanged and the format
  of a field Sosie cannot tell from its name.
- `npx @sosie/cli mcp` serves agents that prefer MCP: `describe`, and each
  source's own tool, `query`, `request` or `graphql`.
- `npx @sosie/cli scan <path>` searches transcripts and logs for real values and
  exits 1 if it finds one.
- Node 24 and 26.

Reviewed by an independent panel that tried to get planted values out: five
rounds for the Postgres endpoint, seven for the shared store and the API
sources. What it found is fixed; what remains is in the
[threat model](docs/hld.md#threat-model) and the limits of each source in the
[low-level design](docs/lld.md).
