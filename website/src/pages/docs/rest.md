---
layout: ../../layouts/Docs.astro
title: REST APIs
description: Sosie in front of your team's own REST API - credentials, the OpenAPI document, links that point back at Sosie, and the limits.
lead: Your API's own paths on a local address. GET and HEAD only, with Sosie's credentials, and every value in the JSON faked.
---

## Start it

`SOSIE_UPSTREAM` is the API's base URL. Its credentials go in `SOSIE_UPSTREAM_HEADERS`, one `Name: value` per line:

```sh
export SOSIE_UPSTREAM='https://api.internal/v1'
export SOSIE_UPSTREAM_HEADERS="$(cat ~/.config/api.headers)"   # Authorization: Bearer …
npx @sosie/cli
```

```
  ✓ api.internal/v1, read-only: OpenAPI 3.1, 24 schemas, 41 GET paths
  ✓ Every value is faked

  Your agent, app and curl:  http://localhost:7675/v1
```

`http://localhost:7675/v1/users` reads `https://api.internal/v1/users`.

## Read-only

Only `GET` and `HEAD` reach the API. Anything else gets `405` and never leaves Sosie. A method override in the query
(`?_method=DELETE` and the like), which some frameworks run instead of `GET`, gets `400`; the client's headers never
reach the API at all.

A `GET` that writes is the API's to guard: Sosie sends every `GET` on.

## Credentials

The API's credentials are Sosie's, never the client's:

- **`SOSIE_UPSTREAM_HEADERS`** holds them, one `Name: value` per line. Read them from a file or a secret manager, so they
  stay out of your shell's history.
- **A user and password in the URL** become a Basic header.
- **A query on the URL** (`?api_key=…`) goes with every request and is never shown, in links neither.

Headers the client sends, `Authorization` included, are not passed on. Redirects are followed inside Sosie, within the
API's origin and base path only, so credentials never go elsewhere and the client never sees a real URL. If an answer
holds Sosie's own credentials, in a key or in a field that passes, they are faked.

## The OpenAPI document

Sosie names each value's field from the API's OpenAPI document, 3.x or Swagger 2.0, JSON or YAML: the file or URL in
`SOSIE_OPENAPI`, or the first of these the API serves under its base:

`openapi.json`, `openapi.yaml`, `swagger.json`, `v3/api-docs`, `api-docs`, `docs/openapi.json`

Each object schema is an entity, each property a field. `format: email` and `uri` pick their formats; a property named
`id` is the entity's key, and `userId` shares the values of `User.id`.

**Without a document**, Sosie learns the schema as answers come: a value's field is where it sits, in the entity its
path names, singular. `/users/87` and `{ "data": [{ "email": … }] }` under `/users` are `user.email`. `sosie.yml` may
name fields not met yet: they warn instead of failing, and apply once met.

## Faking

Every value in a JSON body is faked by its field, with the same rules, domains and formats as the database. A person's
email is the same fake from the database and from the API.

- A key that is structure (`city`, `createdAt`) stays; one that is a value (a map keyed by email) is faked.
- An integer beyond 2^53, a 64-bit id, keeps its digits exactly, so its fake leads back to its record.
- A list keeps its first `--max-rows` items, and the `sosie-notice` header says the rest were cut.
- Status codes pass. A JSON error body is faked as no entity's, so no rule passes anything in it.

## Links

A URL into the API (`next`, `href`, a path under the base) points at Sosie instead, with nothing real in it, so
following it reads the record it names. Path words that are the API's own (`users`, `orders`) stay as written; values
(ids, a slug) are faked as the id of what they follow.

## Query by what you saw

Sosie reads a path the way it reads a link. A value in a path turns back into a real one in the domain of the id it
follows: `/users/87` is `user.id`, `/users/{userId}/orders` by its OpenAPI name. A query parameter is looked up in the
field it names: `?email=` in `user.email`, `?userId=` in `user.id`. A page number (`page=2`, `limit=10`) stays as
written.

## From a browser

On this machine's address, Sosie answers only requests addressed to `localhost`, and none from a page of another site,
so a web page can neither rebind its name to Sosie nor make it send a request. It sends no CORS headers: a browser app
reads it through its dev server's proxy.

## Limits

- **JSON only.** Images, files and HTML from the API are not passed on, nor are response headers other than the content
  type, `Link` among them: pagination works through the body.
- **Each request** has a 30 s timeout and a 20 MB body cap.
- **Ids across sources.** An API's ids and a database's share fakes only when their names meet (a GraphQL type and a
  Prisma model both `User`, as `User.id`).
- **A wildcard rule** without a document (`country.*`) passes every top-level key of that entity the API ever answers
  with.
- **A rule that passes an id** (`user.id`) passes what follows a collection's name in a path, which Sosie reads as the
  id: a login, as in `/users/jdoe`, is shown as it is.
- **A map keyed by lowercase words** (`{ "jdoe": … }`) keeps its keys, unless the document declares it a map: they look
  like structure.
- **The OpenAPI document**, asked for through Sosie, comes back faked, like any other answer.
- **An id with a `/` in it** (`group%2Fproject`) cannot be asked for by path.
