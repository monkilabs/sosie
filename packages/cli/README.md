<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/monkilabs/sosie/main/assets/sosie-logo-white.svg">
  <img alt="Sosie" src="https://raw.githubusercontent.com/monkilabs/sosie/main/assets/sosie-logo-black.svg" height="48">
</picture>

# @sosie/cli

**Your AI agent sees a double of your data. Never the real thing.**

Sosie is a read-only endpoint in front of your Postgres, MySQL or MongoDB
database, or your team's own REST or GraphQL API, that fakes every value. Your
agent, your app and `psql`, `mysql`, `mongosh` or `curl` query it as they would
the real thing; the same real value is always the same fake, so joins hold and a
value the agent saw finds its record again.

In your project's folder, in your own terminal, not the agent's:

```sh
npx @sosie/cli
```

The first time, it asks for your first source's connection string at a hidden prompt and writes `sosie.yml`, the only
configuration there is. It names every source of the project, a database or an API, and the variable that holds each
one's connection string, never the string:

```yaml
sources:
  app:
    upstream: ${APP_URL}
  billing:
    upstream: ${BILLING_API_URL}
    headers:
      Authorization: Bearer ${BILLING_TOKEN}
```

One Sosie serves them all, each at an address of its own.

| Command | What it does |
| --- | --- |
| `sosie` | Start every source `sosie.yml` names; without one, write it first |
| `sosie init` | Write `sosie.yml`, with the first source |
| `sosie mcp` | MCP server over stdio, for every running `sosie` |
| `sosie scan <path>…` | Search files and folders for real values; exit 1 if one is found |

PostgreSQL 15 to 18, MySQL 8.4 and 9, MongoDB 6.0 to 8.0, REST and GraphQL APIs; Node 24 or 26.

The [docs](https://monkilabs.github.io/sosie/docs/) say more, and the [repository](https://github.com/monkilabs/sosie) has the code.
