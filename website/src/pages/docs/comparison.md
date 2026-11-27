---
layout: ../../layouts/Docs.astro
title: Compared with other tools
description: How Sosie compares with Greenmask, Tonic Structural, PostgreSQL Anonymizer, hoop.dev and Presidio, where it does better, and where another tool fits better.
lead: Five other ways to keep real values from an agent, side by side with Sosie. Where Sosie does better, and where another tool fits the job better.
---

## The other ways

- **A masked copy.** [Greenmask](https://greenmask.io) and [Tonic Structural](https://www.tonic.ai/structural) read the
  database, transform each column by the rule it was given, and write a copy for staging, CI or a developer. The agent
  works on the copy.
- **Masking inside the database.** [PostgreSQL Anonymizer](https://postgresql-anonymizer.readthedocs.io), an extension,
  rewrites the queries of a masked role inside Postgres, by a rule declared on each column. SQL Server's
  [dynamic data masking](https://learn.microsoft.com/en-us/sql/relational-databases/security/dynamic-data-masking) is
  built in, with masks such as `aXXX@XXXX.com`; a filter still runs on the real values, and Microsoft documents that
  they can be inferred from it.
- **A redacting gateway.** [hoop.dev](https://hoop.dev) runs a proxy beside the database that speaks its protocol, has a
  detector find sensitive values in each answer, and redacts them.
- **Redaction before the model.** [Presidio](https://github.com/data-privacy-stack/presidio), alone or as the guardrail
  of an LLM proxy, finds personal data in the text sent to a model and replaces it, by default with a placeholder such
  as `<PERSON>`.
- **A read-only login.** Database MCP servers often have a read-only mode. It stops writes, not reads: every value the
  agent reads goes into the model's context, and into its transcript.

Sosie sits where the gateway does, in front of the live source, and fakes instead of redacting: every value of every
answer, the same way each time, with a fake the agent sends back turned into the real value before the query runs.

## At a glance

Rows in **bold** are where Sosie does better.

<div class="compare">

| | Sosie | Greenmask | Tonic Structural | PostgreSQL Anonymizer | hoop.dev | Presidio |
| --- | --- | --- | --- | --- | --- | --- |
| Works on | The live source, on every query | A dump, restored as a copy | A copy it writes | The live database, for masked roles; or a masked dump | The live source | The text it is given |
| **Hidden unless you let it pass** | Every value of every field | Columns given a transformer | Columns given a generator; a scan suggests them | Columns given a rule; privacy by default, off unless set, puts defaults or `NULL` in the rest | What its detector finds, and columns given a rule | What its detector finds |
| What the agent sees | A fake of the same type and format | The value the column's transformer makes | The value the column's generator makes | A fake, a partial mask (`06******11`) or noise, by rule | A label (`[REDACTED:EMAIL_ADDRESS]`), a mask or a hash | A placeholder (`<PERSON>`), a mask or a hash |
| **The same value, the same fake** | Always: across sessions, and across the fields and sources that share it | With the hash engine; random is the default | With consistent generators; across runs when set | With seeded functions (`anon.seeded_*`) | With the hash strategy, as `sha256:…` | No: one placeholder per type, by default |
| **Query by a value the agent saw** | Finds the real row, today | Finds the copy's row | Finds the copy's row | When the rule is seeded | No: it masks answers, not queries | Not in the query's path |
| Sources | Postgres, MySQL, MongoDB, SQL Server, REST and GraphQL APIs | Postgres; MySQL in beta | Many databases, warehouses and files | Postgres | Many databases, and HTTP, SSH and Kubernetes | Text, images and tables |
| **What it takes to start** | `npx @sosie/cli` and a read-only login | A transformer per column, and a database to restore into | A Tonic instance, and a generator per sensitive column | The extension in the database, a rule per column, a masked role | A sidecar beside the source, joined to a hoop.dev organization | Its analyzer and anonymizer, in the path to the model |
| **Checks transcripts afterwards** | `sosie scan`, which exits 1 on a real value | No | No; its Privacy Hub reports what is protected | No | No; an audit log of each session | No |
| Runs, and license | On your machine, no account; MIT | Where you run it; Apache-2.0 | Self-hosted or Tonic Cloud; commercial, priced by source data | In your database; PostgreSQL License | A self-hosted sidecar; MIT, more than one masking rule needs Enterprise | Where you run it; MIT |

</div>

## Where Sosie does better

### Every value, with no rule for each

Every other tool here protects what it was told about, or what its detector finds. A column nobody gave a rule, one
added last week, a phone number in a free-text note the detector did not recognize: each passes through. Presidio's own
documentation says automated detection cannot guarantee it finds everything, and hoop.dev's that a rule by entity type
masks nothing the detector misses.

Sosie fakes every value of every field. [`pass`](../configuration/) lists the few fields that may show, and is reviewed
like code; the field's name only picks a fake's format, and detection never decides that a value is safe.

### The same fake every time, with nothing to set

The copies keep relationships where a rule is made deterministic: Greenmask's hash engine, Tonic's consistent
generators, PostgreSQL Anonymizer's seeded functions. Each is chosen column by column, Greenmask's default is random, and
Tonic's are consistent across runs only when set to be. Redaction keeps none: every person becomes `<PERSON>`, every
email `[REDACTED:EMAIL_ADDRESS]`, so a join, a `GROUP BY` or a count of distinct values on them is wrong.

In Sosie a real value is always the same fake: in every field that shares it, from every source, in every session.
`orders.user_id` matches `users.id`, and a customer is the same fake in the database and in the billing API.
[Domains](../how-it-works/#domains-which-values-share-fakes) say which fields share fakes.

### Query by what the agent saw, on the live data

With a copy, a value the agent saw finds the copy's row, as it was when the copy was made. With redaction, there is
nothing to query by. Sosie turns a fake in a filter, an API path or a GraphQL argument back into the real value before
the query runs, so `WHERE email = 'van29@example.com'` reads the real row as it is now, faked again on its way back.
An agent can follow up the order a customer reported this morning.

### One command, nothing upstream

`npx @sosie/cli`, in your own terminal, with a read-only login: it writes `sosie.yml` as it starts. There is no copy to
make and refresh, no extension to install in the database, no rule to write per column, and no service to sign in to.
A masked copy needs a database to restore into and a job that keeps it fresh; PostgreSQL Anonymizer, the extension and
a rule on each column; hoop.dev, a sidecar that joins a hoop.dev organization, with one masking rule on its free tier.

### Proof afterwards

[`sosie scan`](../mcp-and-scan/#sosie-scan) reads transcripts and logs, finds any real value that passed through Sosie
by its keyed hash, and exits 1 when it does, so CI can run it. None of the others checks what reached the agent's
transcript: Tonic's Privacy Hub reports which columns are protected, and hoop.dev logs each session and what it masked.

## Where another tool fits better

- **A database to write to, or to hand out.** Staging, CI, a demo, a developer with no access to production: a masked
  copy from Greenmask or Tonic, both of which can also cut a large database down to a subset. Sosie refuses writes, makes no copy,
  and reads the live source on every query.
- **Every client of the database, enforced by it.** PostgreSQL Anonymizer masks a role's queries whatever client sends
  them, with nothing running beside the database. Sosie protects what goes through it; a client given the real
  connection string reads real values.
- **Text from anywhere.** Tickets, documents, chat, a prompt someone pastes: Presidio reads text. Sosie fakes what its
  sources answer and does not see what else reaches the model, and `sosie scan` looks only for values that passed
  through Sosie.
- **Access for a team.** Sign-in, approvals, a record of who ran what: hoop.dev is an access gateway first. Sosie has no
  users; anyone who reaches its address can query the fakes ([Security](../security/#what-it-does-not-protect-against)).
- **Totals that must be real.** Sosie fakes what a query computes, all but `count(…)`, so `sum(total)` is a fake. A
  copy masked with noise, such as Greenmask's noise transformers, keeps totals close to the real ones.

## Together

None of them excludes the others. Sosie in front of the live data for an agent's work, a masked copy for staging and CI,
and Presidio on the path to the model for text that never went through Sosie.

## How this was checked

Each tool as its documentation described it in November 2026: Greenmask 0.2, Tonic Structural, PostgreSQL Anonymizer
3.2, hoop.dev and Presidio 2.2. Tools change; if a row is out of date,
[open an issue](https://github.com/monkilabs/sosie/issues).
