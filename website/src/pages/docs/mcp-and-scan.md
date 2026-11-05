---
layout: ../../layouts/Docs.astro
title: MCP and scan
description: Sosie's MCP server and its tools for agents, and sosie scan, which proves no real value reached a transcript or a log.
lead: An MCP server for agents that prefer tools to psql, and a scan that checks the result.
---

## sosie mcp

An MCP server over stdio. It talks to the Sosies running on this machine, never to your database or API, so the MCP
process holds no credentials and no real values. In Claude Code, [the plugin](#the-plugin) adds it, with a skill;
without the skill:

```sh
claude mcp add sosie -- npx @sosie/cli mcp
```

For any other MCP client:

```json
{
  "mcpServers": {
    "sosie": { "command": "npx", "args": ["@sosie/cli", "mcp"] }
  }
}
```

Start Sosie first, in your own terminal. When none is running, every tool says so, and how to start it.

### Tools

| Tool | From | Input | Returns |
| --- | --- | --- | --- |
| `describe` | Every Sosie | `entity` (optional) | Entities, fields, types, keys, references, and which fields pass |
| `query` | Postgres | `sql` | Up to 200 rows per statement as JSON, the row count and any notice |
| `request` | REST | `path`: a path and query, or a link Sosie returned | The status and the JSON body of a `GET` through Sosie, up to 200 items of each list |
| `graphql` | GraphQL | `query`, `variables` (optional) | The response of a query through Sosie, up to 200 items of each list |

Each source's tools appear when a Sosie of that kind runs. When several of a kind run, each tool takes the `address`
that `describe` lists; without it, the newest.

## The plugin

The same server as a plugin, in the open [Agent Plugins](https://agent-plugins.org) format, with a skill that tells the
agent how to read through Sosie: start with `describe`, query by the fakes it saw, and why order, partial matches and
computed values follow the real data. Claude Code, GitHub Copilot, VS Code, Cursor, Codex, Kiro and Devin load it.

```sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
```

| Assistant | Add the marketplace |
| --- | --- |
| Claude Code | `claude plugin marketplace add monkilabs/sosie`, then `claude plugin install sosie@sosie` |
| GitHub Copilot | `copilot plugin marketplace add monkilabs/sosie` |
| Codex | `codex plugin marketplace add monkilabs/sosie` |
| Cursor | Dashboard → Plugins → Team Marketplaces → Import, with `monkilabs/sosie` |

With `--scope project` on both commands, Claude Code records them in the repository's `.claude/settings.json`, so the
whole team gets the plugin.

In Claude Code, Copilot CLI and VS Code it also hooks into each session:

- **When a session starts**, it tells the agent which Sosies are running and at which addresses. In a project with a
  `sosie.yml` and no Sosie running, it tells the agent to ask you to start one, and never to ask for the connection
  string.
- **When a session ends**, it runs `sosie scan` in the background on everything the assistant keeps of the session: in
  Claude Code the transcript, its subagents' transcripts and long tool results; in Copilot CLI the session's folder.
  VS Code has no session end: it scans after each turn, one scan at a time. If a real value reached the session, the
  next session to start tells you the file, the line and the field, once, and the agent is told not to open them. A
  scan that fails is reported too, and keeps what earlier scans of the session found.

Cursor and Codex load the MCP server and the skill, but run no hooks from a plugin in this format: their transcripts
are for `sosie scan` by hand.

The plugin starts no Sosie and holds no credentials. It runs `@sosie/cli` at its own version, the one released with it.

## sosie scan

Proof, not trust: `sosie scan` searches files and folders for any real value that passed through Sosie.

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✗ ~/.claude/projects/app/2026-11-02.jsonl:1203  a real value from users.email
  1 real value found in 412 files.
```

It never prints the real value: only the file, the line and the field it came from. It exits 1 when it finds one.

### How it looks

- **Every text file** under the paths given, skipping `.git`, `node_modules` and binary files. JSON string escapes are
  decoded, since transcripts are JSON lines.
- **Runs of words.** Each line is split into words, and every run of one to four words is compared, by keyed hash, with
  the real values in the store. The store holds no plain values to compare against.
- **Only distinctive values:** one to four words of at least four characters, and numbers of six digits or more. Years,
  ports and line numbers are not findings.
- **A fake is not a finding.** It is what the agent was shown.
- **Fields that pass are not looked for**, and neither are an API's own words in its paths and query names.

A common word held as text rather than an enum, a role `admin` or a status `paid`, is looked for like any other value,
so a transcript that uses the word is a finding. Such a field belongs under `pass` in `sosie.yml`.

### As a check

Its exit code makes it a check: a job that runs it fails when a real value reached a file.

```sh
sosie scan ./transcripts ./logs
```

`scan` compares with the store on the machine Sosie ran on, so it runs where the files and the store both are: the
developer's machine, or the host where Sosie runs for the team.
