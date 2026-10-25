# @sosie/cli

**Your AI agent sees a double of your data. Never the real thing.**

Sosie is a read-only endpoint in front of your database that fakes every
value. Your agent, your app and `psql` query it as they would the real thing;
the same real value is always the same fake, so joins hold and a value the
agent saw finds its row again.

In your own terminal, not the agent's:

```sh
export SOSIE_UPSTREAM='postgres://readonly:…@db.internal:5432/app'
npx @sosie/cli
```

| Command | What it does |
| --- | --- |
| `sosie` | Start. Reads `SOSIE_UPSTREAM`, or asks for it at a hidden prompt |
| `sosie mcp` | MCP server over stdio, for the running `sosie` |
| `sosie scan <path>…` | Search files and folders for real values; exit 1 if one is found |

Options: `--port` (7674), `--host` (127.0.0.1), `--rules` (`./sosie.yml`),
`--max-rows` (1000). PostgreSQL 15 to 18; Node 24 or later.

More in the [repository](https://github.com/monkilabs/sosie).
