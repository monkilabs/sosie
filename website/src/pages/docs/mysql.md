---
layout: ../../layouts/Docs.astro
title: MySQL
description: Sosie in front of MySQL 8.4 and 9 - the protocol, which clients work, what the guard allows, and the limits.
lead: A local endpoint that speaks MySQL's protocol. The mysql client, your app and its tests connect to it unchanged.
---

> **Not in 0.1.1.** MySQL comes with the next release of `@sosie/cli`.

## Start it

```sh
export SOSIE_UPSTREAM='mysql://readonly:…@db.internal:3306/app'
npx @sosie/cli
```

```
  ✓ db.internal:3306/app, read-only: 42 tables, 3 views
  ✓ Every value is faked

  Your agent, app and mysql:  mysql://127.0.0.1:7674/app
```

The address takes any user and no password, and listens on `127.0.0.1` and `::1` only, unless you pass `--host`. It is
`127.0.0.1`, not `localhost`: MySQL's own client takes `localhost` for its Unix socket.

```sh
mysql --protocol=tcp -h 127.0.0.1 -P 7674 app
```

`?ssl-mode=REQUIRED` (or `VERIFY_CA`, `VERIFY_IDENTITY`) on `SOSIE_UPSTREAM` makes the connection upstream use TLS.
Sosie's own address speaks no TLS: it is on your machine.

MySQL 8.4 and 9 are tested; 8.0 is read. MariaDB is not, yet.

## A read-only login

Sosie's session is read-only from its start, and its guard refuses writes, but a login that cannot write is safer.
Sosie warns when its login can change data, is an administrator, or may read files (`FILE`).

```sql
CREATE USER 'sosie_reader'@'%' IDENTIFIED BY '…';
GRANT SELECT, SHOW VIEW ON app.* TO 'sosie_reader'@'%';
```

`SHOW VIEW` lets Sosie see which tables a view reads, so a view's columns share their tables' fakes. Without it, a
view's column shares a table's fakes only where one table of the database has a column of that name, and Sosie says so
when it starts.

## Clients

Tested with the `mysql` client and mysql2. Each statement is sent as text, with `COM_QUERY`, one per query, as both
send them.

Not yet: **prepared statements** (`COM_STMT_PREPARE`), which mysql2's `execute()`, Prisma, and Go's driver with
arguments use. They get an error that says so; send the statement as text (`query()` in mysql2). Several statements in
one query are refused too: send them one at a time.

## What the guard allows

Each statement is parsed, by the MySQL dialect of [sqlparser](https://github.com/apache/datafusion-sqlparser-rs)
compiled to WebAssembly, before it goes anywhere. It reads executable comments (`/*!50000 … */`) as MySQL runs them.
A statement it cannot parse is refused.

- **Allowed:** `SELECT` and `WITH` without `INTO` or row locks; `SHOW TABLES`, `COLUMNS`, `CREATE TABLE`, `INDEX` and
  the like; `DESCRIBE`; `USE`; transactions; `SET` of the session's own settings, to a value written in the query.
- **Refused:** everything else. A statement that changes data gets `This statement changes data. Sosie is read-only.`
  `EXPLAIN` is refused too: a plan would print the real values Sosie puts in your query.
- **Refused databases and tables:** `mysql` (password hashes, query logs), `performance_schema` and `sys` (queries
  with their values), and from `information_schema` the process list, column statistics (histograms of real values),
  open transactions and where the files are.
- **Refused functions and settings:** `LOAD_FILE()`, locks other sessions wait on (`GET_LOCK()`), and settings that say
  where the database is (`@@datadir`, `@@hostname`, `@@port` and the like). `SHOW VARIABLES` and `SHOW PROCESSLIST` too.
- **Settings that keep the session safe** cannot be changed: read-only, `sql_mode`'s `ANSI_QUOTES`,
  `NO_BACKSLASH_ESCAPES` and `PIPES_AS_CONCAT`, which change how a statement is read, and a `max_execution_time`
  above the one Sosie started with.

## The session upstream

One connection upstream per client, read-only from its start, with:

| Setting | Value |
| --- | --- |
| `transaction_read_only` | `ON` |
| `max_execution_time` | 30 s; a client may lower it, never lift it |
| `sql_mode` | The server's, without the modes that change how a statement is read |
| `sql_select_limit` | One more than `--max-rows`: a result cut at the cap says so in `SHOW WARNINGS` |

## Query by what you saw

Literals compared by equality (`=`, `<>`, `<=>`, `IN`) are looked up in the domain of the column on the other side,
through aliases, databases, subqueries and an introducer such as `_utf8mb4'…'`. Only the literals turned back change:
the rest of the statement goes upstream exactly as the client wrote it.

```sql
SELECT o.id, o.total FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = 'van29@example.com';
```

## What each result column becomes

MySQL names the database, table and column of each result column. Whether a value is faked rests on that, not on how
Sosie read the statement.

| The result column | Becomes |
| --- | --- |
| A table's column, through `SELECT *`, aliases, joins, derived tables and CTEs | A fake by its field |
| A view's column | A fake by its field, in its table's domain when Sosie can tell which column it shows |
| `COUNT(…)`, and a literal the client wrote | Unchanged |
| `information_schema`, `SHOW` and `DESCRIBE` | Unchanged |
| Anything else a query computes (`UPPER(email)`, `MAX(id)`) | A fake by its type |

## Errors and warnings

- An error about the statement itself (a syntax error, an unknown column or table, access denied) comes back, with
  every value Sosie substituted turned back into its fake.
- Any other error comes back as its code only: `Error 1292: Sosie hides the rest of this message, which may quote a
  value from your rows.`
- `SHOW WARNINGS` hides each warning's message the same way: MySQL's warnings quote values (`Truncated incorrect
  INTEGER value: '…'`).

## Limits

- Order and ranges follow the real values: `ORDER BY` sorts by them, and `>` or `BETWEEN` compare them.
- `LIKE` and other partial matches filter the real values, so a piece of a fake finds nothing.
- A value Sosie never showed is used as written, so it filters on the real value it happens to be.
- A literal compared with a column through a function (`LOWER(email) = '…'`) is used as written.
- `'a' 'b'`, which MySQL joins into one literal, is used as written.
- `BIT`, spatial and `VECTOR` values come back as `NULL`.
