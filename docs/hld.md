# Sosie: high-level design

Sosie is a read-only endpoint in front of a data source that fakes every value
on the way out. An AI agent, the developer's app and their tools connect to it
as they would to the real source, and get the real shape with fake contents.
v0.1's source is Postgres; more are packages behind the same interface. This
document covers v0.1, the [MVP](mvp.md); the [low-level design](lld.md) has the
details.

## Goals

- **The model never sees a real value**: not in query results, not in errors,
  not in what an agent echoes back.
- **Nothing to change in the client.** Anything that speaks the source's
  protocol works. For Postgres: agents, ORMs, tests, `psql`, any Postgres MCP
  server.
- **Built to grow.** A new database or API is a new source package; the core,
  which decides every fake, does not change.
- **Code written against the fakes works on the real data.** Same types, same
  formats, same relationships.
- **No setup to start.** One command; configuration only when the defaults are
  not enough.
- **Runs where the data lives.** On the developer's machine or a host the team
  chooses. Never a hosted service.

## Non-goals (v0.1)

Writes, databases other than Postgres, REST and GraphQL, shell-output filtering,
team-shared mappings, and defending against an agent that deliberately hunts
for secrets on the machine Sosie runs on (see [Threat model](#threat-model)).

## How a developer uses it

1. In their own terminal, with the real connection string in `SOSIE_UPSTREAM`
   (or typed at a hidden prompt), they run `npx @sosie/cli`.
2. Sosie prints one local address. The agent, the app and `psql` use it.
3. Agents that prefer MCP get `npx @sosie/cli mcp`, which talks to the same
   endpoint.
4. When it matters, `npx @sosie/cli scan` checks transcripts and logs for any real
   value that passed through.
5. If a fake breaks the app's logic (a status that must be a real one), the
   team lists that column in `sosie.yml` and commits it.

## Architecture

Sosie is a **core** that knows nothing about any database or API, and
**sources** that each know one kind of upstream. v0.1 ships one source,
Postgres. A source speaks its upstream's protocol to clients and reports which
field each value came from; the core decides every fake.

```mermaid
flowchart LR
  subgraph host["Your machine, or a host you choose"]
    agent["AI agent"] -->|SQL| endpoint
    app["App, tests, psql"] -->|SQL| endpoint
    mcp["sosie mcp"] --> endpoint
    subgraph sosie["Sosie"]
      subgraph pg["Source: Postgres"]
        endpoint["Endpoint<br/>127.0.0.1:7674"] --> guard["Read-only guard"]
        guard --> rewrite["Fakes in the query<br/>back to real values"]
        rewrite --> upstream["Upstream client<br/>read-only session"]
        upstream --> results["Which field<br/>each value came from"]
      end
      subgraph core["Core"]
        faker["Faker"]
        rules["sosie.yml"] --- faker
        store[("Mapping store<br/>~/.sosie")] --- faker
        schema["Neutral schema"] --- faker
      end
      results --> faker
      rewrite -. lookup .-> faker
      faker --> endpoint
      later["Later sources:<br/>REST, GraphQL, MySQL"] -.-> faker
    end
  end
  upstream -->|read-only login| db[("Your database")]
  agent -.->|fakes only| model["Model provider"]
```

| Part | Component | Job |
| --- | --- | --- |
| Core | Neutral schema | Entities, fields, types, keys and references, the same shape for every source |
| Core | Rules | `sosie.yml`, checked against the neutral schema: what passes, which format |
| Core | Faker | Turns each value into its fake by field, type and rule; looks fakes up for queries |
| Core | Mapping store | Remembers each fake for each real value, so fakes are consistent and reversible |
| Core | `sosie mcp` | MCP server: `describe` from the core, plus each source's tools |
| Core | `sosie scan` | Finds real values in files, using the store's keyed hashes |
| Postgres | Endpoint | Speaks the Postgres wire protocol on 127.0.0.1, simple and extended query |
| Postgres | Guard | Allows reads; refuses everything else and the catalogs that store real values |
| Postgres | Rewriter | Asks the core for the real value behind each fake in a query |
| Postgres | Upstream client | One read-only session per client, with a timeout and a row cap |
| Postgres | Results | Names the field of each result column, from the table and position Postgres reports |

## How Sosie grows

A source is a package with one interface: it connects to its upstream
read-only, describes it in the neutral schema, serves an endpoint, and hands
every value to the core. Rules, fakes, the store, `scan` and `describe` stay the
same for every source.

| Order | Source | Why then |
| --- | --- | --- |
| v0.1 | Postgres | Most personal data lives in databases, and teams least dare give an agent access to them |
| Next | REST and GraphQL, the team's own APIs | They mostly serve the same data, and format domains keep a person the same fake in both |
| Later | MySQL and other databases; third-party APIs | On demand; many third-party APIs already offer a test mode |

The core is tested through an in-memory test source, without Postgres, so
nothing in it can come to depend on one source.

## A query, end to end

```mermaid
sequenceDiagram
  participant C as Client (agent, app, psql)
  participant S as Sosie
  participant D as Database
  C->>S: SELECT * FROM users WHERE email = 'kim@example.net'
  S->>S: guard: a read, allowed
  S->>S: rewrite: 'kim@example.net' is the fake of a real email
  S->>D: SELECT * FROM users WHERE email = (the real email)
  D-->>S: rows, with each column's table and position
  S->>S: fake every value; the same real value, the same fake
  S-->>C: rows of fakes
```

## The faking model

- **Fake by default.** Every value is faked by its column's type. A value passes
  unchanged only when `sosie.yml` lists its column.
- **Consistent.** A real value in a column always becomes the same fake. A
  foreign key fakes like the key it points to, so `orders.user_id` matches
  `users.id`.
- **Realistic.** The fake has the column's type and, where the column's name
  says so, a realistic format: emails, names, phone numbers, addresses. The name
  only picks the format; it never lets a value pass.
- **Reversible inside Sosie only.** The store maps fakes back to real values so
  queries by a fake work. Real values are sealed in the store and never leave
  Sosie's process.
- **Schema first, detection last.** The database's schema says what each value
  is. Automatic detection is not in v0.1; when it comes, it will only suggest
  rules for the team to review.

## Threat model

**Sosie protects against** real values reaching a model through normal agent
work: query results, error messages, a query echoed back with real values
substituted, and transcripts kept afterwards.

**Sosie does not protect against, in v0.1:**

- **An agent hunting for secrets on the same machine.** An agent runs as the
  developer's user, so it can read files and processes that user can. Run
  Sosie on another host, with the credentials only there, and give the agent
  only Sosie's address.
- **Inference through filters.** A query filters on real data, so a careful
  sequence of queries can answer yes-or-no questions about it.
- **Shape.** Row counts, which values are null, and the rough size of values are
  visible.

The defaults narrow the rest: a read-only login and session, a statement
timeout and a row cap protect the database; errors are scrubbed of anything Sosie
substituted; catalogs that store real values (such as `pg_stats`) are refused.

## Decisions

| Decision | Why | Alternatives |
| --- | --- | --- |
| A source-agnostic core, with sources as packages behind one interface | Adding MySQL or an API is a new package, not a change to the core | Postgres wired into the core: quicker for v0.1, and the second source would mean a rewrite |
| A neutral schema between sources and the core | Rules, domains and fakers are written once, for every source | Each source with its own rules and fakers: duplicated, and inconsistent across sources |
| Speak each upstream's own protocol to clients | One endpoint serves agents, apps, tests and any MCP server for that database | An MCP-only server serves agents, not the app or its tests |
| Read the live database | No copy to store, refresh or leak | Dump-and-mask tools ([Greenmask](https://greenmask.io), [Tonic Structural](https://www.tonic.ai)) work on a copy that goes stale |
| Need nothing installed upstream | A read-only login is all the team grants | [PostgreSQL Anonymizer](https://postgresql-anonymizer.readthedocs.io) masks inside the database, which needs an extension and roles there |
| Fake, not redact | Code needs valid values to run; blanks and tokens break it | Redaction gateways between an agent and a model provider see text, not columns |
| TypeScript 7 on Node 26, run with `npx` | One command, no install; the language of most agent tooling. Node 26 is the LTS line from 28 October 2026; Node 24 is still allowed | A Go binary installs well but loses `npx` |
| A local mapping store | Consistent fakes across sessions, and queries by a fake | Format-preserving encryption needs no store but cannot give realistic emails or names |

## Risks

- **Driver coverage.** The extended query protocol and binary formats vary
  between drivers. v0.1 is tested with `psql`, `node-postgres`, `postgres.js`,
  Drizzle and Prisma 7. Drivers that ask for binary results (asyncpg, pgx,
  JDBC after its prepare threshold) get a clear error until binary formats
  come.
- **Computed values.** A value a query computes (`length(email)`) has no
  column, so it is faked by type, which can surprise. `count(...)` passes.
- **Real order.** Sorting and ranges run upstream, on the real values, so
  fakes come back in an order of their own.
- **The store holds sealed real values** on the machine Sosie runs on. It is
  readable by that machine's user; the threat model says where to run Sosie when
  that matters.
