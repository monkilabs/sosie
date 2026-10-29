# Changelog

## 0.1.0

The first release: an AI agent works against a real Postgres database and the
team's own REST and GraphQL APIs, and the model never sees a real value.

- `npx @sosie/cli` starts a local, read-only endpoint in front of your database
  or API. Every value comes back as a realistic fake; the same real value is
  always the same fake, so joins hold and a value the agent saw finds its
  record again.
- Postgres: the Postgres wire protocol, for `psql`, ORMs and any Postgres MCP
  server. PostgreSQL 15 to 18; tested with psql, node-postgres, postgres.js,
  Drizzle and Prisma 7.
- REST: `GET` and `HEAD` only, with Sosie's credentials, never the agent's.
  Values are named from the API's OpenAPI document, or by where they sit;
  links point at Sosie with every value in them faked.
- GraphQL: queries only, checked against the schema; introspection is answered
  from the schema Sosie holds and never reaches the API.
- Several Sosies, one per upstream, share one store, so a person is the same
  fake from the database and from the API.
- `sosie.yml`, optional, lists the fields that may pass unchanged and the format
  of a field Sosie cannot tell from its name.
- `npx @sosie/cli mcp` serves agents that prefer MCP: `describe`, and each
  source's own tool, `query`, `request` or `graphql`.
- `npx @sosie/cli scan <path>` searches transcripts and logs for real values and
  exits 1 if it finds one.
- Node 24 and 26.

Reviewed by an independent panel that tried to get planted values out: five
rounds for the Postgres endpoint, seven for the shared store and the API
sources. What it found is fixed; what remains is in the
[threat model](docs/hld.md#threat-model) and the limits of each source in the
[low-level design](docs/lld.md).
