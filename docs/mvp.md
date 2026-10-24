# Sosie MVP (v0.1)

One problem, solved well: **an AI agent works against a real Postgres database,
and the model never sees a real value.**

The most used developer tools do one thing and need no setup to try. The MVP is
held to that: three commands, no config file to start, and nothing it does that
a developer has to learn before the first query.

## In scope

1. **`npx sosie`** starts a local endpoint that speaks the Postgres protocol.
   The agent, the app, its tests and `psql` connect to it unchanged. It reads
   the real database read-only and returns every value faked.
2. **Faking by default.** Every value is faked by its column's type. The same
   real value always becomes the same fake, and a foreign key shares the fake of
   the key it points to, so joins hold. A column's name picks a realistic format
   (an `email` column gets emails); it never lets a value through.
3. **Query by what you saw.** A fake the agent copies into a query (an id, an
   email) is turned back into the real value before the query runs, so filters
   and lookups work.
4. **`sosie.yml`, optional.** The team lists the columns that may pass
   unchanged (`orders.status`) and the format for a column Sosie can't tell from
   its name. Committed with the code, reviewed like code.
5. **`npx sosie mcp`.** An MCP server with two tools, `describe` and `query`,
   for agents that prefer MCP to `psql`.
6. **`npx sosie scan <paths>`.** Searches transcripts and logs for any real
   value that passed through Sosie, and exits 1 if one is found. Proof, not
   trust.

## Out of scope, and why

| Not in v0.1 | Why |
| --- | --- |
| Writes | Read-only is the promise that makes Sosie safe to point at production |
| MySQL, SQLite, MongoDB | Postgres first; the design keeps the database behind one module |
| REST and GraphQL APIs | Next, faked consistently with the database (see the HLD) |
| Filtering the agent's shell output | `sosie scan` proves the result; a hook per assistant comes later |
| Mappings shared across a team | Each developer's fakes are their own; nothing leaves the machine |
| TLS and passwords on the local endpoint | It listens on 127.0.0.1 only |
| Automatic detection deciding what is safe | Detection only ever suggests; the schema and `sosie.yml` decide |

## Done means

- From `npx sosie` to the first faked query in under a minute, with no config.
- `psql` and `node-postgres` work unchanged for reads; Prisma and Drizzle are
  checked before the release.
- Planted canary values never show up: `sosie scan` finds none after a week of
  real agent work against a seeded database.
- A feature built against the fakes passes its tests against the real data.

## Release

The repository stays private until v0.1 works end to end, then opens under MIT.
