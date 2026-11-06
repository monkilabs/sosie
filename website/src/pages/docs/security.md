---
layout: ../../layouts/Docs.astro
title: Security
description: What Sosie protects against, what it does not, where to run it, and what it keeps on your machine.
lead: What Sosie promises, plainly, and where the promise ends.
---

## What Sosie protects against

Real values reaching a model through normal agent work:

- **Query results**, from the database and from an API: every value is a fake unless `sosie.yml` lets its field pass.
- **Error messages**, which can quote values from your rows: scrubbed, or reduced to their code.
- **Queries echoed back** with the real values Sosie substituted: the client sees the fakes it sent.
- **Links an API returns**: they point at Sosie, with nothing real in them.
- **Transcripts kept afterwards**: `sosie scan` proves none holds a real value.

And it keeps the source safe: a read-only login and session, a statement timeout and a row cap protect the database;
only `GET`, `HEAD` and GraphQL queries reach an API.

## What it does not protect against

- **An agent hunting for secrets on the same machine.** An agent runs as your user, so it can read the files and
  processes your user can, Sosie's store and environment among them. See [where to run it](#where-to-run-it).
- **Inference through filters.** A query filters on the real data, so a careful sequence of queries can answer
  yes-or-no questions about it.
- **Decoding by comparison.** A value a query computes is faked consistently, so an agent set on it can compute fakes
  of values it chose (`chr(65)`) beside fakes of real ones (`substr(email, 1, 1)`) and match them. Like filters, this
  takes a deliberate sequence of queries, not normal work.
- **Shape.** Row counts, which values are null, and the rough size of values are visible. Order follows the real values.
- **Who can reach the endpoint.** It has no password. On `127.0.0.1`, only this machine can, and web pages cannot: an
  HTTP endpoint answers only requests addressed to `localhost`, and none from a page of another site. On another
  `host`, anyone who reaches that address can query the fakes and filter on the real values, and those two checks
  are off: a web page open in any browser on that network can send requests through Sosie, with its credentials.
- **The API's and the database's structure.** Paths, the OpenAPI document or GraphQL schema with their descriptions,
  status codes, table and column names, the definitions of views and functions, and the server's version are visible:
  they are the system, not values from it. A literal written into a view or a function is visible with it.
- **What the team lets pass.** A field listed under `pass` shows its own values.
- **An edited `sosie.yml`.** It is committed, and an agent can edit it: a field it adds under `pass` shows real values
  once you start Sosie again. Sosie never lets the file hold a credential, nor send one to a host the file writes out:
  each `upstream` is a variable of yours. An edit that has a source send a variable it never sent, or send one to an
  upstream another variable names, is asked about in your terminal before anything is sent, and your answer is kept
  on your machine, not in the file. Each start prints every source's host and how many fields pass; review the file
  as you review code.
- **Fakes crossing sources.** One store serves every source, so a fake from the database typed into an API request turns
  back into its real value, which goes to that API. It never reaches the client.
- **A `GET`, or a GraphQL query field, that writes.** That is the API's to guard; Sosie sends every `GET` and every query
  on.

## Where to run it

On your own machine, Sosie keeps real values out of what the agent is shown, which is what normal agent work needs.

When an agent must not be able to reach the data at all, run Sosie on another host, with the credentials only there,
and give the agent only Sosie's address:

```yaml
# sosie.yml on the host that holds the credentials
host: 10.0.0.12
sources:
  app:
    upstream: ${APP_URL}
```

```sh
# From a file, so the string stays out of shell history
export APP_URL="$(cat /etc/sosie/app-url)"
sosie
```

Sosie warns that the endpoint has no password: anyone who reaches that address can query it, and so can any web page a
browser on that network opens, as the checks for `localhost` and another site's pages hold on `127.0.0.1` only. Keep it
on a network only your team reaches, and no browser there.

## What stays on your machine

- **The store**, `~/.sosie/store/store.db`: each real value as a keyed hash beside its fake, and sealed with AES-256-GCM
  for queries by a fake. It is readable only by your user, as is its key.
- **Nothing else.** Sosie has no account, no telemetry and no hosted part. It talks to your upstream and to its clients,
  and to nothing else.

## Reporting a vulnerability

Please report security issues privately through
[GitHub's security advisories](https://github.com/monkilabs/sosie/security/advisories/new) for the repository, not in a
public issue.
