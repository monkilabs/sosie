---
layout: ../../layouts/Docs.astro
title: GraphQL APIs
description: Sosie in front of your team's own GraphQL API - which endpoints it recognises, the schema, the guard, faking through aliases and fragments, and the limits.
lead: Your API's GraphQL endpoint on a local address. Queries only, checked against the schema, with every leaf of the data faked.
---

## Start it

`SOSIE_UPSTREAM` is the endpoint. Credentials work as for [REST](../rest/#credentials):

```sh
export SOSIE_UPSTREAM='https://api.internal/graphql'
export SOSIE_UPSTREAM_HEADERS="$(cat ~/.config/api.headers)"   # Authorization: Bearer …
npx @sosie/cli
```

```
  ✓ api.internal/graphql, read-only: 31 types, 12 queries
  ✓ Every value is faked

  Your agent, app and curl:  http://localhost:7676/graphql
```

Sosie serves GraphQL at the API's own path, by `GET` and `POST`, batches included.

## Which endpoints

An `http(s)` URL with `graphql` in its path is GraphQL's:

| Endpoint | Example |
| --- | --- |
| `/graphql` | Most servers |
| `/v1/graphql` | Hasura |
| `/graphql/v1` | Supabase |
| `/admin/api/…/graphql.json` | Shopify |

An endpoint at another path, such as gqlgen's `/query`, is GraphQL when `SOSIE_GRAPHQL_SCHEMA` gives its schema.
Without it, the URL goes to the REST source. Sosie never sends a `POST` to find out: on a REST API, it could write.

## The schema

By introspection, with Sosie's credentials, at start-up. An API with introspection off is read from
`SOSIE_GRAPHQL_SCHEMA`: its SDL, or an introspection result as JSON.

- Each object and interface type is an entity; each field that holds a scalar or an enum is a field.
- Custom scalars map by name: `DateTime`, `Date`, `UUID`, `JSON`, `BigInt` and the like. `Email` and `EmailAddress`
  pick the email format, `URL` and `URI` the URL format.
- A field `id` is the type's key; one named `userId` shares the values of `User.id`.

Clients' introspection is answered from the schema Sosie holds, and never reaches the API. So clients can introspect an
API that has introspection off.

## The guard

- **Queries only.** A mutation or a subscription is refused, and its text never leaves Sosie. So is a field of the
  mutation type asked for under a query field.
- **Checked first.** Each operation is parsed and checked against the schema, and its variables against their types,
  before anything goes upstream. What fails gets `400`, quoting only what the client sent.
- **Bounded.** A `POST` of up to 1 MB, batches of up to 50 operations, queries of up to 10,000 tokens. Checking runs on
  two threads of Sosie's own, each query within 2 seconds and 256 MB, so a query built to be costly is refused
  (`SOSIE_TOO_COSTLY`) instead of stalling everyone else.
- **Only what runs.** Only the operation to run, with the fragments it uses and the variables it declares, reaches the
  API. A persisted query without its text is refused, and a `POST` is never redirected.

A query field that writes, other than a field of the mutation type, is the API's to guard.

## Faking

Every leaf of `data` is faked by the schema field it is, through aliases, fragments and nested objects, so
`order.user.id`, `order.userId` and `user.id` are one fake, and a person's email is the database's fake.

- An object of an interface or a union is faked by its own type: Sosie asks for its `__typename` under an alias the
  client never sees.
- A list keeps its first `--max-rows` items; `extensions.sosie` says the rest were cut.
- An integer beyond 2^53 keeps its digits, so its fake leads back to its record.

**Errors.** Since Sosie checked the query itself, anything the API says beyond that may quote data. Every message is
replaced by Sosie's; an error's `path` and a code such as `FORBIDDEN` or `ORDER_NOT_FOUND` are kept, and a code with
data in it is dropped.

## Query by what you saw

Each argument, and each variable where it is used, is looked up in the field it names on the type its field returns:
`user(id:)` in `User.id`, `users(email:)` in `User.email`, `orders(userId:)` in `User.id`. Inside input objects too,
where an operator (`where: { id: { _eq: 8 } }`) compares with the field around it. A number that names no field
(`first: 10`) stays as written.

```graphql
query { user(id: "87") { email orders { total } } }
```

## Limits

- A JSON scalar's keys that look like words (`{ "jdoe": … }`) stay, as a json column's do.
- The schema, its descriptions included, is visible: it is the API, not its data.
- A variable sent as a JSON number beyond 2^53 is rounded as JavaScript reads it: send a 64-bit id as a string, or
  write it in the query.
- `@defer` and `@stream` answers, which come in parts, are not read yet.
