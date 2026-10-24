# Sosie: low-level design

How v0.1 is built. The [high-level design](hld.md) says why.

## Stack

| Need | Choice |
| --- | --- |
| Runtime | Node 22 LTS, TypeScript, published to npm as `sosie` |
| Postgres wire protocol, server side | [`pg-gateway`](https://github.com/supabase-community/pg-gateway) 0.3, pinned and wrapped in one module so it can be replaced |
| Upstream client | [`pg`](https://github.com/brianc/node-postgres) 8: its result fields carry each column's table and position |
| SQL parsing and printing | [`pgsql-parser`](https://github.com/constructive-io/pgsql-parser) 18: Postgres's own parser compiled to WebAssembly, so there is no native build |
| Fake values | [`@faker-js/faker`](https://github.com/faker-js/faker) 10, seeded per value |
| Mapping store | `node:sqlite`, built into Node |
| MCP | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 1.x |
| Tests | Vitest; Postgres in Docker for end-to-end tests |

## Layout

```
src/
  cli.ts             sosie, sosie mcp, sosie scan
  config.ts          sosie.yml, environment, defaults
  endpoint.ts        the only file that knows pg-gateway
  guard.ts           parse; allow reads; refuse writes and some catalogs
  rewrite.ts         fakes in literals and parameters, back to real values
  upstream.ts        pg.Pool, read-only session, timeout, row cap
  schema.ts          tables, columns, types, enums, foreign keys
  fake/
    index.ts         result column to rule; fake a row
    types.ts         one faker per Postgres type
    names.ts         column names to realistic formats
  store.ts           mapping store, keys, sealing
  scan.ts            sosie scan
  mcp.ts             sosie mcp
test/
  e2e/               Docker Postgres seeded with canary values
```

## CLI

| Command | What it does |
| --- | --- |
| `sosie` | Start the endpoint. Reads `SOSIE_UPSTREAM`, or asks for it at a hidden prompt |
| `sosie mcp` | MCP server over stdio, connected to the running endpoint |
| `sosie scan <path>…` | Search files and folders for real values; exit 1 if one is found |

Flags for `sosie`: `--port` (7674), `--host` (127.0.0.1), `--rules` (`./sosie.yml`
when present), `--max-rows` (1000). `sosie mcp` takes `--url`, defaulting to the
endpoint the running `sosie` recorded in `~/.sosie/current.json`, which holds
the local address only.

The connection string is never an argument: arguments show in shell history and
in the process list, where an agent can read them.

Start-up output:

```
  ✓ db.internal/app, read-only: 42 tables
  ✓ Every value is faked; 3 columns pass (sosie.yml)

  Your agent, app and psql:  postgres://localhost:7674/app
  Claude Code:               claude mcp add sosie -- npx sosie mcp
```

## `sosie.yml`

Optional. Committed with the code.

```yaml
# Columns whose values pass unchanged.
pass:
  - orders.status
  - products.price
  - countries.*

# Formats for columns Sosie cannot tell from their names.
format:
  users.handle: username
  accounts.iban: iban
```

Unknown keys, tables or columns are errors at start-up, with the name that does
not exist, so a typo never passes data silently.

## Start-up

1. Read the connection string; refuse to start if it points at
   `localhost:7674` (Sosie itself).
2. Open the upstream pool. Each session sets `default_transaction_read_only = on`
   and `statement_timeout = 30s`.
3. Load the schema: tables, columns, types, enum labels and foreign keys from
   `pg_catalog`, keyed by table OID and column number.
4. Load and check `sosie.yml` against the schema.
5. Open the store for this database, and create its key on first use.
6. Listen on 127.0.0.1, write `~/.sosie/current.json`, print the address.

## Endpoint

Supported: start-up without TLS (it listens on 127.0.0.1), no password, the
simple query protocol, and the extended protocol (Parse, Bind, Describe,
Execute, Sync, Close) with results in text format.

Refused with a clear error: `COPY`, `LISTEN` and `NOTIFY`, and binary result
formats. The database name a client asks for is accepted; there is one upstream
database.

## Guard

Each statement is parsed. Allowed:

- `SELECT` and `WITH` without `INTO` and without `FOR UPDATE` or `FOR SHARE`
- `SHOW`, `SET` for session settings, `BEGIN` and `COMMIT` (ORMs send them)

Refused: anything else, including `EXPLAIN`, whose plan would print the real
values Sosie substituted.

Refused relations, because they store real values: `pg_stats`, `pg_statistic`,
`pg_stat_activity` and `pg_stat_statements`. Refused functions:
`inet_server_addr`, `inet_server_port`, `pg_read_file` and the like.

The upstream session is read-only as well, so a statement the guard misses still
cannot write.

## Rewriting fakes back to real values

The agent copies what it sees, so its queries contain fakes.

- **Literals.** Walk the parsed statement; every string and number constant
  that the store knows as a fake is replaced by its real value; print the
  statement back to SQL.
- **Parameters.** In Bind, each parameter value the store knows as a fake is
  replaced the same way.
- **Per statement, Sosie keeps what it substituted,** to scrub errors (below).

A fake is looked up across all domains. When it stands for exactly one real
value, that value is used. When it stands for several (small numbers repeat
across columns), Sosie uses the column the literal is compared with, if the
parsed statement shows one (`users.age = 7`), and otherwise leaves the literal as
written.

## Faking results

For each result column, `pg` reports the source table's OID and the column's
position. That is how Sosie knows which column a value came from, even
through `SELECT *`, aliases and joins.

| The result column | Rule |
| --- | --- |
| A table column listed under `pass` | Unchanged |
| Any other table column | Faked by its type, in its domain |
| A computed value (`length(email)`, `now()`) | Faked by its type, in the domain `computed` |
| The result of `count(…)` | Unchanged: it holds no value from a row |
| From a query that reads only the catalogs | Unchanged: names of tables and columns, which ORMs read to start |

**Domains.** A column's domain is `table.column`. A foreign key column uses the
domain of the column it references, so related ids get the same fake.

## Fakes by type

| Postgres type | Fake |
| --- | --- |
| `text`, `varchar`, `char`, `citext` | The format the column's name points to (email, first or last name, full name, phone, street, city, postal code, URL, company), else words of about the same length. Same length limit as the column |
| `int2`, `int4`, `int8`, `numeric` | A number with the same sign, number of digits and scale |
| `uuid` | A random UUID |
| `bool` | Flipped or not, decided once per column by its key |
| An enum | Another label of the same enum, by a fixed shuffle per column |
| `date`, `timestamp`, `timestamptz`, `time` | Shifted by up to a year, the same shift for the same value |
| `json`, `jsonb` | Same keys and structure; each leaf faked by its JSON type, in the domain `table.column.$path` |
| Arrays | Each element faked in the column's domain |
| `inet`, `cidr` | An address from a documentation range |
| `bytea` | Random bytes of the same length |
| Anything else | `NULL` |

`NULL` stays `NULL`. Fakes are deterministic: the faker is seeded from the
value's keyed hash, so the same real value gives the same fake in every session.

## Store

One SQLite file per upstream database: `~/.sosie/<id>/store.db`, where `<id>` is
the first 12 hex digits of the SHA-256 of host, port and database name.

```sql
CREATE TABLE value (
  domain TEXT NOT NULL,   -- 'users.email', or 'users.id' for every key pointing to it
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
- **Allocation.** A fake is generated from a seed taken from the value's keyed
  hash. For keys (primary, unique or referenced columns) and text, a fake must
  be unique within its domain: if it is taken, the seed is advanced and the fake
  drawn again, and a numeric key whose digit range fills up gets one more digit.
  Other numbers only need to be consistent, so two real values may share a fake.
- **Booleans and enums** are not stored: their fakes come from the key alone.

## `sosie scan`

Reads every file under the paths given. Splits text into candidates: emails,
UUIDs, numbers of 4 or more digits, and words of 4 or more letters. Hashes each
with the key and looks it up in `value` and `word`.

```
  ✗ ~/.claude/projects/app/2026-11-02.jsonl:1203  a real value from users.email
  1 real value found in 412 files.
```

It never prints the real value. It exits 0 when nothing is found and 1
otherwise, so CI can run it.

## `sosie mcp`

| Tool | Input | Returns |
| --- | --- | --- |
| `describe` | `table` (optional) | Tables, columns, types and foreign keys |
| `query` | `sql` | Up to 200 rows as JSON, and a note that every value is a consistent fake |

## Errors

The upstream error's message is shown with every value Sosie substituted
replaced by its fake. Its detail, hint and context fields are dropped, because
they quote rows.

| Situation | Message |
| --- | --- |
| A write | `This statement changes data. Sosie is read-only.` |
| A refused catalog | `pg_stats holds real values from your tables, so Sosie does not read it.` |
| Too many rows | Returns the first 1,000 and adds a notice: `Returned 1,000 rows (--max-rows).` |
| A typo in `sosie.yml` | `sosie.yml: users.emial is not a column. Did you mean users.email?` |
| Upstream unreachable | `Cannot reach db.internal:5432. Sosie needs SOSIE_UPSTREAM to point at your database.` |

## Tests

- **Unit.** Guard, rewriter, every type's faker, the store and the scanner.
- **End to end.** Postgres in Docker, seeded with canary values: unique emails,
  names and numbers. Queries run through `psql`, `node-postgres` and `sosie mcp`.
  Every output is searched for each canary; any match fails the run.
- **Consistency.** A join through faked keys returns the same rows as the
  join on the real database. A lookup by a fake finds its row.
- **Drivers.** Prisma and Drizzle against the endpoint before v0.1.

## Defaults

| Setting | Default |
| --- | --- |
| Address | 127.0.0.1:7674 (7674 spells "sosi" on a phone keypad) |
| Rows per query | 1,000 |
| Rows per MCP query | 200 |
| Statement timeout upstream | 30 s |

## Open items

- Whether `pg-gateway` covers the extended protocol well enough, or a small
  frontend of our own is simpler. The wrapper in `endpoint.ts` keeps the choice
  open.
- How Prisma's engine asks for result formats, and whether text-only holds for
  it.
