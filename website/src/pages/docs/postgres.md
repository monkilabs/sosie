---
layout: ../../layouts/Docs.astro
title: Postgres
description: Sosie in front of PostgreSQL 15 to 18 - the wire protocol, which clients work, what the guard allows, and the limits.
lead: A local endpoint that speaks the Postgres protocol. psql, your ORM and any Postgres MCP server connect to it unchanged.
---

## Start it

```sh
export SOSIE_UPSTREAM='postgres://readonly:…@db.internal:5432/app'
npx @sosie/cli
```

```
  ✓ db.internal:5432/app, read-only: 42 tables, 3 views
  ✓ Every value is faked; 3 fields pass (sosie.yml)

  Your agent, app and psql:  postgres://localhost:7674/app
```

The address takes any user and database name and no password. It listens on `127.0.0.1` and `::1` only, unless you
pass `--host`.

## A read-only login

Sosie's session is read-only from its start-up options, and its guard refuses writes, but a login that cannot write is
safer. Sosie warns when its login can write, or is a superuser.

```sql
CREATE ROLE sosie_reader LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE app TO sosie_reader;
GRANT USAGE ON SCHEMA public TO sosie_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sosie_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sosie_reader;
```

> **Row-level security.** A table with row-level security on shows a login only the rows its policies allow. With no
> policy for this login, as on a Supabase project with RLS on and no policies, it sees no rows: give it a policy, or
> `BYPASSRLS`.

## Clients

Tested with `psql` (including `\d`), `node-postgres`, `postgres.js`, Drizzle over both, and Prisma 7 through its
node-postgres adapter. The simple and extended query protocols work, with results in text format, as do cursors,
prepared statements and cancel requests.

Not yet: drivers that ask for **binary results** (asyncpg, pgx, JDBC after its prepare threshold) get an error that says
so. `COPY` and function calls are refused.

## What the guard allows

Each statement is parsed before it goes anywhere.

- **Allowed:** `SELECT` and `WITH` without `INTO`, data-changing CTEs or row locks; `SHOW`; `SET` and `RESET`;
  transactions and savepoints; cursors; `PREPARE`, `EXECUTE`, `DEALLOCATE`, `DISCARD`.
- **Refused:** everything else, including `EXPLAIN`, whose plan would print the real values Sosie substituted. A
  statement that changes data gets `This statement changes data. Sosie is read-only.`
- **Refused catalogs:** the ones that hold real values, queries with their values, credentials or where the database
  is: `pg_stats`, `pg_statistic`, `pg_stat_activity`, `pg_stat_statements`, `pg_settings`, `pg_authid` and the like.
- **Refused settings and functions:** those that say where the database is (`inet_server_addr`, `SHOW port`), read
  files, run SQL given as text, or copy a value into a setting (`set_config`).
- **Settings that keep the session safe** cannot be changed: read-only, the role, and a statement timeout above the one
  Sosie started with.

Catalog reads that touch no user table, such as `\d` in psql or an ORM reading the schema, pass unchanged.

## The session upstream

One connection upstream per client, read-only from its start, with:

| Setting | Value |
| --- | --- |
| `default_transaction_read_only` | `on` |
| `statement_timeout` | 30 s; a client may lower it, never lift it |
| `idle_in_transaction_session_timeout` | 5 min, so a transaction an agent leaves open does not hold locks |
| Rows per query | `--max-rows`, 1,000 by default; a result cut at the cap ends with a notice |

## Query by what you saw

Constants and parameters compared by equality (`=`, `<>`, `IN`, `= ANY`, `IS DISTINCT FROM`) are looked up in the
domain of the column on the other side, through aliases, schemas and subqueries. A statement with nothing to turn back
goes upstream exactly as the client wrote it.

```sql
SELECT o.id, o.total FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = 'van29@example.com';
```

## What each result column becomes

| The result column | Becomes |
| --- | --- |
| A table's column, through `SELECT *`, aliases, joins, subqueries, CTEs and views | A fake by its field |
| A view's column that selects a table's column unchanged | A fake in that column's domain |
| `count(…)` over rows from tables | Unchanged: it holds no value from a row |
| A constant the client wrote | Unchanged |
| A system catalog's column | Unchanged |
| Anything else a query computes (`length(email)`, `max(id)`, `data->>'city'`) | A fake by its type |

## Errors

What an upstream error says depends on when Postgres raised it, because no pattern finds every value a message may
quote.

- **Before any row is read**, while Postgres parses and plans, a message holds only what the client wrote and the
  schema. It comes back with every value Sosie substituted turned back into its fake.
- **While rows are read**, only the error's code comes back, with what it means:
  `invalid text representation (22P02): Sosie hides the rest of this message, which may quote a value from your rows.`
- **From a function in the database**, the text is always hidden: `RAISE EXCEPTION` can say anything.

Detail and context are always dropped.

## Limits

- Order and ranges follow the real values: `ORDER BY` sorts by them, and `>` or `BETWEEN` compare them.
- `LIKE` and other partial matches filter the real values, so a piece of a fake finds nothing.
- A bare boolean condition (`WHERE active`) filters the real values, while the fakes may show flipped ones;
  `active = true` is turned back.
- A value Sosie never showed is used as written, so it filters on the real value it happens to be.
- Values passed to a prepared statement in SQL (`EXECUTE p('…')`) are used as written; fakes in Bind parameters are
  turned back.
- Composite values (`SELECT u FROM users u`) and types Sosie does not know come back as `NULL`.
- Rows fetched from a cursor are faked by type, not by field: consistent, but not in the field's format.
- A json column keyed by lowercase words that are data (usernames) keeps those keys, since they look like structure.
