---
layout: ../../layouts/Docs.astro
title: SQL Server
description: Sosie in front of SQL Server 2019 to 2025 - TDS and its TLS, which drivers work, what the guard allows, and the limits.
lead: A local endpoint that speaks SQL Server's protocol, TDS. sqlcmd, your app and its tests connect to it with their own driver.
---

## Start it

A source in `sosie.yml`, its connection string in a variable of yours. `npx @sosie/cli` writes this for you the first
time.

```yaml
sources:
  app:
    upstream: ${APP_URL}
```

```sh
export APP_URL='sqlserver://sosie_reader:…@db.internal:1433/app'
npx @sosie/cli
```

```
  ✓ app  db.internal:1433/app, read-only: 42 tables, 3 views
  ✓ Every value is faked

  app:                       Server=127.0.0.1,7674;Database=app;TrustServerCertificate=true
```

The connection string may be the one you have: an ADO.NET or ODBC one (`Server=db.internal,1433;Database=app;User
Id=…;Password=…`), JDBC's (`jdbc:sqlserver://db.internal:1433;databaseName=app;…`) or Prisma's
(`sqlserver://db.internal:1433;database=app;…`) are read as the `sqlserver://` URL they stand for. A named instance
needs its port: Sosie does not ask SQL Browser where it is.

The address is a connection string your driver takes as it is, with any user and any password. It listens on
`127.0.0.1` and `::1` only, unless `sosie.yml` gives another `host`.

```sh
sqlcmd -S 127.0.0.1,7674 -U kim -P anything -C -d app
```

SQL Server 2019, 2022 and 2025 are tested. Azure SQL is not tried yet: Sosie follows its routing at login, but whether
it allows browse mode (below) is still to see.

## A read-only login

SQL Server has no read-only session. Sosie's guard refuses every write it reads, and the login is the layer under it:
give it `db_datareader`, and nothing else.

```sql
CREATE LOGIN sosie_reader WITH PASSWORD = '…';
USE app;
CREATE USER sosie_reader FOR LOGIN sosie_reader;
ALTER ROLE db_datareader ADD MEMBER sosie_reader;
```

Sosie warns when its login is `sysadmin` or `db_owner`, or can change data. Without `VIEW DEFINITION`, a reader cannot
see which tables a view reads, and Sosie says so: `describe` then shares a view's columns' fakes only where one table
has a column of that name. Its rows are faked by their tables all the same, as SQL Server names them.

## TLS

**To the server**, the connection string's own settings, as the drivers read them:

| Setting | What it does |
| --- | --- |
| `encrypt=true` (the default) | TLS, and the server's certificate is checked |
| `trustServerCertificate=true` | Any certificate is trusted: for a server in a container, whose certificate is its own |
| `encrypt=strict` | TDS 8: TLS before anything else |
| `encrypt=false` | TLS for the login only, or none where the server has none |
| `hostNameInCertificate=…` | The name the certificate must have, when it is not the host's |

**From your drivers**, which ask for TLS by default and check the certificate: Sosie serves TLS with a certificate of
its own CA, which it makes the first time in `~/.sosie/tls/` (`SOSIE_HOME`). The address it prints says
`TrustServerCertificate=true`, so a driver connects without trusting the CA. One that should check the certificate
trusts `~/.sosie/tls/ca.pem` instead:

| Driver | Where it trusts a CA |
| --- | --- |
| ODBC Driver 18, SqlClient (Linux) | The system's store |
| JDBC | The JVM's `cacerts`, or `trustStore` in the connection string |
| tedious | `NODE_EXTRA_CA_CERTS`, or `cryptoCredentialsDetails: { ca }` |

Strict encryption (`Encrypt=strict`, TDS 8) always checks the certificate, so it needs the CA trusted; JDBC and
SqlClient can name the certificate instead (`serverCertificate=~/.sosie/tls/endpoint.pem`). A driver told not to ask for
TLS (`Encrypt=false`, `optional`) connects in clear: the address is on your machine.

