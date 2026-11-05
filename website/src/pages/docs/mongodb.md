---
layout: ../../layouts/Docs.astro
title: MongoDB
description: Sosie in front of MongoDB 6.0 to 8.0 - the protocol, which clients work, what the guard allows, how each value is faked, and the limits.
lead: A local endpoint that speaks MongoDB's wire protocol. mongosh, the drivers, Mongoose and your app connect to it unchanged.
---

## Start it

```sh
export SOSIE_UPSTREAM='mongodb://readonly:…@db.internal:27017/app'
npx @sosie/cli
```

```
  ✓ db.internal:27017/app, read-only: 12 collections, 1 view
  ✓ Every value is faked

  Your agent, app and mongosh: mongodb://127.0.0.1:7674/app?directConnection=true
```

The address takes no user and no password: a client that sends a login is told so. It listens on `127.0.0.1` and
`::1` only, unless you pass `--host`. `directConnection=true` tells the driver Sosie is one server, not a replica set
to discover.

`SOSIE_UPSTREAM` names the database. Atlas's `mongodb+srv://` strings work as they are. For a replica set, give one
host and its `replicaSet` option: the driver finds the other members from it.

MongoDB 6.0, 7.0 and 8.0 are tested; anything older is refused at start-up.

## A read-only login

Sosie runs no command that writes, but a login that cannot write is safer. Sosie warns when its login can change data
or is an administrator.

```js
db.getSiblingDB('app').createUser({ user: 'sosie_reader', pwd: '…', roles: [{ role: 'read', db: 'app' }] })
```

## Clients

Tested with mongosh and the Node.js driver, which Mongoose uses. Sosie answers the handshake itself, as a standalone
server, with the upstream's version, and runs each read upstream in a session of its own. It offers no TLS and no
compression on its own address: it is on your machine. A client's sessions are taken; transactions are refused.

## Over MCP

`sosie mcp` adds two tools for a MongoDB Sosie: `find` (a collection, and optionally a filter, a projection, a sort
and a limit) and `aggregate` (a collection and a pipeline). Each takes JSON or Extended JSON, such as
`{"_id": {"$oid": "…"}}`, and returns up to 200 documents as Extended JSON.

## What the guard allows

Commands are documents, so Sosie needs no parser: it allows each by name, and reads each pipeline stage by stage.

- **Allowed:** `find`, `aggregate`, `count`, `distinct`, `getMore` and `killCursors`; `listCollections`,
  `listIndexes`, `listDatabases` and `dbStats`, which show the schema and sizes.
- **Refused:** every command that writes or changes the server, with `This command changes data. Sosie is
  read-only.`; `explain`, whose plan would print the real values Sosie puts in your filter; `mapReduce`; transactions.
- **Refused databases and collections:** `admin` (users and their password hashes), `local` (the oplog, every write
  with its values), `config`; and `system.profile`, `system.js` and `system.users` in any database.
- **Refused stages:** `$out` and `$merge`, which write; `$currentOp`, `$listSessions`, `$planCacheStats` and
  `$changeStream`, which show other sessions' queries or every change; `$collStats` and `$indexStats`, which say where
  the server is; and any stage Sosie does not know the shape of.
- **No JavaScript on the server:** `$where`, `$function`, `$accumulator`, and code in a document: what it computes
  cannot be read.
- **Answered by Sosie, not the upstream:** `hello`, `ping`, `buildInfo`, `connectionStatus` (no users), `getLog`
  (empty). `hostInfo`, `getCmdLineOpts` and `serverStatus` are refused: they say where the server is.

## The session upstream

One client upstream, with a session per connection to Sosie, so a cursor's `getMore` reaches the session that opened
it, from whichever connection of the driver's pool sends it.

| Setting | Value |
| --- | --- |
| `maxTimeMS` | 30 s on each `find`, `aggregate`, `count` and `distinct`; a client may lower it, never lift it |
| Documents per cursor | `--max-rows`: past it, the cursor is closed, and the terminal running Sosie says so |
| Read preference | The connection string's |
| Heartbeats | Polled, so no `hello` waits on each server |

## Query by what you saw

A value compared by equality with a field is looked up in that field's domain and turned back into the real value:
`{ email: '…' }`, `$eq`, `$ne`, `$in`, `$nin` and `$all`, inside `$and`, `$or`, `$nor`, `$not` and `$elemMatch`, and
a document compared whole. That holds in `find`, `count` and `distinct`, and in each `$match` of a pipeline, against
the documents it filters: a `$match` after a `$group` compares with what the group made.

Every ObjectId shares one domain, so the fake `_id` of a user finds that user's orders:

```js
db.orders.find({ userId: ObjectId('…the _id you saw…') })
```

## What each value becomes

MongoDB's answers say nothing of where a value came from, as Postgres's and MySQL's metadata do. Sosie reads it from
the command: a find's documents are its collection's, through its projection; an aggregation's are read stage by
stage.

| The value | Becomes |
| --- | --- |
| A field of a collection's documents, through a projection, `$project`, `$lookup`, `$unwind`, `$replaceRoot` and `$facet` | A fake by its field: `collection.path` |
| An ObjectId, in any field | A fake in the one domain all ObjectIds share: 24 hex digits, its time shifted by up to a year |
| A `$group`'s `_id` by a field, and `$first`, `$last`, `$min`, `$max`, `$push` or `$addToSet` of one | A fake by that field |
| A count: `$count`, `$sum: 1`, the `count` command | Unchanged |
| A literal you wrote: `$literal`, `$documents` | Unchanged |
| Anything else a pipeline computes (`$toUpper`, `$avg`, `$concat`) | A fake by its BSON type |
| A field a `$unionWith` takes from two collections | A fake by its type, unless both name the same field |
| A key that is not a word, as in a map keyed by email | Faked, each to one fake |

Each value keeps its BSON type: an `Int32` stays an `Int32`, and a `Long`, a `Double`, a `Decimal128`, a date, an
ObjectId, a UUID and binary data their own. Sosie learns each field as documents come, and from a collection's
`$jsonSchema` validator: `describe` lists them, and `sosie.yml` names them as `collection.path`
(`users.address.city`).

## Errors

- An error about the command itself (an unknown operator or stage, a bad option, the time limit) comes back, scrubbed
  of every value Sosie turned back.
- Any other comes back as its code only: `Error 241 (ConversionFailure): Sosie hides the rest of this message, which
  may quote a value from your documents.`

## Limits

- Order and ranges follow the real values: `sort` orders by them, and `$gt` or `$lt` compare them.
- A regular expression, `$text` and `$expr` filter on the real values, so a piece of a fake finds nothing.
- A value Sosie never showed is used as written, so it filters on the real value it happens to be.
- A stage Sosie does not know the shape of is refused, as is anything it cannot read: change streams, JavaScript.
- A cursor cut at `--max-rows` ends with nothing to say so: MongoDB has no warnings for Sosie to add one to. The
  terminal running Sosie says so.
- A timestamp (BSON's internal type) is faked as a date, to the second. `MinKey` and `MaxKey` pass.
- `listIndexes` and `listCollections` show an index's filter and a view's pipeline as they were written, a value in
  them included.
- A fake in `$expr`, in a `$lookup`'s `let`, or in an index bound is used as written.
