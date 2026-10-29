---
layout: ../../layouts/Docs.astro
title: Configuration
description: Sosie's sosie.yml rules and formats, the command's options, its environment variables, and running several Sosies at once.
lead: Nothing to configure to start. sosie.yml for the fields your team decides may pass, and a few options for the rest.
---

## sosie.yml

Optional, committed with the code and reviewed like code. Sosie reads `./sosie.yml` when it starts, or the file given
with `--rules`. It is written in field ids, so the same file works for every source.

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

### Field ids

| Source | A field's id |
| --- | --- |
| Postgres | `table.column`, or `schema.table.column` outside `public` |
| REST, with a document | `Schema.property`, nested properties dotted: `User.address.city` |
| REST, without one | The entity its path names, singular, and the key: `user.email` |
| GraphQL | `Type.field`: `User.email` |

`entity.*` names every field of an entity. The MCP tool `describe` lists the fields Sosie knows, and which pass.

### pass

Values of a listed field come back unchanged. Use it for what your app's logic needs to be real: statuses, prices,
reference tables such as countries. A field that passes still never shows a value the request turned back from a fake.

A field that shares another's values cannot pass alone, or joins between them would break:

```
sosie.yml: orders.user_id passes but users.id, whose values it shares, does not. List both or neither.
```

### format

Gives a field a format its name does not say. The formats:

`email`, `phone`, `first_name`, `last_name`, `full_name`, `street`, `city`, `postal_code`, `country`, `company`,
`username`, `url`, `iban`, `text`, `shape`

Personal formats (email, phone, the names, street, city, postal code) share fakes across fields and sources: one person's
email is the same fake wherever it appears.

### Checked at start-up

An unknown key, entity, field or format stops Sosie with an error that names it, so a typo never lets data through
silently. Every problem is listed at once:

```
sosie.yml: users.emial is not a field. Did you mean users.email?
```

A source that learns its fields as answers come, REST without a document, warns instead and applies the rule once it
meets the field.

## The command

| Command | What it does |
| --- | --- |
| `sosie` | Start. Reads `SOSIE_UPSTREAM`, or asks for it at a hidden prompt |
| `sosie mcp` | An MCP server over stdio, for every running Sosie |
| `sosie scan <path>…` | Search files and folders for real values; exit 1 if one is found |

Options for `sosie`:

| Option | Default | |
| --- | --- | --- |
| `--port <n>` | `7674` | Without it, a Sosie whose port is taken tries the next nine, so a second one just starts |
| `--host <host>` | `127.0.0.1` | Another address is allowed, with a warning: the endpoint has no password |
| `--rules <file>` | `./sosie.yml` when present | |
| `--max-rows <n>` | `1000` | Rows a query returns, and items of each list in an API's answer |

Exit codes: `0`; `1` for a failure (cannot connect, a problem in `sosie.yml`, a real value found by `scan`); `2` for a
usage error.

## Environment

| Variable | |
| --- | --- |
| `SOSIE_UPSTREAM` | A database's connection string, or an API's base URL |
| `SOSIE_UPSTREAM_HEADERS` | For an API: headers Sosie sends it, one `Name: value` per line |
| `SOSIE_OPENAPI` | For a REST API: its OpenAPI document, a file or URL |
| `SOSIE_GRAPHQL_SCHEMA` | For a GraphQL API without introspection, or at a path without `graphql` in it: its SDL, or its introspection result as JSON |
| `SOSIE_HOME` | Where Sosie keeps its store; `~/.sosie` by default |

The upstream and its credentials are never arguments: arguments show in shell history and the process list, where an
agent can read them.

## Several Sosies

Run one Sosie per upstream, each in its own terminal. Without `--port`, each takes the next free port from `7674`.
They share one store, so a person is the same fake from the database and from the API, and `sosie mcp` serves them all:
its tools take an `address` when several of a kind run.

Each running Sosie writes `~/.sosie/running/<pid>.json` for `sosie mcp`: its address, its kind, its schema and the
fields that pass. Nothing real: no upstream, no credentials, no values. It is removed when Sosie stops.

## Defaults

| Setting | Default |
| --- | --- |
| Address | `127.0.0.1:7674`, and `::1` |
| Rows per query; items per list of an API's answer | 1,000 |
| Rows per MCP query | 200 |
| Statement timeout upstream | 30 s |
| Store | `$SOSIE_HOME`, or `~/.sosie` |
