---
layout: ../../layouts/Docs.astro
title: How it works
description: How Sosie fakes every value consistently, turns fakes in a query back into real values, and keeps the real values on your machine.
lead: A core that knows no database decides every fake. Sources speak each upstream's protocol and say which field each value came from.
---

## A query, end to end

1. Your agent sends `SELECT * FROM users WHERE email = 'kim@example.net'` to Sosie's local address.
2. **Guard.** Sosie parses it: a read, so it is allowed. A write never leaves Sosie.
3. **Turn back.** `kim@example.net` is the fake of a real email, so Sosie puts the real email in its place.
4. **Read.** The query runs upstream on a read-only session, with a timeout and a row cap.
5. **Fake.** Postgres says which table and column each result column came from. Sosie fakes every value by that
   field, and the same real value always gets the same fake.
6. The agent gets rows of fakes, with the real shape: the same types, formats and relationships.

## The faking model

- **Fake by default.** Every value is faked. A value passes unchanged only when [`sosie.yml`](../configuration/) lists
  its field.
- **Consistent.** A real value in a field always becomes the same fake. A foreign key fakes like the key it points to,
  so `orders.user_id` matches `users.id`, and joins hold.
- **Realistic.** The fake has the field's type and, where the field's name says so, a realistic format: emails, names,
  phone numbers, addresses. The name only picks the format; it never lets a value pass.
- **Reversible inside Sosie only.** The store maps fakes back to real values, so queries by a fake work. Real values are
  sealed in the store and never leave Sosie's process.
- **Schema first, detection last.** The database's schema says what each value is. Automatic detection never decides
  that a value is safe.

## Domains: which values share fakes

A domain is the set of real values that share fakes. For a field:

1. **Listed under `pass`:** no domain; the value passes.
2. **It shares another field's values** (a foreign key, or a view's column): that field's domain. `orders.user_id`
   fakes like `users.id`, and a key of two characters stays two characters wherever it appears.
3. **Its format is personal** (email, phone, first name, last name, full name, street, city, postal code): the format's
   domain. One person's email is the same fake in every field, and in every source: the database and the API.
4. **Otherwise:** the field's own.

Values a query computes are faked by their type, in a domain of their own.

## Fakes by type

| Type | Fake |
| --- | --- |
| Text | The field's format when known. Otherwise shaped like the value: an email stays an email, a date a date, a code like `AB-1234` keeps its letters, digits and punctuation, and words become words of about the same length |
| Integer | The same sign and number of digits; never zero for a value that is not zero |
| Decimal | Digits replaced: the same sign, digits and scale |
| UUID | A random UUID |
| Boolean | Flipped or not, decided once per field |
| Enum | A label of the same enum, by a fixed shuffle per field |
| Date, time | Shifted by up to a year, the same shift for the same value |
| JSON | The same structure; each leaf faked by its JSON type, or by the format its key names. A key that looks like a word (`city`, `createdAt`) stays; one that is a value (an email, a name) is faked |
| Array | Each element faked in the field's domain |
| IP address | An address from a documentation range |
| Bytes | Random bytes of the same length |

A value with nothing to fake (`''`, `-`, `NaN`) stays as it is. Fakes are deterministic: each is drawn from a seed
taken from the real value's keyed hash, so the same value gives the same fake in every session.

## Query by what you saw

A fake compared with a field (`email = '…'`, `IN (…)`, `= ANY(…)`, an API path or query parameter, a GraphQL argument)
is looked up in that field's domain and replaced with the real value before the query runs. Booleans and enum labels
turn back by their field's flip and shuffle. A fake Sosie never gave is used as written, so it filters on whatever
real value it happens to be.

Sosie never shows a value it turned back. If the answer holds it, whole or within text, the client sees the fake it
sent, so an API that echoes its filters gives nothing away.

## The store

One SQLite file on the machine Sosie runs on: `~/.sosie/store/store.db`, or under `$SOSIE_HOME`.

- **Keyed hashes, not values.** Each real value is stored as an HMAC-SHA256 of it, beside its fake.
- **Sealed for lookups.** To turn a fake back, the real value is also kept encrypted with AES-256-GCM. It is decrypted
  only inside Sosie's process.
- **One key.** `~/.sosie/store/key` holds 32 random bytes, made on first start, readable only by your user. The hashing,
  sealing and seeding keys are derived from it.
- **One store for every upstream.** Several Sosies share it, so a person is the same fake from the database and from
  the API.

Booleans, enums and bytes are not stored: their fakes come from the key.

## Sources

| Source | Clients speak | Reads only | Names each value from |
| --- | --- | --- | --- |
| [Postgres](../postgres/) | The Postgres wire protocol | Statements are parsed; only reads run, on a read-only session | The table and column Postgres reports for each result column |
| [REST](../rest/) | HTTP, at the API's own paths | `GET` and `HEAD` only | The OpenAPI document, or where each value sits |
| [GraphQL](../graphql/) | GraphQL over HTTP | Queries only, checked against the schema | The schema, by introspection or a file |

A new database or API is a new source package behind the same interface. Rules, domains, fakes, the store, `scan` and
`describe` stay the same for every source.

## What it costs

Sosie keeps no copy of your data: it reads the live source on every query, so nothing goes stale, and the store holds
only what the fakes need. A large API answer is faked a slice at a time, so other clients are answered meanwhile.
