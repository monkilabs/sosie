# Sosie

**Your AI agent sees a double of your data. Never the real thing.**

Sosie sits between your data and your AI agent. The agent, your app and its
tools query it as they would the real thing, and every value comes back as a
realistic fake. The same real value is always the same fake, so joins hold and
code written against the fakes runs unchanged on the real data. Real records,
credentials and hostnames stay on your side.

> *Sosie* is French for a lookalike, after the servant in Molière's
> *Amphitryon* whose exact double the god Mercury becomes.

## Status

Design. Nothing is published yet. Read the [MVP](docs/mvp.md), the
[high-level design](docs/hld.md) and the [low-level design](docs/lld.md).

## How it will work

In your own terminal, not the agent's:

```sh
export SOSIE_UPSTREAM='postgres://readonly:…@db.internal:5432/app'
npx @sosie/cli
```

```
  ✓ db.internal/app, read-only: 42 tables
  ✓ Every value is faked; 3 fields pass (sosie.yml)

  Your agent, app and psql:  postgres://localhost:7674/app
  Claude Code:               claude mcp add sosie -- npx @sosie/cli mcp
```

Then check that nothing real reached a transcript:

```sh
npx @sosie/cli scan ~/.claude/projects
```

That is the whole tool: three commands, no config to start, and an optional
`sosie.yml` for the fields you decide may pass unchanged. Installed once with
`npm i -g @sosie/cli`, the command is just `sosie`.

Postgres is the first source. More databases and your own REST and GraphQL
APIs come next, each a package behind the same interface.

## What Sosie is not

- **Not a service.** It runs on your machine, or on a host you choose. Your
  data never goes to anyone, us included.
- **Not a writer.** It never changes your database.
- **Not a wall against an agent hunting for secrets** on the machine Sosie runs
  on. For that, run Sosie on another host and give the agent only its address.
  See the [threat model](docs/hld.md#threat-model).

## License

MIT
