---
layout: ../../layouts/Post.astro
title: Your AI agent sees a double of your data
description: Why I built Sosie, a local proxy that lets an AI agent query your databases and APIs while every value it reads is a consistent, realistic fake.
lead: Agents write better code when they can look at the data. Sosie lets them look without ever seeing the real thing.
author: Filip Mareš
date: 2026-11-25
---

## The problem

A coding agent that can query the database writes better code. It sees the real shape of the data: which columns are
null, how an address is stored, what a status can be. Without that it guesses, and a guess about data is a bug that
shows up later.

But once an agent can query the database, every row it reads goes into a transcript. Customers' names, emails, tokens
and hostnames end up in a context window and in the logs of whatever runs the agent. The usual ways round it each lose
something:

- **Seed data** has the right columns and none of the real shape: no odd nulls, no long tail, no data from five years
  of production.
- **A masked copy** is a second database to build, keep fresh and secure, and masking often breaks the joins that made
  the data worth looking at.
- **Giving the agent no access** brings back the guessing.

## What Sosie does

Sosie sits between your data and your agent. The agent, your app and its tests connect to Sosie as they would to the
real thing, and every value comes back as a realistic fake of the same type and format:

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  512.87
 Janick Dach      | paid      |    7.06
 Cristian Kuhlman | shipped   | 3916.25
```

Three things make that useful rather than just safe:

- **The same real value is always the same fake.** A foreign key fakes like the key it points to, so joins hold, and a
  person is the same fake in every table, every database and every API that Sosie reads.
- **A fake finds its row again.** `WHERE email = 'van29@example.com'` reads the real row behind that fake, so code the
  agent writes against the fakes runs unchanged on the real data.
- **Nothing real leaves your side.** Real records, credentials and hostnames stay in Sosie's process. Writes are
  refused. The connection string is never an argument the agent could read in shell history: Sosie asks for it at a
  hidden prompt and keeps only the name of a variable in `sosie.yml`.

It works in front of PostgreSQL, MySQL, MongoDB, SQL Server, REST APIs and GraphQL APIs, each with its own drivers:
`psql`, Prisma and Drizzle, mysql2, Mongoose, `sqlcmd`, JDBC and the rest talk to it as to the real server.

## Check the transcript

Trust needs a check. `sosie scan` reads an agent's transcripts and says whether any real value reached them:

```sh
npx @sosie/cli scan ~/.claude/projects
```

In Claude Code, Copilot CLI and VS Code, the Sosie plugin runs that scan when a session ends, and tells the next
session if anything real got through. The plugin also brings Sosie's MCP server and a skill to Cursor and Codex.

## What it is not

Sosie is not a service: it runs on your machine, or on a host you choose, and your data goes to no one, us included. It
is not a wall against an agent that hunts for secrets on the machine Sosie runs on; for that, run Sosie on another host
and give the agent only its address. The [security page](../../docs/security/) has the whole threat model.

## Try it

In your project's folder, in your own terminal:

```sh
npx @sosie/cli
```

Sosie is MIT-licensed and [on GitHub](https://github.com/monkilabs/sosie). It is young, at 0.6, and I would like to hear
where it breaks: a driver it confuses, a type it fakes badly, a query it should allow and refuses.
[Open an issue](https://github.com/monkilabs/sosie/issues), or start with the [docs](../../docs/).