## Clients

Checked with ODBC Driver 18 (`sqlcmd`), JDBC 13.6, Microsoft.Data.SqlClient 7.1 and tedious 20.3, in their own ways:

- **Batches**, several statements to one, as SQL Server reads them: with or without semicolons between them. Each is
  checked before any runs, so one that Sosie refuses stops them all.
- **Parameters**, as `sp_executesql` sends them (SqlClient, tedious, ODBC), and prepared statements, as `sp_prepexec`,
  `sp_prepare` and `sp_execute` do (JDBC's `PreparedStatement`, tedious' `prepare`). Each statement is checked when it
  is prepared, and each execution's parameters turned back.
- **Transactions**, by statement (`BEGIN TRAN`, JDBC's `IF @@TRANCOUNT > 0 ROLLBACK TRAN`) or by the drivers' own
  requests (SqlClient's `BeginTransaction`).
- **The catalog**, as the drivers read it: JDBC's `getTables` and `getColumns`, SqlClient's `GetSchema`.
- **Pooled connections**: a pool's reset is done upstream, and Sosie's settings set again.
- **Cancelling** a running statement, with an attention.

Sosie opens no server cursors (`sp_cursoropen`): a forward-only, read-only result, every driver's default, gets the
rows. MARS is off.

## Over MCP

`sosie mcp`'s `query` tool runs T-SQL on a running SQL Server Sosie, as on a Postgres or MySQL one: up to 200 rows of
each statement as JSON, several statements at once, bytes as hex, and Sosie's notes (a result cut at the cap).

## What the guard allows

Each batch is parsed, by the T-SQL dialect of [sqlparser](https://github.com/apache/datafusion-sqlparser-rs) compiled
to WebAssembly, before it goes anywhere. A statement it cannot parse is refused.

- **Allowed:** `SELECT` and `WITH`, without `INTO`, `FOR XML` or a hint that locks rows (`UPDLOCK`, `XLOCK`,
  `HOLDLOCK`); `SET` of the session's own options (`NOCOUNT`, `ANSI_NULLS`, `TEXTSIZE`, the isolation level and the
  like); `USE`; `DECLARE`; transactions; `IF` and `ELSE`, each branch checked; and the catalog's procedures
  (`sp_tables`, `sp_columns`, `sp_pkeys`, `sp_help` and the like), by `EXEC` or as an RPC, a table variable filled
  from one among them.
- **Refused:** everything else. A statement that changes data gets error 3906, `This statement changes data. Sosie is
  read-only.` So do `PRINT`, `RAISERROR` and `THROW`, whose text Sosie cannot fake; `WHILE`; any other procedure,
  whose code may write or read what Sosie cannot see; a statement in a string (`EXEC ('…')`); `OUTPUT` parameters;
  cursors; bulk loads; and distributed transactions.
- **Refused catalog:** the dynamic management views (`sys.dm_*`: queries, sessions, addresses), password hashes
  (`sys.sql_logins`), credentials, linked servers and external data sources, where the files are (`sys.master_files`,
  `sp_helpdb`), the listener's address (`sys.tcp_endpoints`), Service Broker's queue of messages, `sysprocesses`, Query
  Store's text and plans, and `msdb`.
- **Refused functions and settings:** `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`, `OPENXML`, the transaction log
  (`fn_dblog`), audit and trace files; `@@SERVERNAME` and `SERVERPROPERTY` or `CONNECTIONPROPERTY` that say where the
  server is (`MachineName`, a default data path, an address). `SHOWPLAN_*` and `STATISTICS XML`, whose plans would
  show the real values Sosie puts in your query.
- **Settings that keep the session safe** cannot be changed: `NO_BROWSETABLE`, and a `ROWCOUNT` of 0 or above one more
  than `max-rows`.
- **A function that is not SQL Server's own** may be one of yours, whose code reads rows: what it gives is faked.

## The session upstream

One connection upstream per client, logged in with Sosie's login and the client's own options (its ODBC defaults, its
language, its read-only intent), with:

| Setting | Value |
| --- | --- |
| `NO_BROWSETABLE` | `ON`: SQL Server names the table and column of every value it returns |
| `ROWCOUNT` | One more than `max-rows`: a result cut at the cap says so |
| The time limit | 30 s, or the source's `timeout`: Sosie stops a statement past it with an attention |

A statement Sosie stops gets `Sosie stopped the statement at its time limit`, and the session goes on.

## Query by what you saw

Literals compared by equality (`=`, `<>`, `IN`) are looked up in the domain of the column on the other side, through
aliases, schemas, views, subqueries, derived tables and CTEs. A real value goes back as the client wrote the fake,
`N'…'` or not. Only the literals turned back change: the rest of the batch goes upstream exactly as the client wrote
it.

```sql
SELECT o.id, o.total FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = N'van29@example.com';
```

A parameter compared the same way (`WHERE email = @email`) is turned back in its own type. Where the real value does
not fit the parameter's type, as SqlClient sizes one to the fake (`nvarchar(17)`, `decimal(3,1)`), the parameter and
its declaration go in a type that holds it (`nvarchar(max)`, `decimal(38,2)`), so the real value is not cut.

## What each result column becomes

Sosie keeps browse mode on: SQL Server names, for every value it returns, its table and column, through `SELECT *`,
aliases, joins, views, synonyms, CTEs, inline functions and procedures. Such a column is faked by its field. Browse mode
also adds each table's key as a hidden column, which Sosie drops, with the rest of browse mode's answer: a client sees
only the columns it asked for.

A column SQL Server marks an expression rests on how Sosie read the batch: it passes only when the batch reads no table
of yours, or when it is a `COUNT(…)` or a literal the client wrote.

| The result column | Becomes |
| --- | --- |
| A table's column, through `SELECT *`, aliases, joins, views, synonyms and CTEs | A fake by its field |
| `COUNT(…)`, `COUNT_BIG(…)`, and a literal the client wrote | Unchanged |
| `sys` views, `INFORMATION_SCHEMA`, and the catalog's procedures | Unchanged |
| `FOR JSON` | JSON, faked as JSON, its keys as you wrote them |
| A `UNION`'s column, and anything else a query computes (`UPPER(email)`, `MAX(id)`) | A fake by its type |
| `xml`, `geography`, `geometry`, `hierarchyid`, `sql_variant` | `NULL` |

A fake keeps its type: a `char(n)` is padded to its length, a `tinyint` stays from 0 to 255, a `decimal` within its
precision, a `datetimeoffset` keeps its offset.

## Errors

- A message about the statement itself (a syntax error, an unknown column or table, permission denied) comes back,
  with every value Sosie substituted turned back into its fake. Anything else in quotes that you did not write, and
  that names nothing in the schema, comes back as `'…'`.
- Any other message comes back as its number only: `Message 245: Sosie hides the rest of this message, which may
  quote a value from your rows.` A conversion's message quotes the value it could not convert.
- Every message names its server as `Sosie`: never the real one.

## Limits

- Order and ranges follow the real values: `ORDER BY` sorts by them, and `>` or `BETWEEN` compare them.
- `LIKE` and other partial matches filter the real values, so a piece of a fake finds nothing.
- A value Sosie never showed is used as written, so it filters on the real value it happens to be.
- A literal compared with a column through a function (`LOWER(email) = '…'`) is used as written.
- Bytes (`binary`, `varbinary`, `image`) are never turned back: a binary key cannot be queried by its fake.
- `FOR JSON` fakes its values by their type, not their column: an email is the same fake as in its column, a number is
  not.
- A table named without its schema, where two schemas have one of that name, is read in the login's default schema.
- T-SQL that sqlparser does not read is refused as a syntax error: `DELETE` without `FROM`, `WHILE`, `SAVE TRANSACTION`,
  `TRY…CATCH`, `END CONVERSATION`.
