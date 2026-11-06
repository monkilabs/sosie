---
layout: ../../layouts/Docs.astro
title: Configuration
description: sosie.yml, the only configuration Sosie has - every source of a project, its credentials by variable, which fields pass, and the commands.
lead: One file, sosie.yml, says everything Sosie reads and how it fakes it. sosie init writes it with your first source.
---

## sosie.yml

The only configuration there is: no flags, no variables of Sosie's own. It lives in the folder you start Sosie in,
is committed with the code and reviewed like code. It names every source of the project, a database or an API, each
by a name of your own.

```yaml
# For every source; a source may set its own.
max-rows: 1000
timeout: 30
pass:
  - orders.status
  - countries.*
format:
  users.handle: username

sources:
  shop:
    upstream: ${SHOP_DATABASE_URL}
  crm:
    upstream: ${CRM_DATABASE_URL}
    port: 7700
    pass: [contacts.region]
  billing:
    upstream: ${BILLING_API_URL}
    headers:
      Authorization: Bearer ${BILLING_TOKEN}
    schema: ./openapi/billing.yaml
  storefront:
    upstream: ${STOREFRONT_URL}
    kind: graphql
    schema: ./storefront.graphql
```

`npx @sosie/cli` starts one Sosie for all of them, each at an address of its own. Without a `sosie.yml`, it asks for
your first source and writes one, as `npx @sosie/cli init` does.

### Every key

| Key | Where | Default | |
| --- | --- | --- | --- |
| `sources` | the top | none: at least one | Each source by its name: lowercase letters, digits, `-` and `_`, a letter first |
| `upstream` | a source | none: required | `${NAME}`: the variable that holds its connection string or base URL |
| `kind` | a source | from the URL | `postgres`, `mysql`, `mongodb`, `rest` or `graphql`, for a URL that does not say: GraphQL at `/query` |
| `schema` | a REST or GraphQL source | the API's own: its OpenAPI document if it serves one, or introspection | A file, by its path from `sosie.yml`, or a URL: an OpenAPI document, or GraphQL SDL or an introspection result as JSON |
| `headers` | a REST or GraphQL source | none | Headers Sosie sends the API: `Authorization: Bearer ${TOKEN}` |
| `port` | a source | the next free from 7674, in the order listed | `0` lets the system pick |
| `host` | the top, or a source | `127.0.0.1` | Another address is allowed, with a warning: the endpoints have no password |
| `max-rows` | the top, or a source | `1000` | Rows a query returns, and items of each list in an API's answer |
| `timeout` | the top, or a source | `30` | Seconds a statement, a command or a request may run upstream, from 1 to 3600. The MCP tools wait 50 s at most either way |
| `pass` | the top, or a source | none | Fields whose values come back unchanged |
| `format` | the top, or a source | none | Formats for fields Sosie cannot tell from their names |

A key a source cannot use is an error that says why: a Postgres source takes no `headers`.

### Credentials

A connection string, a password or a token is never written in `sosie.yml`, nor given as an argument: arguments show in
shell history and in the process list, where an agent can read them. `sosie.yml` names the variable that holds it,
`${NAME}`, and Sosie reads it from the terminal it starts in, or asks for it at a hidden prompt. The names are yours:
reuse what your app already has.

```sh
export SHOP_DATABASE_URL='postgres://readonly:…@db.internal:5432/shop'
export BILLING_TOKEN='…'
npx @sosie/cli
```

Only `upstream` and the values of `headers` read variables. `upstream` is always one whole variable, never a URL
written out, not even in part: Sosie refuses one, so a file an agent can edit never names a host. A header may hold
text around its variable (`Bearer ${TOKEN}`): headers go only to their own source's upstream. An edit can still choose
among your variables: point a source at another, or put one in a header. Review `sosie.yml` as you review code. Write
`$$` for a `$`.

### Field ids

| Source | A field's id |
| --- | --- |
| Postgres | `table.column`, or `schema.table.column` outside `public` |
| MySQL | `table.column`, or `database.table.column` outside the database the connection string names |
| MongoDB | `collection.path`, a nested field's path dotted (`users.address.city`), or `database.collection.path` outside the database the connection string names |
| REST, with a document | `Schema.property`, nested properties dotted: `User.address.city` |
| REST, without one | The entity its path names, singular, and the key: `user.email` |
| GraphQL | `Type.field`: `User.email` |

