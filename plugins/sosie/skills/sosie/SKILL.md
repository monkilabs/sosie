---
name: sosie
description: Read a database or an API through Sosie, which fakes every value it returns. Use when the sosie MCP tools (describe, query, find, aggregate, request, graphql) are there, when the project has a sosie.yml, when a database or API answers on localhost from port 7674, or when data looks like consistent fakes. Says how to query through Sosie, what its fakes mean, why a result can look wrong, and what never to do with the real credentials.
license: MIT
---

# Sosie

Sosie is a read-only endpoint on the developer's machine, in front of their Postgres, MySQL or MongoDB database, or
their team's REST or GraphQL API. Every value it returns is a fake of the real one, of the same type and format. The same real value is
always the same fake, so joins hold and a value you saw finds its record again. The real values, the credentials and
the hostnames stay on the developer's side. That is the point of it: keep it that way.

## Reach it

- **The MCP tools.** Start with `describe`: every running Sosie, its entities, their fields, types, keys and
  references, and which fields pass unchanged. Then `query` for Postgres and MySQL (SQL in the database's own
  dialect, up to 200 rows per statement), `find` and `aggregate` for MongoDB (a collection, and a filter or a pipeline
  as JSON, up to 200 documents), `request` for REST (a `GET` path, or a link Sosie returned) and `graphql` for GraphQL
  (a query and its variables). When several Sosies run, pass the `address` that `describe` lists. Use the tool of the
  Sosie's kind: `query` reaches a Postgres or MySQL Sosie only, `find` and `aggregate` a MongoDB one. A MongoDB
  Sosie learns its fields from the documents it serves, so `describe` lists what it has met so far. `query` on MySQL,
  `find`, `aggregate` and MongoDB itself come with the CLI after 0.2.0: where a tool says it is not there, read the
  Sosie through its address.
- **A REST Sosie without an OpenAPI document** learns its fields from the API's answers, so `describe` lists only
  what it has met so far, and may list nothing. `request` the paths the API serves, such as `/users`, and read the
  fields from what comes back.
- **Its address**, for `psql`, `mongosh`, `curl`, the app and its tests: the one Sosie printed when it started, on
  127.0.0.1 from port 7674 up, such as `postgres://localhost:7674/app`, `mysql://127.0.0.1:7674/app` or
  `mongodb://127.0.0.1:7674/app?directConnection=true`. Point code at it as it would point at the real thing.

## When Sosie is not running

The tools say so. Ask the developer to start it **in their own terminal** with `npx @sosie/cli`, then try again.

Never start Sosie yourself, and never ask for, look for or handle what it reads: the connection string,
`SOSIE_UPSTREAM`, `SOSIE_UPSTREAM_HEADERS`, an API token, a `.env` file. Sosie exists so that none of these reach you.
Never connect to the real database or API directly, even when you could.

## Read the fakes right

- **Every value is a fake** unless `describe` lists its field as passing, by the team's `sosie.yml`. Names, emails,
  ids, amounts and dates are fakes. Never present them as real people, orders or figures; say they are Sosie's fakes.
- **Consistent.** One real value is one fake everywhere: in every row, table and session, and in the database and the
  API alike. Foreign keys and joins hold.
- **Query by what you saw.** A fake compared with a field (`WHERE email = '…'`, `IN (…)`, an id in a path such as
  `/users/87`, a query parameter such as `?email=`, a GraphQL argument, a MongoDB filter such as
  `{"_id": {"$oid": "…"}}`) is turned back into the real value before the query runs. Following a link an API
  returned reads the record it names. A page's number (`page=2`, `limit`, `offset`) is sent as you wrote it.
- **The shape is real.** Types, formats, which values are null, the rows a query returns and SQL's `count(…)` are
  real. A count or a page number in an API's body (`total`, `page`) is a field's value, and faked. Dates are shifted
  by up to a year; numbers keep their sign, digits and scale.

## Why a result can look wrong

This is how Sosie works, not a bug, and not a reason to work around it.

- **Order and ranges follow the real values.** `ORDER BY` sorts by them, so the fakes come back out of order; `>`, `<`
  and `BETWEEN` compare them.
- **Partial matches find nothing.** `LIKE '%van%'` and other partial matches filter the real values, so a piece of a
  fake matches nothing. Compare whole values.
- **Computed values are faked by type.** `length(email)`, `max(id)` and `sum(total)` are fakes of the computed value,
  not computed from the fakes you saw. `count(…)` passes.
- **A bare boolean filters the real value.** `WHERE active` filters the real ones, while the fakes may show flipped
  ones. Write `active = true`, which is turned back.
- **A value Sosie never showed** is used as written, and matches whatever real value it happens to be.
- **Composite values** (`SELECT u FROM users u`) and types Sosie does not know come back as `NULL`. A driver that asks
  for binary results gets them, except for such types, `regclass` and `money`, which are refused in binary: ask for the column
  in text, or cast it. An older Sosie refuses binary results altogether: ask the developer to update it.
- **An error raised while rows are read** comes back as its code only. Sosie hides the rest, which could quote a value.

## What Sosie refuses

- **Writes.** `INSERT`, `UPDATE`, `DELETE`, schema changes and `EXPLAIN`, whose plan would print real values; GraphQL
  mutations and subscriptions; every HTTP method but `GET` and `HEAD`.
- **What would show the real data or the server:** catalogs such as `pg_stats`, `pg_stat_activity` and `pg_settings`,
  and `pg_roles` read by `*` or its `rolconfig`, MySQL's `mysql` database and `SHOW STATUS`, MongoDB's `admin`, `local` and `config` databases; functions
  and settings such as `inet_server_addr`, `SHOW port`, `@@datadir` and `set_config` with a value from a row; and
  JavaScript on a MongoDB server (`$where`, `$function`).

Do not look for a way around a refusal or a fake, and do not use filters or computed values to work out a real value.
That defeats the reason the developer put Sosie there.

## Code written against Sosie

Code written against the fakes runs unchanged on the real data: the same tables, fields, types and relationships.

- **Never hard-code a value you saw.** It is a fake. Through Sosie it finds its record; on the real database it finds
  nothing, or someone else's.
- **When the app's logic needs a field to be real**, such as a status, a price or a table of countries, tell the
  developer. They can let it pass in `sosie.yml`, which is theirs to change and review like code:

  ```yaml
  pass:
    - orders.status
    - countries.*
  format:
    users.handle: username
  ```

  A field's id is `table.column` for Postgres and MySQL, `collection.path` for MongoDB (`users.address.city`),
  `Schema.property` for REST with an OpenAPI document (`entity.key` without one) and `Type.field` for GraphQL;
  `describe` lists them. Sosie reads `sosie.yml` when it starts, so a change
  applies once the developer restarts it.

## Checking files for real values

`npx @sosie/cli scan <files or folders>` searches transcripts, logs or any text files for a real value that passed
through Sosie. It prints the file, the line and where each one it finds came from, never the value: its field, or for
a person's value the format it shares (`format:email`). It exits 1 when it finds one. It compares with the store on the machine where Sosie ran, so it runs there.
