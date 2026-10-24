# Sosie: low-level design

How v0.1 is built. The [high-level design](hld.md) says why.

## Stack

Current versions as of October 2026.

| Need | Choice |
| --- | --- |
| Runtime | Node 26, the LTS line from 28 October 2026 (supported until April 2029). `engines` also allows Node 24, supported until April 2028, so `npx sosie` runs on machines that have not moved yet. Node 22 is out: its support ends in April 2027 |
| Language and tests | TypeScript 7, Vitest 5 |
| Mapping store | `node:sqlite`, built into Node: no native build |
| Fake values | [`@faker-js/faker`](https://github.com/faker-js/faker) 10, seeded per value |
| MCP | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 1.32 |
| Config | [`yaml`](https://github.com/eemeli/yaml) 2.9 |
| Postgres source: client | [`pg`](https://github.com/brianc/node-postgres) 8.23: its result fields carry each column's table and position |
| Postgres source: wire protocol | [`pg-gateway`](https://github.com/supabase-community/pg-gateway) 0.3.0-beta.4, pinned and wrapped in one file so it can be replaced |
| Postgres source: SQL | [`pgsql-parser`](https://github.com/constructive-io/pgsql-parser) 18: Postgres's own parser compiled to WebAssembly, parse and print |
| Upstream databases | PostgreSQL 15 to 18. 19 when it is released (release candidate 1 on 15 October 2026) and the parser supports it. 14 is out: its support ends on 12 November 2026 |

## Packages

One repository, npm workspaces, three packages:

| Package | Published as | Holds |
| --- | --- | --- |
| `packages/sosie` | `sosie` | The CLI people run with `npx`, and the official sources it bundles |
| `packages/core` | `@sosie/core` | Everything that does not depend on a source: the source interface, the neutral schema, rules, faking, the store, `scan`, the MCP server |
| `packages/postgres` | `@sosie/postgres` | The Postgres source: endpoint, guard, rewriting, schema reading |

Later sources are packages of their own in the same scope: `@sosie/rest`,
`@sosie/graphql`, `@sosie/mysql`. The `@sosie` scope is an npm organisation,
registered on 25 October 2026, so nobody else can take a name in it. Its team
`developers` publishes.

**Dependency rule:** `core` depends on no source. A source depends on `core`
only, never on another source. `sosie` depends on `core` and the official
sources. A lint rule enforces it.

```
packages/
  core/src/
    source.ts        the Source interface and the neutral schema
    rules.ts         sosie.yml, checked against the neutral schema
    domains.ts       which domain a field's values fake in
    fake/
      index.ts       Faker: a value, a computed value, a lookup, scrubbing
      types.ts       one faker per neutral type
      formats.ts     field names to realistic formats
    store.ts         mapping store, keys, sealing
    scan.ts          sosie scan
    mcp.ts           the MCP server: describe, and each source's tools
  postgres/src/
    index.ts         the Source: matches postgres://, connects, serves
    endpoint.ts      the only file that knows pg-gateway
    guard.ts         allow reads; refuse writes and some catalogs
    rewrite.ts       fakes in literals and parameters, back to real values
    upstream.ts      pg.Pool, read-only session, timeout, row cap
    schema.ts        pg_catalog to the neutral schema
    results.ts       which field each result column came from
  sosie/src/
    cli.ts           sosie, sosie mcp, sosie scan
    sources.ts       the sources this CLI knows, by upstream scheme
test/
  memory-source/     a source that serves rows from memory, for core tests
  e2e/               Postgres in Docker, seeded with canary values
```

## The source interface

A source is everything that knows one kind of upstream. The core gives it a
`Faker`; it gives the core a schema and an endpoint.

```ts
export interface Source {
  /** 'postgres' now; 'rest', 'graphql', 'mysql' later. */
  readonly kind: string
  /** Whether this source handles this upstream: postgres:// and postgresql://. */
  matches(upstream: URL): boolean
  /** Connect read-only and describe the upstream in neutral terms. */
  connect(upstream: URL, options: SourceOptions): Promise<Connection>
}

export interface Connection {
  readonly schema: Schema
  /** Start the endpoint clients use. Every value it returns goes through the Faker. */
  serve(listen: { host: string; port: number }, faker: Faker): Promise<Endpoint>
  /** MCP tools this source adds beside the core's describe: Postgres adds query. */
  tools?(faker: Faker): McpTool[]
  close(): Promise<void>
}

export interface Endpoint {
  /** What the CLI prints for clients: postgres://localhost:7674/app. */
  readonly address: string
  close(): Promise<void>
}
```

The core's half:

```ts
export interface Faker {
  /** The fake of a value read from a field. Null stays null. */
  value(value: unknown, field: Field): unknown
  /** The fake of a value no field holds (length(email), now()). */
  computed(value: unknown, type: FieldType): unknown
  /** The real value behind a fake a client sent, if it names exactly one. */
  lookup(fake: string | number, near?: Field): unknown | undefined
  /** A scope per request, so its errors can be scrubbed of what it substituted. */
  request(): RequestScope
}

export interface RequestScope {
  lookup(fake: string | number, near?: Field): unknown | undefined
  /** Text with every real value this request substituted turned back into its fake. */
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
  references?: string         // the id of the key field it points to
}
export type FieldType =
  | { kind: 'string'; maxLength?: number }
  | { kind: 'integer' }
  | { kind: 'decimal'; scale?: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; labels: string[] }
  | { kind: 'date' | 'datetime' | 'time' }
  | { kind: 'uuid' | 'json' | 'bytes' | 'ip' }
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

Flags for `sosie`: `--port` (7674), `--host` (127.0.0.1), `--rules` (`./sosie.yml`
when present), `--max-rows` (1000). `sosie mcp` finds the running endpoint
through `~/.sosie/current.json`, which holds the local address only.

The connection string is never an argument: arguments show in shell history and
in the process list, where an agent can read them.

```
  ✓ db.internal/app, read-only: 42 tables
  ✓ Every value is faked; 3 fields pass (sosie.yml)

  Your agent, app and psql:  postgres://localhost:7674/app
  Claude Code:               claude mcp add sosie -- npx sosie mcp
```

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

An unknown key, entity or field is an error at start-up that names it, so a
typo never passes data silently:
`sosie.yml: users.emial is not a field. Did you mean users.email?`

## Start-up

1. Read the upstream; pick the source that matches it.
2. `connect`: the source opens a read-only connection and returns the neutral
   schema.
3. Load `sosie.yml` and check it against the schema.
4. Open the store for this upstream, creating its key on first use.
5. `serve` on 127.0.0.1; write `~/.sosie/current.json`; print the address.

## Core: domains

A domain is the set of real values that share fakes. For a field:

1. Listed under `pass`: no domain, the value passes.
2. It references a key: the key's domain, so `orders.user_id` fakes like
   `users.id`.
3. Its format is personal (email, phone, first name, last name, full name,
   street, city, postal code): the format's domain, so one person's email is
   the same fake in every field, and later in every source.
4. Otherwise: the field's own id.

## Core: fakes by type

| Neutral type | Fake |
| --- | --- |
| `string` | The field's format when known, else words of about the same length, within `maxLength` |
| `integer`, `decimal` | A number with the same sign, number of digits and scale |
| `uuid` | A random UUID |
| `boolean` | Flipped or not, decided once per domain by its key |
| `enum` | Another label of the same enum, by a fixed shuffle per domain |
| `date`, `datetime`, `time` | Shifted by up to a year, the same shift for the same value |
| `json` | Same keys and structure; each leaf faked by its JSON type, in the domain `field.$path` |
| `array` | Each element faked in the field's domain |
| `ip` | An address from a documentation range |
| `bytes` | Random bytes of the same length |
| `unknown` | `null` |

Fakes are deterministic: the faker is seeded from the value's keyed hash, so the
same real value gives the same fake in every session.

## Core: store

One SQLite file per upstream: `~/.sosie/<id>/store.db`, where `<id>` is the first
12 hex digits of the SHA-256 of the upstream's host, port and name.

```sql
CREATE TABLE value (
  domain TEXT NOT NULL,   -- 'users.email', 'users.id', 'format:email'
  mac    BLOB NOT NULL,   -- HMAC-SHA256(key, real value)
  fake   TEXT NOT NULL,
  sealed BLOB NOT NULL,   -- AES-256-GCM(real value), for queries by a fake
  PRIMARY KEY (domain, mac)
);
CREATE INDEX value_fake ON value (fake);

CREATE TABLE word (
  mac BLOB PRIMARY KEY    -- HMAC of each word of 4 or more letters inside a real text value
);
```

- **Keys.** `~/.sosie/<id>/key` holds 32 random bytes, created on first start
  with mode 0600. The HMAC and sealing keys are derived from it with HKDF.
- **Allocation.** The fake is drawn from a seed taken from the value's keyed
  hash. For keys and text, a fake is unique within its domain: if it is taken,
  the seed advances, and a numeric key whose digit range fills up gets one more
  digit. Other numbers only need to be consistent, so two real values may share
  a fake.
- **Booleans and enums** are not stored; their fakes come from the key alone.
- **Lookup.** A fake that names exactly one real value is used. A fake that
  names several (small numbers repeat) is resolved by the field the client
  compared it with, when the source can say, and otherwise left as written.

## Core: `sosie scan`

Reads every file under the paths given. Splits text into candidates: emails,
UUIDs, numbers of 4 or more digits, and words of 4 or more letters. Hashes each
with the key and looks it up in `value` and `word`. It never prints the real
value, and exits 1 if it finds one, so CI can run it.

```
  ✗ ~/.claude/projects/app/2026-11-02.jsonl:1203  a real value from users.email
  1 real value found in 412 files.
```

## Core: `sosie mcp`

The core serves `describe` from the neutral schema; each source adds its own
tools.

| Tool | From | Input | Returns |
| --- | --- | --- | --- |
| `describe` | core | `entity` (optional) | Entities, fields, types, keys and references |
| `query` | Postgres | `sql` | Up to 200 rows as JSON, and a note that every value is a consistent fake |

## Postgres source

### Endpoint

Supported: start-up without TLS (it listens on 127.0.0.1), no password, the
simple query protocol, and the extended protocol (Parse, Bind, Describe,
Execute, Sync, Close) with results in text format. Refused with a clear error:
`COPY`, `LISTEN` and `NOTIFY`, and binary result formats.

### Upstream

A `pg.Pool` whose sessions set `default_transaction_read_only = on` and
`statement_timeout = 30s`. At most `--max-rows` rows are read per query, with a
notice when the cap cuts a result.

### Schema

Tables, columns, types, enum labels, primary and unique keys, and foreign keys,
read once from `pg_catalog` and mapped to the neutral schema. Field ids are
`table.column`, or `schema.table.column` outside `public`.

| Postgres | Neutral |
| --- | --- |
| `text`, `varchar`, `char`, `citext` | `string` (with `maxLength`) |
| `int2`, `int4`, `int8` | `integer` |
| `numeric`, `float4`, `float8` | `decimal` |
| `bool` | `boolean` |
| An enum type | `enum` |
| `date`, `timestamp`, `timestamptz`, `time` | `date`, `datetime`, `time` |
| `uuid`, `json`, `jsonb`, `bytea`, `inet`, `cidr` | `uuid`, `json`, `json`, `bytes`, `ip`, `ip` |
| Arrays of any of these | `array` |
| Anything else | `unknown` |

### Guard

Each statement is parsed. Allowed: `SELECT` and `WITH` without `INTO`,
`FOR UPDATE` or `FOR SHARE`; `SHOW`; `SET` for session settings; `BEGIN` and
`COMMIT`, which drivers send. Refused: everything else, including `EXPLAIN`,
whose plan would print the real values Sosie substituted.

Refused relations, because they store real values: `pg_stats`, `pg_statistic`,
`pg_stat_activity`, `pg_stat_statements`. Refused functions: `inet_server_addr`,
`inet_server_port`, `pg_read_file` and the like. The session is read-only too,
so a statement the guard misses still cannot write.

### Rewriting

Every string and number constant in the parsed statement, and every Bind
parameter, is passed to `RequestScope.lookup`, with the column it is compared to
when the statement shows one. A real value found replaces the fake, and the
statement is printed back to SQL.

### Results

`pg` reports each result column's source table OID and column number, which
name the field, even through `SELECT *`, aliases and joins.

| The result column | Goes to |
| --- | --- |
| A table column | `Faker.value` with its field |
| A computed value | `Faker.computed` with its type |
| The result of `count(…)` | Unchanged: it holds no value from a row |
| From a query that reads only the catalogs | Unchanged: names of tables and columns, which drivers read when they start |

### Errors

An upstream error's message goes through `RequestScope.scrub`; its detail, hint
and context fields are dropped, because they quote rows.

| Situation | Message |
| --- | --- |
| A write | `This statement changes data. Sosie is read-only.` |
| A refused catalog | `pg_stats holds real values from your tables, so Sosie does not read it.` |
| Upstream unreachable | `Cannot reach db.internal:5432. Sosie needs SOSIE_UPSTREAM to point at your database.` |

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

- **Core, without Postgres.** A memory source in `test/memory-source` serves
  rows from fixtures. Rules, domains, every type's faker, lookups, scrubbing,
  the store and `scan` are tested through it. This is also the proof that the
  core needs no particular source.
- **Postgres, end to end.** PostgreSQL 15 to 18 in Docker, seeded with canary
  values: unique emails, names and numbers. Queries run through `psql`,
  `node-postgres` and `sosie mcp`. Every output is searched for each canary;
  any match fails the run.
- **Consistency.** A join through faked keys returns the same rows as on the
  real database; a lookup by a fake finds its row.
- **Drivers.** Prisma and Drizzle against the endpoint before v0.1.
- **CI.** Node 26 and Node 24.

## Defaults

| Setting | Default |
| --- | --- |
| Address | 127.0.0.1:7674 (7674 spells "sosi" on a phone keypad) |
| Rows per query | 1,000 |
| Rows per MCP query | 200 |
| Statement timeout upstream | 30 s |

## Open items

- Whether `pg-gateway` covers the extended protocol well enough, or a small
  endpoint of our own is simpler. `endpoint.ts` keeps the choice open.
- How Prisma's engine asks for result formats, and whether text-only holds.