`entity.*` names every field of an entity. The MCP tool `describe` lists the fields each source has, and which pass.
A field's id carries no source's name: two sources with a `users` table share its fakes, so a person is one fake in
both, and adding a source never changes another's.

### pass

Values of a listed field come back unchanged. Use it for what your app's logic needs to be real: statuses, prices,
reference tables such as countries. A field that passes still never shows a value the request turned back from a fake.

At the top, a rule holds for every source that has the table; under a source, for that one. A field that shares
another's values cannot pass alone, or joins between them would break:

```
sosie.yml: orders.user_id passes but users.id, whose values it shares, does not. List both or neither.
```

### format

Gives a field a format its name does not say. The formats:

`email`, `phone`, `first_name`, `last_name`, `full_name`, `street`, `city`, `postal_code`, `country`, `company`,
`username`, `url`, `iban`, `text`, `shape`

Personal formats (email, phone, the names, street, city, postal code) share fakes across fields and sources: one person's
email is the same fake wherever it appears. A source's own format for a field wins over the top's.

### Checked at start-up

An unknown key, source, entity, field or format stops Sosie with an error that names it, so a typo never lets data
through silently. Every problem is listed at once:

```
sosie.yml: sources.crm: contacts.regoin is not a field. Did you mean contacts.region?
sosie.yml: users.nick is not a field of shop's users. A rule for one source goes under it.
```

A rule at the top that no source has the table for is an error too. A source that learns its fields as answers come,
REST without a document and MongoDB, keeps a rule for a field it has not met, and applies it once it does: its own with
a warning, so read the warnings Sosie starts with. `entity.*` holds for the fields such a source meets later too.

## The commands

| Command | What it does |
| --- | --- |
| `sosie` | Start every source `sosie.yml` names. Without a `sosie.yml`, in a terminal, `sosie init` first |
| `sosie init` | Write `sosie.yml` with your first source, its connection string asked for at a hidden prompt |
| `sosie mcp` | An MCP server over stdio, for every running Sosie |
| `sosie scan <path>…` | Search files and folders for real values; exit 1 if one is found |

`--help` and `--version` are the only flags. Exit codes: `0`; `1` for a failure (a problem in `sosie.yml`, a source
that cannot connect, a port in use, a real value found by `scan`); `2` for a usage error.

`sosie init` asks for the first source's connection string, says what it found there, and asks for a name for the
source and the variable to keep the string in. It writes `sosie.yml` with those, never with the string; a
`sosie.yml` that has rules only gets the source added, its rules kept. Add any other source under `sources:` by hand.

`SOSIE_HOME`, where Sosie keeps its store (`~/.sosie` by default), is the one variable of its own: it is the machine's,
not the project's.

## Upgrading from 0.3 and earlier

`SOSIE_UPSTREAM`, `SOSIE_UPSTREAM_HEADERS`, `SOSIE_OPENAPI`, `SOSIE_GRAPHQL_SCHEMA` and the flags `--port`, `--host`,
`--rules`, `--max-rows` and `--timeout` are gone: each is a key of `sosie.yml`. With `SOSIE_UPSTREAM` still set, this
reads it:

```yaml
sources:
  app:
    upstream: ${SOSIE_UPSTREAM}
```

Sosie says so when one of them is still set, and a flag given says where it went.

## Several projects

One Sosie serves every source of a project. Another project's Sosie, started in its own folder, takes the next free
ports. All of them share one store, so a person is the same fake everywhere, and `sosie mcp` serves them all: its tools
take a `source`, by its name, when several of a kind run.

Each running Sosie writes `~/.sosie/running/<pid>.json` for `sosie mcp`: each source's name, kind, address, schema and
the fields that pass. Nothing real: no upstream, no credentials, no values. It is removed when Sosie stops.

## Defaults

| Setting | Default |
| --- | --- |
| Address | `127.0.0.1`, the first source at `7674` and each next at the next free port, and `::1` |
| Rows per query; items per list of an API's answer | 1,000 |
| Rows per MCP query | 200 |
| Statement timeout upstream | 30 s |
| Store | `$SOSIE_HOME/store/`, or `~/.sosie/store/` |
