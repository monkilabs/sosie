<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/sosie-logo-white.svg">
    <img alt="Sosie" src="../assets/sosie-logo-black.svg" height="56">
  </picture>
</h1>

[English](../README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · **Deutsch** · [简体中文](README.zh-CN.md)

*Übersetzt aus der [englischen README](../README.md), die bei Abweichungen aktuell ist. Die verlinkte Doku ist auf Englisch.*

**Dein KI-Agent sieht einen Doppelgänger deiner Daten. Nie das Original.**

Sosie sitzt zwischen deinen Daten und deinem KI-Agenten. Der Agent, deine App und ihre Tools fragen Sosie ab wie das
Original, und jeder Wert kommt als realistischer Fake-Wert zurück. Derselbe echte Wert ergibt immer denselben Fake-Wert.
So bleiben Joins intakt, und Code, der gegen die Fake-Werte geschrieben ist, läuft unverändert mit den echten Daten.
Echte Datensätze, Zugangsdaten und Hostnamen bleiben bei dir.

> *Sosie* heißt auf Französisch Doppelgänger. Das Wort geht auf den Diener in Molières *Amphitryon* zurück, in dessen
> genaues Ebenbild sich der Gott Merkur verwandelt.

**[Doku und die ganze Geschichte: monkilabs.github.io/sosie](https://monkilabs.github.io/sosie/)**

## Status

Sosie ist auf npm als [`@sosie/cli`](https://www.npmjs.com/package/@sosie/cli) verfügbar. Es funktioniert
durchgängig vor PostgreSQL 15 bis 18, MySQL 8.4 und 9, MongoDB 6.0 bis 8.0, REST-APIs und GraphQL-APIs, auf Node 26
und 24. Das [MVP](../docs/mvp.md), das [High-Level-Design](../docs/hld.md) und das [Low-Level-Design](../docs/lld.md)
beschreiben, was Sosie tut und wie.

## So funktioniert es

Im Ordner deines Projekts, in deinem eigenen Terminal, nicht in dem des Agenten:

```sh
npx @sosie/cli
```

Beim ersten Mal fragt Sosie in einer verdeckten Eingabe nach dem Connection-String deiner ersten Quelle und schreibt
eine `sosie.yml`, die die Variable nennt, in der er liegen soll, nie den String selbst:

```
  No sosie.yml here yet: one, with the first database or API Sosie reads.

  Its connection string, or the API's URL (hidden):
  ✓ A Postgres database: db.internal:5432/app
  A name for it (app):
  The variable to keep it in (APP_URL):
  ✓ Wrote sosie.yml: app, its upstream read from ${APP_URL}, never written there. Commit it.
    Set APP_URL in your terminal, and Sosie starts without asking for it.

  ✓ app  db.internal:5432/app, read-only: 42 tables, 3 views
  ✓ Every value is faked

  app:                       postgres://localhost:7674/app
  Claude Code:               claude plugin marketplace add monkilabs/sosie
                             claude plugin install sosie@sosie
  Any MCP client:            npx @sosie/cli mcp
```

Der Connection-String ist nie ein Argument: Argumente stehen in der Shell-History und in der Prozessliste, wo ein Agent
sie lesen kann. Setz beim nächsten Mal `APP_URL` in deinem Terminal oder tipp ihn wieder ein, wenn Sosie danach fragt.

Dann gib dem Agenten, der App und ihren Tests die Adresse, die Sosie ausgegeben hat:

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  512.87
 Janick Dach      | paid      |    7.06
 Cristian Kuhlman | shipped   | 3916.25
```

Jeder Wert wird durch einen Fake-Wert desselben Typs und Formats ersetzt. Derselbe echte Wert ergibt immer denselben
Fake-Wert. So bleiben Joins intakt, und ein Wert, den der Agent gesehen hat, findet seine Zeile wieder:
`WHERE email = 'van29@example.com'` liest die echte Zeile hinter diesem Fake-Wert. Schreibzugriffe werden abgelehnt.

Wenn es darauf ankommt, prüf nach, dass nichts Echtes in einem Transkript gelandet ist:

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✓ No real values found in 412 files.
```

### Eine Datei: sosie.yml

Das ist das ganze Tool: drei Befehle und eine Datei. `sosie.yml` nennt jede Quelle des Projekts, Datenbanken wie APIs,
und die Felder, die du unverändert durchlassen willst. Eine Sosie-Instanz bedient sie alle, jede unter einer eigenen
Adresse, ab 7674 aufwärts; eine Person hat in jeder dieselben Fake-Werte, und `sosie mcp` stellt sie alle bereit.

```yaml
pass:
  - orders.status
  - countries.*

sources:
  app:
    upstream: ${APP_URL}
  billing:
    upstream: ${BILLING_API_URL}
    headers:
      Authorization: Bearer ${BILLING_TOKEN}
  catalog:
    upstream: ${CATALOG_URL}     # https://api.internal/graphql
```

Ein Connection-String oder ein Token steht nie darin: Jedes `${NAME}` wird aus dem Terminal gelesen, in dem Sosie
startet, oder in einer verdeckten Eingabe abgefragt. Wenn eine Quelle zum ersten Mal ein Token in einem Header senden
soll, sagt Sosie, wohin, und fragt nach. So kann ein Agent mit einer Änderung kein Token ungefragt woandershin schicken.
Mehr gibt es nicht zu konfigurieren: keine Flags, und die einzige eigene Variable von Sosie ist `SOSIE_HOME`, wo es
seine Daten ablegt. Einmal mit `npm i -g @sosie/cli` installiert, heißt der Befehl einfach `sosie`.
[Konfiguration](https://monkilabs.github.io/sosie/docs/configuration/) beschreibt jeden Schlüssel.

Getestet mit `psql`, `node-postgres`, `postgres.js`, Drizzle und Prisma; im Binärformat von Hand geprüft mit asyncpg
und pgJDBC.

### Vor deiner API

Dasselbe für die eigene REST-API deines Teams: Der Agent liest sie über Sosie, und eine Person hat in der API dieselben
Fake-Werte wie in der Datenbank. Nur `GET` und `HEAD` erreichen die API, mit Sosies Zugangsdaten aus den `headers` der
Quelle, nie mit denen des Agenten. Sosie liest das OpenAPI-Dokument der API, wenn sie eines bereitstellt, oder das, auf
das `schema` der Quelle zeigt; ohne Dokument benennt Sosie jeden Wert nach der Stelle, an der er steht. Links in den
Antworten der API zeigen auf Sosie, und jeder Wert darin ist gefakt; wer einem Link folgt, liest den Datensatz, auf den
er verweist. Ein Wort, das der API selbst gehört, etwa der Name einer Collection oder eines Query-Parameters aus ihrem
Dokument oder ihren Antworten, bleibt unverändert.

Eine GraphQL-API funktioniert genauso, an ihrem Endpoint (`https://api.internal/graphql` oder `/graphql/v1` bei
Supabase; eine API unter einem anderen Pfad mit `kind: graphql`). Sosie liest das Schema per Introspection oder aus dem
`schema` der Quelle, beantwortet daraus die Introspection des Clients und leitet nur Queries weiter, nie Mutations.
Schreibt ein Query-Feld, muss die API das selbst absichern, wie bei einem `GET`, das schreibt; bei einer REST-Quelle
sperrt `refuse` die Pfade, die dort aufgeführt sind.

### Vor MySQL

Eine Quelle mit einem `mysql://`-Connection-String. Der `mysql`-Client und deine App lesen über Sosie: Statements als
Text, auch mehrere pro Abfrage, und als Prepared Statements, wie `execute()` von mysql2 und der `mariadb`-Treiber sie
senden. Getestet sind MySQL 8.4 und 9. Gib dem Datenbankbenutzer die Rechte `SELECT` und `SHOW VIEW`, damit die
Spalten einer View dieselben Fake-Werte bekommen wie ihre Tabellen.

### Vor MongoDB

Eine Quelle mit einem `mongodb://`- oder `mongodb+srv://`-Connection-String. Der Node.js-Treiber (den auch Mongoose
nutzt), mongosh und deine App lesen über Sosie. MongoDB sagt nicht, woher ein Wert stammt, also liest Sosie das aus dem
Befehl ab: Jeder Wert eines `find` oder einer Pipeline wird nach dem Feld der Collection gefakt, aus dem er stammt, oder
nach seinem BSON-Typ, wenn eine Stage ihn berechnet hat. Alle ObjectIds teilen sich eine Domäne, so bleiben Referenzen
zwischen Collections intakt. Getestet sind MongoDB 6.0, 7.0 und 8.0. Gib dem Datenbankbenutzer die Rolle `read`.

Postgres, MySQL, MongoDB, REST und GraphQL sind die ersten Quellen. Als Nächstes kommt SQL Server, jede Quelle als
eigenes Paket hinter derselben Schnittstelle ([wie Sosie wächst](../docs/hld.md#how-sosie-grows)).

### In deinem Assistenten

Sosie ist auch ein Plugin für Claude Code, GitHub Copilot, VS Code, Cursor, Codex, Kiro und Devin: sein MCP-Server und
ein Skill, der dem Agenten erklärt, wie er über Sosie liest, was die Fake-Werte bedeuten und warum ein Ergebnis falsch
aussehen kann.

```sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
```

Copilot und Codex fügen denselben Marketplace hinzu (`copilot plugin marketplace add monkilabs/sosie`,
`codex plugin marketplace add monkilabs/sosie`); Cursor importiert ihn unter Dashboard → Plugins → Team Marketplaces.
Mit `--scope project` bei beiden Befehlen trägt Claude Code beides in die `.claude/settings.json` des Repositorys ein,
für das ganze Team.

In Claude Code, Copilot CLI und VS Code macht das Plugin noch zwei Dinge. Wenn eine Session startet, sagt es dem
Agenten, welche Sosie-Instanzen laufen. Hat das Projekt eine `sosie.yml` und läuft keine, soll der Agent dich bitten,
eine zu starten. Am Ende einer Session, in VS Code nach jedem Turn, scannt es das Transkript der Session, und die
nächste Session sagt dir, ob ein echter Wert darin gelandet ist.

Das Plugin startet keine Sosie-Instanz und kennt keine Zugangsdaten: Sosie startet weiterhin in deinem eigenen
Terminal, im Ordner des Projekts, wie oben.

## Gut zu wissen

- **Reihenfolge und Bereiche richten sich nach den echten Werten.** `ORDER BY id` sortiert nach den echten IDs, also
  kommen die Fake-Werte unsortiert zurück; `WHERE total > 100` vergleicht die echten Beträge.
- **Werte, die eine Abfrage berechnet, werden nach ihrem Typ gefakt.** `length(email)` oder `max(id)` sind nicht
  Länge oder Maximum der Fake-Werte. `count(…)` kommt unverändert durch.
- **Teiltreffer finden keine Fake-Werte.** `LIKE '%van%'` filtert die echten Werte, ein Stück eines Fake-Werts findet
  also nichts.
- **Binäre Ergebnisse,** wie asyncpg, pgx und JDBC sie anfordern, enthalten die Fake-Werte so, wie Postgres sie senden
  würde. Ein Typ, den Sosie so nicht schreiben kann (`regclass`, `money`, Composite-Typen, Range-Typen), wird im
  Binärformat abgelehnt, mit einem Fehler, der ihn nennt.

## Was Sosie nicht ist

- **Kein Service.** Sosie läuft auf deinem Rechner oder auf einem Host deiner Wahl. Deine Daten gehen an niemanden,
  auch nicht an uns.
- **Kein Schreibzugriff.** Sosie ändert deine Datenbank nie.
- **Kein Schutz vor einem Agenten, der auf Sosies Rechner nach Secrets sucht.** Dafür lass Sosie auf einem anderen
  Host laufen und gib dem Agenten nur die Adresse von Sosie. Siehe das [Bedrohungsmodell](../docs/hld.md#threat-model).

## Entwicklung

```sh
npm install
npm run check   # typecheck, build, and every test
```

Die End-to-End-Tests starten ein eingebettetes PostgreSQL 18 sowie MySQL 8.4 und MongoDB 8 aus ihren eigenen Binaries,
die beim ersten Lauf heruntergeladen werden. Um sie gegen andere Server laufen zu lassen, setz
`SOSIE_TEST_DATABASE_URL`, `SOSIE_TEST_MYSQL_URL` und `SOSIE_TEST_MONGODB_URL` auf den Connection-String eines
Superusers oder von root; die Tests legen ihre eigene Datenbank und ihren eigenen Benutzer an und löschen beide danach.
Die `psql`-Tests laufen, wenn `psql` im PATH liegt oder `PSQL` darauf zeigt.

## Lizenz

MIT
