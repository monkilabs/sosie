# Changelog

## 0.1.0

The first release: an AI agent works against a real Postgres database, and the
model never sees a real value.

- `npx @sosie/cli` starts a local, read-only Postgres endpoint in front of your
  database. Every value comes back as a realistic fake; the same real value is
  always the same fake, so joins hold and a value the agent saw finds its row
  again.
- `sosie.yml`, optional, lists the fields that may pass unchanged and the format
  of a field Sosie cannot tell from its name.
- `npx @sosie/cli mcp` serves `describe` and `query` to agents that prefer MCP.
- `npx @sosie/cli scan <path>` searches transcripts and logs for real values and
  exits 1 if it finds one.
- PostgreSQL 15 to 18; Node 24 and 26. Tested with psql, node-postgres,
  postgres.js, Drizzle and Prisma 7.

Reviewed by five rounds of an independent panel that tried to get planted
values out; what it found is fixed, and what remains is in the
[threat model](docs/hld.md#threat-model) and the
[limits](docs/lld.md#limits).
