# Sosie: low-level design

How v0.1 is built. The [high-level design](hld.md) says why.

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

One repository, npm workspaces, three packages:

| Package | Published as | Holds |
| --- | --- | --- |
| `packages/cli` | `@sosie/cli` | The CLI, run with `npx @sosie/cli` or installed as the `sosie` command, and the official sources it bundles |
| `packages/core` | `@sosie/core` | Everything that does not depend on a source: the source interface, the neutral schema, rules, faking, the store, `scan`, the MCP server |
| `packages/postgres` | `@sosie/postgres` | The Postgres source: endpoint, guard, rewriting, schema reading |

Later sources are packages of their own in the same scope: `@sosie/rest`,
`@sosie/graphql`, `@sosie/mysql`. The `@sosie` scope is an npm organisation,
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
  cli/src/
    cli.ts           sosie, sosie mcp, sosie scan
    sources.ts       the sources this CLI knows
    prompt.ts        the hidden prompt
test/
  memory-source/     a source that serves rows from memory, for core tests
  e2e/               Postgres, seeded with canary values
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
  /** Where the upstream is, without credentials: 'db.internal:5432/app'. Shown in the terminal, and keys the store. */
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
the upstream URL, in order. v0.1 knows one. Sources from other packages, listed
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
removed on Ctrl+C, and `sosie mcp` skips, and removes, the entry of a process
that is gone.

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
| `json` | Same structure; each leaf faked by its JSON type, in the domain `field.$path`, or the format its key names (an `email` leaf shares `format:email`). Keys: in a json column, a key that looks like a word (`city`, `createdAt`, `address_line1`) stays, and any other (a name, an email, a code) is faked. In JSON a query builds (`json_object_agg`, `jsonb_build_object`, `row_to_json`), a key stays only when it names a column or the client wrote it in the query; keys made from values are faked |
| `array` | Each element faked in the field's domain |
| `ip` | An address from a documentation range |
| `bytes` | Random bytes of the same length; derived, not stored |
| `unknown` | `null` |

Fakes are deterministic: the faker is seeded from the value's keyed hash, so the
same real value gives the same fake in every session.

## Core: store

One SQLite file for every upstream: `~/.sosie/store/store.db`. One store, one
key: a person's email is the same fake from a database and from an API, through
its format domain, as the high-level design promises.

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
- **Several Sosies** share the store, for one upstream or several: SQLite's WAL
  and a busy timeout serialise them, and the first fake stored for a value
  wins.

## Core: `sosie scan`

Reads every text file under the paths given, skipping `.git`, `node_modules`
and binary files. Decodes JSON string escapes, since transcripts are JSON lines
(`email\nkim@…`). Splits each line into words, lower-cased and without the
punctuation around them, and compares every run of one to four words, by
keyed hash, with the store's real values. Only distinctive values are looked
for: one to four words of at least four characters, and numbers of six digits
or more, so years, ports and line numbers are not findings. A run that is also
a fake is not counted: it is what the agent was shown. It never prints the real
value, and exits 1 if it finds one, so CI can run it.

```
  ✗ ~/.claude/projects/app/2026-11-02.jsonl:1203  a real value from users.email
  1 real value found in 412 files.
```

## Core: `sosie mcp`

The core serves `describe` from the neutral schemas under `running/`, one per
running Sosie; each source adds its own tools, which run inside `sosie mcp` and
talk to the newest running endpoint of their kind, so the MCP process never
holds credentials or real values.

| Tool | From | Input | Returns |
| --- | --- | --- | --- |
| `describe` | core | `entity` (optional) | Entities, fields, types, keys, references, and which fields pass |
| `query` | Postgres | `sql` | Up to 200 rows per statement as JSON, the row count, and any notice; every value a consistent fake |

When Sosie is not running, both say so, and how to start it.

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

## Adding a source after v0.1

A new source is a package that exports a `Source`. It decides how clients talk
to it and how its upstream is read; it calls the core for every value it
returns and every value a client sends. What each planned source maps:

| Source | Endpoint for clients | Read-only guard | Field of a value |
| --- | --- | --- | --- |
| REST | A local HTTP address; paths and methods as upstream | `GET` and `HEAD` only | The OpenAPI document when given; otherwise the response's JSON path, until `sosie.yml` names it |
| GraphQL | A local HTTP address | Queries only, no mutations | The schema, by introspection or a file |
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
- **The CLI.** The built CLI is run: start, MCP over stdio, `scan`, Ctrl+C, and
  the errors a developer meets first.
- **The dependency rule.** A test reads the imports and manifests.
- **CI.** PostgreSQL 15, 16, 17 and 18 on Node 26; 18 on Node 24.

## Defaults

| Setting | Default |
| --- | --- |
| Address | 127.0.0.1:7674 (7674 spells "sosi" on a phone keypad), and ::1 |
| Rows per query | 1,000 |
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
