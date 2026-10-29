# Sosie: low-level design

How Sosie is built. The [high-level design](hld.md) says why.

## Stack

Current versions as of October 2026.

| Need | Choice |
| --- | --- |
| Runtime | Node 26, the LTS line from 28 October 2026 (supported until April 2029). `engines` also allows Node 24, supported until April 2028, so `npx @sosie/cli` runs on machines that have not moved yet. Node 22 is out: its support ends in April 2027 |
| Language and tests | TypeScript 7, Vitest 5 |
| Mapping store | `node:sqlite`, built into Node: no native build |
| Fake values | [`@faker-js/faker`](https://github.com/faker-js/faker) 10, seeded per value |
| MCP | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 1.32 |
| Config | [`yaml`](https://github.com/eemeli/yaml) 2.9 |
| Postgres source: wire protocol | Sosie's own, in `protocol.ts` and `session.ts`: the server side of protocol 3.0, about 700 lines |
| Postgres source: upstream | [`pg`](https://github.com/brianc/node-postgres) 8.23 connects (TLS, passwords, SCRAM); Sosie then drives its connection message by message |
| Postgres source: SQL | [`pgsql-parser`](https://github.com/constructive-io/pgsql-parser) 18: Postgres's own parser compiled to WebAssembly, parse and print |
| Upstream databases | PostgreSQL 15 to 18, each tested in CI. 19 when it is released (release candidate 1 on 15 October 2026) and the parser supports it. 14 is out: its support ends on 12 November 2026 |

**Why our own endpoint.** The design planned on `pg-gateway`, kept behind one
file. Relaying the extended protocol as the client drives it, statement by
statement and portal by portal, needs every message in hand: Sosie must see a
Bind to rewrite its parameters and a RowDescription to fake the rows that
follow. A small server of our own does that directly; a gateway would have
been wrapped around the same code.

## Packages

One repository, npm workspaces, five packages:

| Package | Published as | Holds |
| --- | --- | --- |
| `packages/cli` | `@sosie/cli` | The CLI, run with `npx @sosie/cli` or installed as the `sosie` command, and the official sources it bundles |
| `packages/core` | `@sosie/core` | Everything that does not depend on a source: the source interface, the neutral schema, rules, faking, the store, `scan`, the MCP server |
| `packages/postgres` | `@sosie/postgres` | The Postgres source: endpoint, guard, rewriting, schema reading |
| `packages/rest` | `@sosie/rest` | The REST source: an HTTP endpoint for the team's own API, OpenAPI reading, JSON faking |
| `packages/graphql` | `@sosie/graphql` | The GraphQL source: a GraphQL endpoint for the team's own API, schema by introspection, query checking and faking |

Later sources are packages of their own in the same scope: `@sosie/mysql`. The `@sosie` scope is an npm organisation,
registered on 25 October 2026, so nobody else can take a name in it. Its team
`developers` publishes.

**Dependency rule:** `core` depends on no source. A source depends on `core`
only, never on another source. `cli` depends on `core` and the official
sources. A test (`test/dependencies.test.ts`) enforces it, on imports and on
`package.json`.

The CLI is not plain `sosie` because npm refuses that name as too similar to
the popular `jose` package.

```
packages/
  core/src/
    source.ts        the Source interface, the neutral schema, the Faker
    rules.ts         sosie.yml, checked against the neutral schema
    domains.ts       which domain a field's values fake in
    fake/
      index.ts       the Faker: values, computed values, lookups, scrubbing
      types.ts       one faker per neutral type
      formats.ts     field names to realistic formats
      random.ts      the seeded generator, and shapes
    store.ts         mapping store, keys, sealing
    text.ts          how scan compares text
    scan.ts          sosie scan
    mcp.ts           the MCP server: describe, and each source's tools
    running.ts       which Sosies run, for sosie mcp
  postgres/src/
    index.ts         the Source: matches postgres://, connects, serves
    endpoint.ts      the TCP server
    protocol.ts      frontend messages in, backend messages out
    session.ts       one client: start-up, then the relay
    upstream.ts      one read-only session upstream per client
    guard.ts         allow reads; refuse writes and some catalogs; find what a fake is compared with
    rewrite.ts       fakes in constants and parameters, back to real values
    schema.ts        pg_catalog to the neutral schema
    results.ts       which field each result column came from
    arrays.ts        Postgres array text
    mcp.ts           the query tool
  rest/src/
    index.ts         the Source: matches http:// and https://, finds the OpenAPI document
    endpoint.ts      the HTTP server: the guard, paths and queries back to real values
    upstream.ts      the API: Sosie's credentials, same-origin redirects, a timeout
    openapi.ts       an OpenAPI document to the neutral schema and its GET operations
    paths.ts         what a path names: an entity, and the field of each value in it
    fake.ts          a JSON body, every value faked by its field
    mcp.ts           the request tool
  graphql/src/
    index.ts         the Source: matches a path ending in graphql, reads the schema
    endpoint.ts      the HTTP server: parse, validate, queries only, errors by phase
    upstream.ts      the API: Sosie's credentials, no redirects, a timeout
    schema.ts        a GraphQL schema to the neutral schema
    rewrite.ts       fakes in arguments and variables, back to real values
    fake.ts          the data, every leaf faked by its schema field
    mcp.ts           the graphql tool
  cli/src/
    cli.ts           sosie, sosie mcp, sosie scan
    sources.ts       the sources this CLI knows
    prompt.ts        the hidden prompt
test/
  memory-source/     a source that serves rows from memory, for core tests
  e2e/               Postgres seeded with canary values, and fake REST and GraphQL APIs serving the same people
```

## The source interface

A source is everything that knows one kind of upstream. The core gives it a
`Faker`; it gives the core a schema and an endpoint.

```ts
export interface Source {
  /** 'postgres' now; 'rest', 'graphql', 'mysql' later. */
  readonly kind: string
  /** Whether this source handles this upstream, or this endpoint address. */
  matches(url: URL): boolean
  /** Connect read-only and describe the upstream in neutral terms. */
  connect(upstream: URL, options: SourceOptions): Promise<Connection>
  /** MCP tools beside the core's describe: Postgres adds query. They talk to the running endpoint, never to the upstream. */
  readonly tools?: McpTool[]
}

export interface Connection {
  readonly schema: Schema
  /** Where the upstream is, without credentials: 'db.internal:5432/app'. Shown in the terminal. */
  readonly label: string
  /** What was found, for the terminal: '42 tables, 3 views'. */
  readonly summary: string
  /** Things the developer should know: 'The login can write to 12 tables.' */
  readonly warnings: string[]
  /** Start the endpoint clients use. Every value it returns goes through the Faker. */
  serve(listen: { host: string; port: number }, faker: Faker): Promise<Endpoint>
  close(): Promise<void>
}

export interface Endpoint {
  /** What clients use: postgres://localhost:7674/app. */
  readonly address: string
  close(): Promise<void>
}
```

The core's half. A source hands over values as text, null, or lists of them
(`Value = string | null | Value[]`): Postgres splits its arrays before faking
and joins them after.

```ts
export interface Faker {
  /** The fake of a value read from a field. Null stays null; a field that passes returns the value unchanged. */
  value(value: Value, field: Field): Value
  /** The fake of a value no field holds (length(email), upper(name)). */
  computed(value: Value, type: FieldType): Value
  passes(field: Field): boolean
  /** A scope per request; `from` carries a prepared statement's substitutions over to each execution. */
  request(sent?: string, from?: RequestScope): RequestScope
}

export interface RequestScope {
  /** The real value behind a fake, in the domain of the field it is compared with, or unique overall. */
  lookup(fake: string, near?: Field): string | undefined
  /** Substituted real values back to their fakes; quoted text the client did not send masked. */
  scrub(text: string): string
}
```

**The neutral schema** is what every source maps its upstream to, and the only
thing rules, domains and fakers see:

```ts
export interface Schema { entities: Entity[] }
export interface Entity { id: string; name: string; fields: Field[] }
export interface Field {
  id: string                  // 'users.email': the name rules use
  name: string                // 'email': picks a realistic format
  type: FieldType
  key?: 'primary' | 'unique'
  references?: string         // the field whose values it shares: a foreign key's target, a view column's source
}
export type FieldType =
  | { kind: 'string'; maxLength?: number }
  | { kind: 'integer'; bytes?: 2 | 4 | 8 }
  | { kind: 'decimal' }
  | { kind: 'boolean' }
  | { kind: 'enum'; labels: string[] }
  | { kind: 'date' | 'datetime' | 'time' }
  | { kind: 'uuid' | 'bytes' | 'ip' }
  | { kind: 'json' }
  | { kind: 'array'; of: FieldType }
  | { kind: 'unknown' }
```

**Choosing a source:** the CLI asks each source it knows whether it `matches`
the upstream URL, in order: Postgres, then GraphQL for an http(s) URL whose path ends in `graphql`, then REST for any other. Sources from other packages, listed
in `sosie.yml`, come after v0.1, when the interface is settled; until 1.0 it may
change between minor versions.

## CLI

| Command | What it does |
| --- | --- |
| `sosie` | Start. Reads `SOSIE_UPSTREAM`, or asks for it at a hidden prompt |
| `sosie mcp` | MCP server over stdio, connected to the running `sosie` |
| `sosie scan <path>…` | Search files and folders for real values; exit 1 if one is found |

Flags for `sosie`: `--port` (7674; without it, a Sosie whose port is taken tries
the next nine, so a second Sosie, for another upstream, just starts), `--host`
(127.0.0.1), `--rules` (`./sosie.yml` when present), `--max-rows` (1000, at
least 1). A `--host` other than this
machine is allowed, for running Sosie on a host of its own, with a warning:
the endpoint has no password, so anyone who can reach it can query the fakes. Exit codes: 0, 1 for a failure (cannot
connect, a problem in `sosie.yml`, a real value found), 2 for a usage error.

The connection string is never an argument: arguments show in shell history and
in the process list, where an agent can read them. Without a terminal to type
it in, `sosie` says to set `SOSIE_UPSTREAM`.

```
  ✓ db.internal:5432/app, read-only: 42 tables, 3 views
  ✓ Every value is faked; 3 fields pass (sosie.yml)
  ! The login is a superuser or can replicate. Sosie refuses the admin functions it knows, but a read-only login is safer.
  ! The login can write to 12 tables. Sosie's session is read-only, but a read-only login is safer.

  Your agent, app and psql:  postgres://localhost:7674/app
  Claude Code:               claude mcp add sosie -- npx @sosie/cli mcp
```

Each `sosie` writes `$SOSIE_HOME/running/<pid>.json` (default `~/.sosie`) for
`sosie mcp`: the local address, the source kind, the neutral schema and the
fields that pass. Nothing real: no upstream, no credentials, no values. It is
removed on Ctrl+C, a kill, or the terminal closing, and `sosie mcp` skips, and
removes, the entry of a process that is gone.

## `sosie.yml`

Optional, committed with the code, written in field ids from the neutral
schema, so the same file works for every source.

```yaml
# Fields whose values pass unchanged.
pass:
  - orders.status
  - products.price
  - countries.*

# Formats for fields Sosie cannot tell from their names.
format:
  users.handle: username
  accounts.iban: iban
```

Formats: `email`, `phone`, `first_name`, `last_name`, `full_name`, `street`,
`city`, `postal_code`, `country`, `company`, `username`, `url`, `iban`,
`text`, `shape`.

An unknown key, entity, field or format is an error at start-up that names it,
so a typo never passes data silently. Every problem is listed at once:
`sosie.yml: users.emial is not a field. Did you mean users.email?`

A field that shares another's values cannot pass alone:
`sosie.yml: orders.user_id passes but users.id, whose values it shares, does not. List both or neither.`

Nor can what names no entity, as an API's error body (`*.error`), or Sosie's own
words for an API's (`$path`, `$query.value`): a source that learns its fields
keeps a rule it has not met yet, but never one of these.

## Start-up

1. Read the upstream; pick the source that matches it.
2. `connect`: the source reads its catalog on a read-only connection and
   returns the neutral schema.
3. Load `sosie.yml` and check it against the schema.
4. Open the store, creating its key on first use.
5. `serve`; write its entry under `running/`; print the address.

## Core: domains

A domain is the set of real values that share fakes. For a field:

1. Listed under `pass`: no domain, the value passes.
2. It shares another field's values (`references`): that field's domain, so
   `orders.user_id` fakes like `users.id`, and a view's `email` like its
   table's. Its fakes are drawn for the key's type, so a key of two characters
   stays two characters wherever it appears.
3. Its format is personal (email, phone, first name, last name, full name,
   street, city, postal code): the format's domain, so one person's email is
   the same fake in every field, and later in every source.
4. Otherwise: the field's own id.

Values a query computes fake in `computed:<type>`.

## Core: fakes by type

| Neutral type | Fake |
| --- | --- |
| `string` | The field's format when known. Otherwise shaped like the value: an email stays an email, a date a date, a number a number, a code like `AB-1234` keeps its letters, digits and punctuation, a word becomes a word of about the same length, and text becomes words of about the same length. Within `maxLength` |
| `integer` | A number with the same sign and number of digits; never zero for a value that is not zero; within the column's size |
| `decimal` | Digits replaced: the same sign, digits and scale. `NaN` and `Infinity` stay; other text is shaped |
| `uuid` | A random UUID |
| `boolean` | Flipped or not, decided once per domain by its key |
| `enum` | A label of the same enum, by a fixed shuffle per domain; the shuffle may leave a label in place |
| `date`, `datetime`, `time` | Shifted by up to a year, the same shift for the same value, in the same format |
| Any type, a value with no letter or digit (`''`, `-`, `NaN`, `infinity`) | Itself: there is nothing in it to fake |
| `json` | Same structure; each leaf faked by its JSON type, in the domain `field.$path`, or the format its key names (an `email` leaf shares `format:email`). Keys: in a json column, a key that looks like a word (`city`, `createdAt`, `address_line1`) stays, and any other (a name, an email, a code) is faked. In JSON a query builds (`json_object_agg`, `jsonb_build_object`, `row_to_json`), a key stays only when it names a column or the client wrote it in the query; keys made from values are faked. Anywhere, a key that holds a value the request turned back from a fake (`quillon`, `quillon_profile`, `QuillonSettings`) is faked, however it looks: an answer that holds it is echoing what the client sent |
| `array` | Each element faked in the field's domain |
| `ip` | An address from a documentation range |
| `bytes` | Random bytes of the same length; derived, not stored |
| `unknown` | `null` |

Fakes are deterministic: the faker is seeded from the value's keyed hash, so the
same real value gives the same fake in every session.

A field that passes still never shows a value the request turned back from a
fake: an answer that holds it, whole or within text and whatever its case, is
echoing what the client sent, and shows the fake the client sent instead. One
that holds it in another form, escaped as a URL or a form escapes it (`%40`,
`+`) or with other separators (`quillon-vantablack`), is faked whole, as a
computed value is. An enum label or a boolean the request turned back is an
echo as a word of text (`active=true`, `{"role":"admin"}`), and shows the fake
the client sent; a field of its own kind keeps its value, which is its own.
Sosie's own credentials for the upstream count as well: a key, or a value that
passes, that holds one, escaped or not, is faked. What an answer makes of an
echo beyond that, a part of it (an
email's local part) or it encoded (base64) or reversed, is not caught: a field
passes because the team chose to show it. A number counts when it is six
digits or more; a shorter one may be any count. The values a request turned
back are indexed once, so each value is checked against all of them in time of
its own length: a query by a thousand fakes that returns a thousand rows takes
no longer to check than it takes to fake.

## Core: store

One SQLite file for every upstream: `~/.sosie/store/store.db`. One store, one
key: a person's email is the same fake from a database and from an API, through
its format domain, as the high-level design promises. A build before this one
kept a store per upstream, `~/.sosie/<hash>/`, with its own key: it is left as
it is, its fakes are not carried over, and `sosie scan` still reads it until it
is deleted.

```sql
CREATE TABLE value (
  domain    TEXT NOT NULL,     -- 'users.email', 'users.id', 'format:email'; never a value
  mac       BLOB NOT NULL,     -- HMAC-SHA256(key, real value)
  mac_ci    BLOB NOT NULL,     -- HMAC of the value as scan compares it
  fake      TEXT NOT NULL,
  fake_ci   TEXT NOT NULL,     -- the fake as scan compares it
  sealed    BLOB NOT NULL,     -- AES-256-GCM(real value), for queries by a fake
  scannable INTEGER NOT NULL,  -- distinctive enough for scan to look for
  PRIMARY KEY (domain, mac)
) WITHOUT ROWID;
CREATE INDEX value_fake ON value (fake, domain);
CREATE INDEX value_scan ON value (mac_ci) WHERE scannable = 1;
```

- **Keys.** `~/.sosie/store/key` holds 32 random bytes, created on first start
  with mode 0600 in a folder of mode 0700; the database files are 0600 too. The HMAC, sealing and seeding keys
  are derived from it with HKDF.
- **Allocation.** The fake is drawn from a seed taken from the value's keyed
  hash. A fake is never the value itself, unless the value has no letter or
  digit to fake: draws stop after a fixed number of attempts. For keys and text, a fake is unique
  within its domain: if it is taken, the seed advances, and a numeric key whose
  digit range fills up gets one more digit. Other numbers only need to be
  consistent, so two real values may share a fake.
- **Booleans, enums and bytes** are not stored; their fakes come from the key.
- **Lookup.** A fake compared with a field is looked up in that field's domain.
  A fake compared with something Sosie cannot place is used when it names
  exactly one real value across all domains, and otherwise left as written.
- **Several Sosies** share the store, for one upstream or several, and may
  start at the same moment: the key is written to a draft file and linked into
  place, so it is made once and whole; SQLite's WAL and a busy timeout
  serialise the rest. A new fake is drawn and stored in a write transaction,
  so two Sosies never give one fake to two values of a domain.

## Core: `sosie scan`

Reads every text file under the paths given, skipping `.git`, `node_modules`
and binary files. Decodes JSON string escapes, since transcripts are JSON lines
(`email\nkim@…`). Splits each line into words, lower-cased and without the
punctuation around them, and compares every run of one to four words, by
keyed hash, with the store's real values. Only distinctive values are looked
for: one to four words of at least four characters, and numbers of six digits
or more, so years, ports and line numbers are not findings. A run that is also
a fake is not counted: it is what the agent was shown. An API's own words in
paths and query names are structure, and not looked for. A real value that is
a common word held as text rather than an enum (a role `admin`, a status
`paid`) is looked for like any other, so a transcript that uses the word is a
finding: such a field belongs under `pass` in `sosie.yml`, and a field that
passes is neither stored nor looked for. A finding from a domain of no entity
(`*.error`, an error's body) cannot pass: it may be any value an API quotes. It never prints the real value, and
exits 1 if it finds one, so CI can run it.

```
  ✗ ~/.claude/projects/app/2026-11-02.jsonl:1203  a real value from users.email
  1 real value found in 412 files.
```

## Core: `sosie mcp`

The core serves `describe` from the neutral schemas under `running/`, one per
running Sosie; each source adds its own tools, which run inside `sosie mcp` and
talk to a running endpoint of their kind, so the MCP process never holds
credentials or real values. Each takes an optional `address`, as `describe`
lists it, for when several Sosies of a kind run; without it, the newest.

| Tool | From | Input | Returns |
| --- | --- | --- | --- |
| `describe` | core | `entity` (optional) | Entities, fields, types, keys, references, and which fields pass |
| `query` | Postgres | `sql` | Up to 200 rows per statement as JSON, the row count, and any notice; every value a consistent fake |
| `request` | REST | `path`: a path and query, or a link Sosie returned | The status and the JSON body of a GET through Sosie, up to 200 items of each list, within 50 s; it reaches the running Sosie only, whatever the path says |
| `graphql` | GraphQL | `query`, `variables` (optional) | The response of a query through Sosie, up to 200 items of each list, within 50 s |

When Sosie is not running, every tool says so, and how to start it.

## Postgres source

### Endpoint

It listens on 127.0.0.1, and on ::1 too, since the address it prints says
`localhost`. Supported: start-up without TLS (SSL and GSS requests are
answered no), any user and database name, no password; protocol 3.0 (a client
asking for 3.2 is told 3.0); the simple query protocol; the extended protocol
(Parse, Bind, Describe, Execute, Close, Sync, Flush) with results in text
format; cancel requests, forwarded upstream. Refused with a clear error:
binary result formats, COPY, function calls (answered with an error and
ReadyForQuery, as Postgres answers them). After an error, every message up to
the next Sync is discarded, a simple Query too, as Postgres does. A message
that does not parse closes its own connection, never the process; a malformed
array literal is an error, never a loop.

### Upstream

One `pg` connection per client, opened at its start-up. pg's Client connects
it; Sosie then takes over the connection's messages and relays each frontend
message with a Flush, so its own errors fall in the right place among
upstream's replies. The session is read-only from its start-up options:
`default_transaction_read_only=on`, `statement_timeout=30s`,
`idle_in_transaction_session_timeout=5min` (a transaction an agent leaves open
would hold locks on the database), ISO dates, hex bytea. A client may lower
either timeout, never lift it. Two more settings are pinned because they change how Postgres reads a
statement's text, which Sosie's parser must read the same way:
`standard_conforming_strings=on` (off, `'a\''` ends elsewhere) and
`client_encoding=UTF8`. Settings in the connection string's own `options`, and
a role's or database's defaults, are overridden: Sosie's come last. Start-up
settings in the connection string itself (`statement_timeout`,
`client_encoding`, `replication` and the like), which Postgres would apply
after Sosie's, are dropped.

A simple query is run upstream with the extended protocol, statement by
statement, executing at most `--max-rows` + 1 rows: a result cut at the cap
returns `--max-rows` rows and a notice.

### Schema

Tables, views, materialised views and foreign tables; columns, types, enum
labels, single-column primary and unique keys, and foreign keys (each column
of a composite one), read once from `pg_catalog` and mapped to the neutral
schema; and the names of user-defined functions, operators and types. Field ids are `table.column`, or `schema.table.column` outside
`public`. A partition's columns are its parent's fields. A view column shares
the values of the column it selects unchanged, read from the view's own
definition (`pg_get_viewdef`) with Postgres's parser: `SELECT u.email FROM
users u` shares `users.email`; a column the view computes (`upper(email)`, a
cast, `name || full_name`), or takes from a subquery or a `UNION`, fakes in its
own domain and passes only if `sosie.yml` lists it.

| Postgres | Neutral |
| --- | --- |
| `text`, `varchar`, `char`, `citext`, `name` | `string` (with `maxLength`) |
| `int2`, `int4`, `int8`, `oid` | `integer` |
| `numeric`, `float4`, `float8`, `money` | `decimal` |
| `bool` | `boolean` |
| An enum type | `enum` |
| `date`, `timestamp`, `timestamptz`, `time`, `timetz` | `date`, `datetime`, `time` |
| `uuid`, `json`, `jsonb`, `bytea`, `inet`, `cidr` | `uuid`, `json`, `json`, `bytes`, `ip`, `ip` |
| A domain | its base type |
| Arrays of any of these | `array` |
| Anything else | `unknown` |

### Guard

Each statement is parsed. Allowed: `SELECT` and `WITH`, unless they have
`INTO`, a data-changing CTE, `FOR UPDATE` or `FOR SHARE`; `SHOW`; `SET` and
`RESET`, except the settings that keep the session read-only and its login
what it is (`default_transaction_read_only`, `transaction_read_only`, `role`,
`session_authorization`, `READ WRITE` transactions), the pinned settings
(`standard_conforming_strings` and `client_encoding` may only be set to the
values Sosie pinned), and `statement_timeout` above the limit Sosie started
with; `BEGIN`, `COMMIT`, `ROLLBACK` and
savepoints; cursors (`DECLARE`, `FETCH`, `CLOSE`), but not `WITH HOLD`, whose
query runs at `COMMIT`; `PREPARE`, `EXECUTE`,
`DEALLOCATE`, `DISCARD`. Refused: everything else, including `EXPLAIN`, whose
plan would print the real values Sosie substituted.

Refused relations, because they hold row values, queries with their values,
credentials, or where the database is: `pg_stats`, `pg_stats_ext`,
`pg_stats_ext_exprs`, `pg_statistic`, `pg_statistic_ext_data`,
`pg_largeobject`, every `pg_toast` table, `pg_stat_activity`,
`pg_stat_statements`, `pg_prepared_statements`, `pg_cursors`,
`pg_backend_memory_contexts`, `pg_authid`, `pg_shadow`, `pg_user_mappings`,
`pg_stat_wal_receiver`, `pg_stat_replication`, `pg_hba_file_rules`,
`pg_ident_file_mappings`, `pg_file_settings`, `pg_settings`, `pg_sequences`,
`pg_subscription`, `pg_foreign_server`, `pg_db_role_setting` (per-database
settings may hold secrets), and in `information_schema`
`foreign_server_options`, `user_mapping_options` and the `_pg_` views behind
them; and the functions behind the refused views. `SHOW` and
`current_setting()` refuse the settings that say where the database is
(`listen_addresses`, `port`, `data_directory`, `primary_conninfo`,
`archive_command` and the like, and `SHOW ALL`), as do `inet_client_addr()`,
`pg_config()` and `pg_tablespace_location()`; `pg_settings` and `pg_show_all_settings()`, which list
them all, are refused. `RESET` of the settings that keep the session
read-only is refused like `SET`. Refused functions: those that reveal where the
database is (`inet_server_addr`), read files or raw pages, run SQL given as
text (`query_to_xml` and its family, `ts_stat`, `ts_rewrite`, `dblink`), read
logical decoding or WAL, return other sessions' queries or real key values
(`pg_sequence_last_value`); and `set_config`,
which could copy a value from the rows into a setting: `SET` takes only what
the client writes. Refused too, because a superuser or replication login
could run them: functions that change the server (replication slots,
`pg_switch_wal`, `pg_reload_conf`, statistics resets and imports, large
objects, `pg_notify`) or hold locks other sessions wait on (advisory locks).
The session is read-only too, so a statement the guard misses still cannot
write.

A relation named without a schema is a catalog only if Postgres has a catalog
of that name and no user table shares it; an alias that renames columns
(`users AS u(a, b)`) makes Sosie place none of its columns.

**Catalog-only reads** touch no user table and run no user-defined code (a
function, operator or type, which could read one), and read no setting that
code may have written (custom settings, `application_name`): `\d` in psql, ORMs
reading the schema, `SELECT version()`. Their results pass unchanged and
nothing in them is rewritten, except that a column Postgres says came from a
table other than a system catalog is still faked.

### Rewriting

Constants and parameters compared by equality (`=`, `<>`, `IN`, `= ANY`, `IS
DISTINCT FROM`) are looked up, with the column on the other side when the
statement names one: through aliases, schemas and enclosing queries. A column
of a catalog is left alone. `LIMIT`, `OFFSET` and other constants are never
looked up. A real value found replaces the fake, and the statement is printed
back to SQL; a statement with nothing to replace goes upstream exactly as the
client wrote it. Booleans and enum labels are turned back by their domain's
flip and shuffle. Parameters a client sends in binary format are used as
written.

### Results

`pg` reports each result column's source table OID and column number, which
name the field, even through `SELECT *`, aliases, joins, subqueries, CTEs and
views.

| The result column | Goes to |
| --- | --- |
| A table column | `Faker.value` with its field |
| A column only cast to another type, named in full from a table named in full (`"public"."users"."role"::text`, as Prisma selects enums) | `Faker.value` with its field. A shorter name could mean another column (`search_path`, an alias's column list), so it is computed |
| A constant the client wrote (`SELECT 1 FROM users`) | Unchanged |
| A column of a system catalog | Unchanged |
| A column of a table Sosie knows, in a statement the guard took for catalog-only | `Faker.value` with its field: Postgres's word wins |
| A column of a table Sosie does not know | `Faker.computed` with its type |
| Postgres's own `count(…)`, a bigint, over rows that come from tables | Unchanged: it holds no value from a row. A count over rows a value made (any set-returning function in the catalog, such as `generate_series`, `unnest` or `ts_parse`; a recursive CTE; user code) is faked |
| A column of `UNION`, `INTERSECT` or `EXCEPT` | `Faker.computed` with its type: Postgres reports no source for it, and the arms differ |
| Anything else a query computes | `Faker.computed` with the type of its OID |
| From a catalog-only read | Unchanged |

### Errors

What an upstream error or notice says depends on when Postgres raised it,
because no pattern finds every value a message may quote: Postgres prints
some quoted, some unquoted (`date field value out of range: 1988-14-29`), and
some with no digit at all (`operator does not exist: Vantaville`).

- **Before any row is read**, while Postgres parses, checks and plans a
  statement, a message holds only what the client wrote and the schema:
  `column "nope" does not exist`, `invalid input syntax for type integer:
  "x"`. It comes back through `RequestScope.scrub`: each real value Sosie
  substituted is turned back into its fake, and quoted text or a word with a
  digit that the client did not write, and that names no table or column, is
  masked. The hint is kept, scrubbed the same way.
- **While a statement that reads rows runs**, and at `COMMIT` and the end of
  a request, where work deferred to the end of a transaction runs, only the
  code comes back, with what it means: `invalid text representation (22P02): Sosie hides the rest of
  this message, which may quote a value from your rows.` Codes whose messages
  never quote a value keep their text: a cancel or timeout, read-only, division
  by zero, running out of resources, serialisation failures.
- **From function code** (an error or notice with a context, or a `P0` code),
  the text is hidden whenever it comes: `RAISE EXCEPTION 'user % is not
  allowed', email` can say anything.

Detail and context are always dropped, because they quote rows.

A statement Sosie refuses aborts the transaction it is in, as an error does in
Postgres: what follows fails until `ROLLBACK`, and `COMMIT` rolls back. The position is kept only when the statement went
upstream as the client wrote it.

| Situation | Message |
| --- | --- |
| A write | `This statement changes data. Sosie is read-only.` |
| A refused catalog | `pg_stats holds real values from your tables, so Sosie does not read it.` |
| Upstream unreachable at start | `Cannot connect to db.internal:5432/app: …`, in Sosie's terminal |
| Upstream unreachable for a client | `Sosie cannot reach its upstream database. The terminal running Sosie says why.` |

### Limits

- Order and ranges follow the real values: `ORDER BY` sorts by them, and `>`
  or `BETWEEN` compare them.
- `LIKE` and other partial matches filter the real values, so a piece of a fake
  finds nothing.
- A bare boolean condition (`WHERE active`) filters the real values while the
  fakes may show flipped ones; `active = true` is turned back.
- A value Sosie never showed is used as written, so it filters on the real
  value it happens to be.
- Values passed to a prepared statement in SQL (`EXECUTE p('…')`) are used as
  written; fakes in Bind parameters and in the statement itself are turned
  back.
- Composite values (`SELECT u FROM users u`) and types Sosie does not know come
  back as `NULL`.
- Rows fetched from a cursor carry no source column, so they are faked by type,
  not by field: consistent, but not in the field's domain or format.
- A json column keyed by lowercase words that are data (usernames) keeps those
  keys, since they look like structure.
- A value a function in the database copies into a setting, readable through
  `pg_settings`: Sosie refuses `set_config` from clients, but not what the
  database's own code does.
- `count(…)` with a filter answers yes-or-no questions about real values
  (`WHERE id <= (SELECT score …)`), as the threat model says of filters.

## REST source

For the team's own HTTP API, where the database's people come back as JSON.
`SOSIE_UPSTREAM` is the API's base URL: `https://api.internal/v1`.

### Endpoint and guard

A local HTTP address with the API's own paths: `http://localhost:7674/v1/users`
reads `https://api.internal/v1/users`. Only `GET` and `HEAD` reach the API;
anything else gets `405` and never leaves Sosie. Requests outside the base path
get `404`, and a path whose `%` starts no escape `400`. So does a segment that
decodes to one with a `/` or `\` in it, or to `.` or `..`, and a fake in a
segment that stands for such a value: an API, or a proxy before it, that
decodes `%2F` and resolves `..` would read another path than Sosie does, one
outside the base or of another kind. A method override in the query
(`?_method=DELETE`), which some frameworks run instead of `GET`, gets `400`. On
this machine's own
address, a request whose `Host` is not `localhost`, a `127.` address or `[::1]`
gets `403`: a web page that rebinds its own name to this machine cannot read the
fakes. So does a browser's request for a page of another site (an `Origin` that
is not this machine, or `Sec-Fetch-Site: cross-site` without one): a web page
cannot make Sosie send a `GET` with its credentials. A page of this machine, an
app on another port, is answered; Sosie sends no CORS headers, so a browser app
reads it through its dev server's proxy.

### Credentials

The API's credentials are Sosie's, never the client's: `SOSIE_UPSTREAM_HEADERS`
holds them, one `Name: value` per line (`Authorization: Bearer …`; a line that is no
header stops Sosie, named by its number, never quoted), and a user
and password in the URL become a Basic header; a query on it (`?api_key=…`) goes
with every request and is never shown, links included. Headers the client sends,
`Authorization` included, are not passed on. Redirects are followed inside
Sosie, within the API's origin and its base path only, never to an address with
a user name in it nor through a segment that decodes to a `/` or `..`, so
credentials never go elsewhere and the client never sees a real URL. What the
terminal says when the API cannot be read leaves the query credentials out. Each request has the statement timeout (30 s) and
a body cap (20 MB), counted as the body arrives.

### Schema

From an OpenAPI document, 3.x or Swagger 2.0, JSON or YAML: the file or URL in
`SOSIE_OPENAPI`, or the first of `openapi.json`, `openapi.yaml`,
`swagger.json`, `v3/api-docs`, `api-docs` and `docs/openapi.json` the API
serves under its base. Each object schema is an entity (`allOf` merged), each
property a field, a nested object's properties dotted (`User.address.city`).
A property that refers to another schema (`$ref`, or `allOf` of one, as
OpenAPI 3.0 writes a nullable reference) is that entity's row, so a schema that
refers to itself is read once, and an array of arrays of itself, so deep it
has no end, is JSON. A document the API serves but Sosie cannot read is named
in the banner's warning.
JSON Schema types and formats map to neutral types (`date-time` to `datetime`,
`uuid`, `ipv4`, `enum` to `enum`); `format: email` and `uri` pick the email and
URL formats. A property `id` is the entity's key; one named `userId`, `user_id`
or `userIds` shares the values of the id of the entity it names, `User`. Such a
reference is a guess from a name: it shares the target's fakes, but never
passes because the target does in `sosie.yml`.

Without a document, the schema is learned as responses come: a value is the
field of where it sits, in the entity its path names, singular (`/users` and
`/users/87` are `user`; `{ "data": [{ "email": … }] }` is `user.email`, the
envelope keys `data`, `items`, `results` and the like left out). The banner says
so, and `sosie.yml` may name fields not met yet: they warn instead of failing,
and apply once met. A body that does not have the shape its document says is
read the same way.

### Faking

Every value of a JSON body is faked by its field, with the core's rules: types,
domains, formats by name, `sosie.yml`. Formats are shared with every source, so
a person's email is the same fake from the database and the API. A key that is
structure (`city`, `createdAt`) stays; one that is a value (a map keyed by
email) is faked, each to its own fake. Every key of a map the document declares
(`additionalProperties` with a schema) is a value, and so is a key that holds a
value the request turned back, whatever its case and separators
(`quillon_profile`, `quillonSettings` for `quillon`): an API that answers with
what it was asked never hands the real value back. So is a key that holds one
of Sosie's own credentials, each part of it six characters or more, between
spaces, quotes, colons and separators: of a credential header's value
(`Authorization`, `Cookie`, `X-Api-Key` and the like; of `name=value` pairs,
such as `Token token="…"` or a cookie, the value; a `Basic` one's user and
password; the scheme's name, `Bearer`, aside), of a query credential, and of
the user and the password in the URL. A header that carries no credential
(`X-Tenant`) holds none, so its words stay where they are structure. An integer beyond 2^53 (a 64-bit id) is read and
written as its digits, never rounded, so its fake leads back to its record. A
list keeps its first
`--max-rows` items, and the answer's `sosie-notice` header says the rest were
cut; a large body is faked a slice of 20 ms at a time, so other clients are
answered meanwhile.

A URL into the API (`next`, `href`, or a path under the base) points at Sosie
instead, with nothing real in it, so following it reads the record it names:

- A path segment stays as written when it is a word Sosie knows as a name of
  the API's: a fixed segment of an OpenAPI path, a collection's name
  (lowercase, plural) a client asked for as the last word of a path and the
  API answered with a list (`/users`, `/users/87/orders`), or a word of the
  request the answer is for. Another word a client sent (a tenant's slug from
  an app's settings, `/jones/profile`) is never shown to another request. A
  value (a number, a UUID, a template's parameter, or what follows a
  collection's name, as in `/users/jdoe`) is faked as the id of what it
  follows; any other word is faked in a domain of its own (`$path`), and names
  no entity, so no domain holds it. What follows such a word is its id only
  when it is a number or a UUID; a word there (`/quillon/repos`) is the API's,
  in `$path` too. Nor does a word a client typed that is no
  name (`Vantablack`, an email): a name starts lowercase and runs on in
  letters and digits, in kebab, snake or camel case. The API's words in
  `$path` and in query names (`$query`) are its structure: `sosie scan` does
  not look for them.
- Query values are faked by the field they name, so a real value Sosie sent
  upstream comes back as the fake the client sent; a page's number (`page`,
  `limit`, `offset` and the like, up to five digits) stays. A name stays when
  it is a common one (`sort`, `cursor`, `q`), a field of the document, a key a
  body has shown as structure, a reference (`userId`), or one of the request
  the answer is for; any other (`q[Quillon]`, `?jdoe=1`) is faked, and its
  value too, under no field's name, which no rule in `sosie.yml`, a wildcard
  included, can name. A reference guessed from a name (`countryId`) shares the
  id's fakes, and never passes because the id does, as in a body. Sosie's own
  query credentials are left out.
- Every value is faked in the request's scope, so a field that passes shows
  the fake the client sent where the API carries a filter into a link
  (`/users?id=<what it was asked>`), as in a body.
- A word or a name that holds a value the request turned back is faked,
  however it looks.
- The fragment is left out. Text that starts with a URL and goes on is text.

Status codes pass; error bodies in JSON are faked as no entity's, each value by
where it sits, so no field's rule in `sosie.yml` applies to them; a body that is
not JSON is not passed on: an error status passes with Sosie's own message, and
any other answer is `502`, saying why, JSON nested too deep to read included.
An answer the API redirected to another path is read by that path, as a link
is, so another kind's rule in `sosie.yml` never applies to it.

An answer is read as an entity's only when Sosie can tell its path names one:
every value in it is a number, a UUID or a fake Sosie gave. A word the client
typed where a value goes (`/products/reviews` without a document, or matching
`/products/{id}` with one; a login an app knows) may name another kind of
record, so the answer is no entity's: its values are faked by where they sit,
and no rule passes them. So is a redirect to such a path, and a body that does
not have the shape its document gives it (a list where it says an object).

### Query by what you saw

Sosie reads a path the way it reads a link, so following a link and asking
directly name the same record. A word it made up for a link turns back into the
API's word. A value, by the same habit or because it is a fake Sosie gave, turns
back into a real one in the domain of the id of the entity it follows
(`/users/87` is `user.id`, `/users/{userId}/orders` by its OpenAPI name); text,
but never a bare number, is looked up anywhere too. A query parameter is looked
up in the field it names (`?email=` in `user.email`, `?userId=` in `user.id`,
`?role=` by the document's enum, `?active=false` as the boolean it shows);
other text anywhere; a number that names no field (`limit=10`, `page=2`) stays
as written. A value compared with a field that passes is real already, and
stays as written, in a path too: looked up anywhere, a fake of another field
would turn into that field's real value, which the passing field would show.

### Limits

- Response headers other than the content type are not passed on, `Link`
  among them: pagination works through the body.
- JSON only: images, files and HTML from the API are not passed on.
- Ids are consistent within the API and across its links. Domains are named
  after entities and fields, so an API's ids and a database's share fakes only
  when their names meet in one store (a GraphQL type and a Prisma model both
  `User`, as `User.id`), and then the same id is the same fake in both.
- Without a document, a field rule with a wildcard (`country.*`) passes every
  top-level key of that entity the API ever answers with, a key that `expand=`
  or a new release adds included, and the value of every word-like query name
  in a link to it (`?email=` in a `/countries` link). With a document, it
  passes the fields the document names.
- A rule that passes an id (`user.id`) passes what follows a collection's name
  in a path, which Sosie reads as the id: a login or an email, as in
  `/users/jdoe`, is shown as it is.
- A body is parsed in one go before it is faked a slice at a time: about half
  a second, at the 20 MB cap, in which other clients wait.
- A word a client typed that looks like a name, a tenant's slug in lowercase
  (`jones`, `acme-industries`), names an entity after it, and the domains of
  that entity's fields, which `sosie scan` prints, are named after it too; a
  link never shows it. One that starts with a capital (`/Customers`, as OData
  writes paths) names no entity, so no rule in `sosie.yml` applies under it:
  every value there is faked.
- Without a document, the same record read through two kinds of path may be
  two entities, with two fakes of its id: `/users/87` is `user`, while
  `/people/by-email/…` names its entity after the last word it can.
- A map keyed by lowercase words (`{ "jdoe": … }`) keeps its keys, as a json
  column's do, unless the document declares it a map or the request turned
  that word back: they look like structure. Such a key is part of the names of
  the domains below it, which `sosie scan` prints. A link's query name that is
  a lowercase word (`?jdoe=1`) stays for the same reason.
- A link reads less well than the API's own: a word no client has asked a list
  of yet, and one that follows a collection's name (`/users/by-email/…`), comes
  back faked, and so does a query name Sosie cannot tell is structure.
- Without a document, a tenant's slug that is itself a lowercase plural
  (`jones`), asked for on its own (`/jones`) and answered with a list, is taken
  for a collection's name, and links show it.
- An endpoint the API serves for `GET` that writes is the API's to guard: Sosie
  sends every `GET` on.
- An id with a `/` in it (`group%2Fproject`, as GitLab names projects) cannot
  be asked for by path; the API's other id for it can.

## GraphQL source

For the team's own GraphQL API. `SOSIE_UPSTREAM` is its endpoint, whose path
ends in `graphql` (`https://api.internal/graphql`); any other http(s) URL is
the REST source's. Credentials as for REST: `SOSIE_UPSTREAM_HEADERS`, a user
and password in the URL, or a query on it, never shown; the client's are never
passed on. As for REST, a JSON key, or a value that passes, that holds a part
of them is faked.

### Schema

By introspection, with Sosie's credentials, at start-up. An API with
introspection off is read from `SOSIE_GRAPHQL_SCHEMA`: its SDL, or an
introspection result as JSON. Each object and interface type is an entity, each
field that holds a scalar or an enum is a field; one that holds another object
is that object's row. Built-in scalars map to neutral types, and custom ones by
name (`DateTime`, `Date`, `UUID`, `JSON`, `jsonb`, `Map`, `Any`, `BigInt`);
`Email` and `EmailAddress` pick the email format, `URL` and `URI` the URL
format; an object in any other custom scalar's place is faked as JSON a query
builds. The query type is an entity too when it holds scalars (`{ version }`),
so `sosie.yml` can name them. A field `id` is the type's key; one named `userId`
shares the values of `User.id`, as a guess that never passes. A schema that is
not valid GraphQL stops Sosie at start, saying why.

### Endpoint and guard

The API's own path on a local address, by `GET` and `POST`, batches of up to 50
operations included. A `POST` is JSON or `application/graphql`, of up to 1 MB
(`413` above it); any other type, as a web page's form or `text/plain` would
send, gets `415`. On this machine's own address, a `Host` other than localhost,
or a page of another site, gets `403`, as for REST. Each operation is parsed and
checked against the schema, and its variables against their types, so the API
is never asked about a value Sosie turned back: what fails there gets `400`,
quoting only what the client sent. A query of more than 10,000 tokens is
refused before it is parsed. Checking runs on two threads of Sosie's own, each
query within 2 seconds and 256 MB: graphql-js can take minutes over a small
query that repeats a field, so one that needs more is refused
(`SOSIE_TOO_COSTLY`). One costly query leaves the other thread to answer
everyone else; while both work on costly queries, others wait their turn, at
most 2 seconds for each costly query ahead of them, since each is refused by
then. A Sosie that cannot listen on its port stops its threads.
Only queries reach the API, and only the operation to run with the fragments
it uses: a mutation or a subscription is answered with an error, and its text
never leaves Sosie. A persisted query without its text is refused. POSTs are
not redirected: the body and the credentials stay with the API.

Introspection is answered from the schema Sosie holds, with what the client
sent, and never reaches the API; so clients introspect an API that has
introspection off. It runs on the same threads, within the same limits and an
answer of up to 20 MB, since aliases and fragments can ask for the schema many
times over in a few lines. `__schema` and `__type` beside data fields, or
below the root (under a field of type `Query`, as PostGraphile's `query`), are
refused: ask for them at the root of a query of their own.

### Faking

Every leaf of `data` is faked by the schema field it is, through aliases,
fragments and nested objects, so `order.user.id`, `order.userId` and `user.id`
are one fake, and a person's email is the database's fake through the shared
store. A field asked for twice, by two fragments or twice by name, is one
field with its selections merged. An object of an interface or a union is
faked by its own type: Sosie asks each one its `__typename`, under an alias of
its own (`sosieTypename_`) the client never sees, and an object that does not
say, or names a type it cannot be, comes back `null`. So a `User` under
`node(id:)` fakes its id as `User.id`, and a union member never passes by
another type's rule. `__typename` comes back as the schema names it. A list
keeps its first `--max-rows` items, and the response's `extensions.sosie` says
the rest were cut; a large answer is faked a slice at a time, a large JSON
value in it too. An integer beyond 2^53 (a `BigInt` or `Long` scalar sent as a
number) is read and written as its digits, so its fake leads back.

Errors: since Sosie checked the query and its variables itself, anything the API
says beyond that may quote data, whether it ran the query (`data` is there) or
not. Every message is replaced by Sosie's; an error's `path` comes back when it
is made of the query's own keys and positions in a list Sosie would show, its
`extensions.code` when it is a code servers use (`FORBIDDEN`,
`validation-failed`), or made only of words that say what failed and what
about, the schema's own names among them (`ACCESS_DENIED`, `ORDER_NOT_FOUND`);
nothing else does, so a code with a digit or a word of data
(`USER_7739182046_NOT_FOUND`, `QUILLON_FORBIDDEN`) is dropped. An answer that
is not JSON is `502`, without its content type. A `401` or `403` from the API
tells the terminal to check `SOSIE_UPSTREAM_HEADERS`.

### Query by what you saw

Each argument, and each variable where it is used, is looked up in the field it
names on the type its field returns: `user(id:)` in `User.id`,
`users(email:)` in `User.email`, `orders(userId:)` in `User.id`,
`users(role: viewer)` and `users(active: false)` as the label and the boolean
they show; inside input objects and lists too, where a key that names no field
(an operator: `where: { id: { _eq: 8 } }`) compares with the field around it,
and in a variable's default. On an interface or a union, in
that field of each type it may be, when they agree: `node(id:)` in `User.id`,
`Order.id` and the rest. Text it names no field for is looked up anywhere; a
number that names no field (`first: 10`) stays as written; a directive's
argument (`@include(if:)`) is left alone. A value compared with a field that
passes is real already, and stays as written, as for REST. A variable has one
value for all its uses, so it is looked up in the fields of every use at once:
it is real only when they agree, and stays as written when any use compares it
with a field that passes. Only the operation that runs, and the fragments it
uses, count; only the variables it declares are sent.

### Limits

- A JSON scalar's keys that look like words (`{ "jdoe": … }`) stay, as a json
  column's do, unless the request turned that word back.
- The schema, its descriptions included, is visible: it is the API, not its
  data.
- A query field that writes is the API's to guard: Sosie sends every query on,
  as REST sends every `GET`.

## Adding a source after v0.1

A new source is a package that exports a `Source`. It decides how clients talk
to it and how its upstream is read; it calls the core for every value it
returns and every value a client sends. What each planned source maps:

| Source | Endpoint for clients | Read-only guard | Field of a value |
| --- | --- | --- | --- |
| REST (built, above) | A local HTTP address; paths as upstream | `GET` and `HEAD` only | The OpenAPI document when there is one; otherwise where the value sits |
| GraphQL (built, above) | A local HTTP address, at the API's path | Queries only, no mutations | The schema, by introspection or a file |
| MySQL | MySQL's wire protocol | Reads only, read-only session | Its result metadata, as with Postgres |

Rules, domains, fakes, the store, `scan` and `describe` stay as they are. Format
domains make a person's email the same fake from the database and from the API.

## Tests

`npm run check` typechecks, builds and runs every test.

- **Core, without Postgres.** A memory source in `test/memory-source` serves
  rows from fixtures with canary values. Rules, domains, every type's faker,
  lookups, scrubbing, the store, `scan` and the MCP server are tested through
  it and in `packages/core/test`. This is also the proof that the core needs no
  particular source.
- **Postgres, end to end.** An embedded PostgreSQL 18, or the server in
  `SOSIE_TEST_DATABASE_URL`, seeded with canary values: unique emails, names,
  phone numbers, keys and numbers; values with nothing to fake (`''`, `-`,
  `NaN`, `infinity`); and functions that write, or raise row values. A read-only role reads it, as a developer
  would set up. Every output and error is searched for each canary; any match
  fails the run.
- **Consistency.** Joins through faked keys match; views and their tables
  agree; lookups by a fake in literals, parameters, `IN` lists and arrays find
  their rows; the same fakes come back in the next session.
- **Drivers.** `psql` (with `\d`), `node-postgres`, `postgres.js`, Drizzle over
  both, and Prisma 7 through its node-postgres adapter. The psql tests skip
  where psql is missing, except in CI.
- **REST, end to end.** A fake API under `/v1` wants a bearer token and serves
  the database's canary people as JSON: an envelope, a map keyed by email, a
  map the document declares, links with canaries in every part, an image, a
  long list, an error that quotes a canary; with and without an OpenAPI
  document. A redirect away goes to a recording server, which must receive
  nothing. A person's email is the same fake from the database and from the
  API.
- **GraphQL, end to end.** A fake GraphQL API built with graphql-js serves the
  same people: relations both ways, an interface and a union, aliases,
  fragments that ask a field twice, variables, batches, a mutation that must
  never run, a resolver whose error quotes a canary, a server that refuses
  without `data` and quotes canaries, a redirect to a recording server, and
  introspection on and off. Fakes the client saw are sent back in variables of
  the wrong type and through introspection: no canary may come back.
- **The CLI.** The built CLI is run: start against a database and an API, MCP
  over stdio, `scan`, Ctrl+C, and the errors a developer meets first.
- **The dependency rule.** A test reads the imports and manifests.
- **CI.** PostgreSQL 15, 16, 17 and 18 on Node 26; 18 on Node 24.

## Defaults

| Setting | Default |
| --- | --- |
| Address | 127.0.0.1:7674 (7674 spells "sosi" on a phone keypad), and ::1, where `localhost` often goes first; a port another program holds on ::1 counts as taken |
| Rows per query; items per list of an API's answer | 1,000 |
| Rows per MCP query | 200 |
| Statement timeout upstream | 30 s |
| Store | `$SOSIE_HOME`, or `~/.sosie` |

## Open items

- Binary result formats, for drivers that ask for them (asyncpg, pgx, JDBC
  after its prepare threshold).
- Enum arrays a query computes come back as `NULL`; enum array columns are
  faked.
- Prisma's own schema engine (`prisma db pull`, migrations) is not checked:
  migrations write, and `db pull` reads the catalogs, which pass.
