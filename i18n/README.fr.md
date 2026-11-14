<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/sosie-logo-white.svg">
    <img alt="Sosie" src="../assets/sosie-logo-black.svg" height="56">
  </picture>
</h1>

[English](../README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · **Français** · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md)

*Traduction du [README anglais](../README.md), qui est la version à jour en cas d'écart. La documentation liée est en anglais.*

**Votre agent IA voit un sosie de vos données. Jamais les vraies.**

Sosie se place entre vos données et votre agent IA. L'agent, votre application et ses outils l'interrogent comme ils
interrogeraient l'original, et chaque valeur revient remplacée par une valeur factice réaliste. Une même valeur réelle
donne toujours la même valeur factice : les joins restent valides, et le code mis au point sur les valeurs factices
tourne tel quel sur les vraies données. Les vrais enregistrements, identifiants et noms d'hôte restent de votre côté.

> Le nom commun *sosie* vient de Sosie, le valet de l'*Amphitryon* de Molière : le dieu Mercure devient son double
> exact.

**[Documentation et présentation complète : monkilabs.github.io/sosie](https://monkilabs.github.io/sosie/)**

## État

Sosie 0.4.2 est publié sur npm sous le nom [`@sosie/cli`](https://www.npmjs.com/package/@sosie/cli). Il fonctionne de
bout en bout devant PostgreSQL 15 à 18, MySQL 8.4 et 9, MongoDB 6.0 à 8.0, des API REST et des API GraphQL, sous Node 26
et 24. Le [MVP](../docs/mvp.md), la [conception générale](../docs/hld.md) et la [conception détaillée](../docs/lld.md)
décrivent ce qu'il fait et comment.

## Comment ça marche

Dans le dossier de votre projet, dans votre propre terminal, pas dans celui de l'agent :

```sh
npx @sosie/cli
```

La première fois, Sosie vous demande en saisie masquée la chaîne de connexion de votre première source, puis écrit un
`sosie.yml` qui indique la variable où la conserver, jamais la chaîne elle-même :

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

La chaîne de connexion n'est jamais passée en argument : les arguments apparaissent dans l'historique du shell et dans la
liste des processus, où un agent peut les lire. La fois suivante, définissez `APP_URL` dans votre terminal, ou saisissez
de nouveau la chaîne quand Sosie la demande.

Faites ensuite pointer l'agent, l'application et ses tests vers l'adresse affichée par Sosie :

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  512.87
 Janick Dach      | paid      |    7.06
 Cristian Kuhlman | shipped   | 3916.25
```

Chaque valeur est remplacée par une valeur factice du même type et du même format. Une même valeur réelle donne toujours
la même valeur factice, si bien que les joins restent valides et qu'une valeur vue par l'agent retrouve sa ligne :
`WHERE email = 'van29@example.com'` lit la vraie ligne derrière cette valeur factice. Les écritures sont refusées.

Quand c'est important, vérifiez que rien de réel ne s'est retrouvé dans une transcription :

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✓ No real values found in 412 files.
```

### Un seul fichier : sosie.yml

C'est tout l'outil : trois commandes et un fichier. `sosie.yml` liste chaque source du projet, bases de données et API,
ainsi que les champs que vous décidez de laisser passer tels quels. Un seul Sosie les sert toutes, chacune à sa propre
adresse, à partir de 7674 ; une même personne a les mêmes valeurs factices dans chacune, et `sosie mcp` les sert toutes.

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

Aucune chaîne de connexion ni aucun token n'y est écrit : chaque `${NAME}` est lu dans le terminal où Sosie démarre, ou
demandé en saisie masquée. La première fois qu'une source doit envoyer un secret, comme un token dans un en-tête, Sosie
indique où et vous demande votre accord : une modification faite par un agent ne peut donc pas l'envoyer ailleurs sans
que Sosie vous le demande. C'est tout ce qu'il y a à configurer : aucune option en ligne de commande, et aucune variable
propre à Sosie hormis `SOSIE_HOME`, qui indique où se trouve son stockage. Une fois Sosie installé avec
`npm i -g @sosie/cli`, la commande est simplement `sosie`. La page
[Configuration](https://monkilabs.github.io/sosie/docs/configuration/) détaille chaque clé.

Testé avec `psql`, `node-postgres`, `postgres.js`, Drizzle et Prisma ; en binaire, vérifié à la main avec asyncpg et
pgJDBC.

### Devant votre API

De même pour l'API REST de votre équipe : l'agent la lit à travers Sosie, et une même personne a les mêmes valeurs
factices dans l'API et dans la base de données. Seules les requêtes `GET` et `HEAD` atteignent l'API, avec les
identifiants de Sosie, tirés des `headers` de la source, jamais ceux de l'agent. Sosie lit le document OpenAPI de l'API
quand elle en sert un, ou celui que désigne le `schema` de la source ; sans document, il identifie chaque valeur par sa
position. Les liens des réponses de l'API pointent vers Sosie, avec toutes leurs valeurs remplacées par des valeurs
factices, et en suivre un renvoie l'enregistrement qu'il désigne ; un mot propre à l'API, nom de collection ou nom de
paramètre de requête que son document ou ses réponses font apparaître, reste tel quel.

Une API GraphQL fonctionne de la même façon, à son endpoint (`https://api.internal/graphql`, ou `/graphql/v1` chez
Supabase ; à un autre chemin, avec `kind: graphql`). Sosie lit le schéma par introspection, ou depuis le `schema` de la
source, s'en sert pour répondre à l'introspection du client, et ne transmet que les queries, jamais les mutations.
C'est à l'API de protéger un champ de query qui écrit, comme un `GET` qui écrit ; le `refuse` d'une source REST bloque
les chemins qu'il liste.

### Devant MySQL

Une source avec une chaîne de connexion `mysql://`. Le client `mysql` et votre application lisent à travers elle : les
instructions en texte, y compris plusieurs dans une même requête, et les instructions préparées, telles que les envoient
`execute()` de mysql2 et le driver `mariadb`. MySQL 8.4 et 9 sont testés. Accordez au compte de connexion les droits
`SELECT` et `SHOW VIEW`, pour que les colonnes d'une vue partagent les valeurs factices de leurs tables.

### Devant MongoDB

Une source avec une chaîne de connexion `mongodb://` ou `mongodb+srv://`. Le driver Node.js (celui de Mongoose), mongosh
et votre application lisent à travers elle. MongoDB ne dit rien de la provenance d'une valeur, alors Sosie la déduit de
la commande : chaque valeur d'un `find` ou d'un pipeline est remplacée par une valeur factice selon le champ de
collection dont elle provient, ou selon son type BSON quand une étape l'a calculée. Tous les ObjectId partagent un même
domaine, si bien que les références entre collections restent valides. MongoDB 6.0, 7.0 et 8.0 sont testés. Accordez au
compte de connexion le rôle `read`.

Postgres, MySQL, MongoDB, REST et GraphQL sont les premières sources. SQL Server vient ensuite ; chaque source est un
package derrière la même interface ([comment Sosie s'étend](../docs/hld.md#how-sosie-grows)).

### Dans votre assistant

Sosie est aussi un plugin pour Claude Code, GitHub Copilot, VS Code, Cursor, Codex, Kiro et Devin : son serveur MCP, et
une skill qui explique à l'agent comment lire à travers Sosie, ce que signifient les valeurs factices et pourquoi un
résultat peut sembler faux.

```sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
```

Copilot et Codex ajoutent la même marketplace (`copilot plugin marketplace add monkilabs/sosie`,
`codex plugin marketplace add monkilabs/sosie`) ; Cursor l'importe dans Dashboard → Plugins → Team Marketplaces. Avec
`--scope project` sur les deux commandes, Claude Code les enregistre dans le `.claude/settings.json` du dépôt, pour toute
l'équipe.

Dans Claude Code, Copilot CLI et VS Code, le plugin fait deux choses de plus. Au début d'une session, il indique à
l'agent quelles instances de Sosie tournent ou, dans un projet qui a un `sosie.yml` mais aucune instance lancée, lui dit
de vous demander d'en démarrer une. À la fin d'une session, ou dans VS Code après chaque tour, il analyse la
transcription de la session, et la session suivante vous signale si une valeur réelle s'y est retrouvée.

Le plugin ne lance aucun Sosie et ne détient aucun identifiant : Sosie démarre toujours dans votre propre terminal, dans
le dossier du projet, comme plus haut.

## Bon à savoir

- **L'ordre et les plages suivent les valeurs réelles.** `ORDER BY id` trie selon les vrais id, donc les valeurs
  factices reviennent dans le désordre ; `WHERE total > 100` compare les vrais totaux.
- **Une valeur calculée par une requête devient une valeur factice de son type.** `length(email)` ou `max(id)` ne
  donnent pas la longueur ou le maximum des valeurs factices. `count(…)` passe tel quel.
- **Une correspondance partielle ne trouve pas les valeurs factices.** `LIKE '%van%'` filtre les valeurs réelles : un
  morceau de valeur factice ne trouve donc rien.
- **Les résultats binaires,** tels que les demandent asyncpg, pgx et JDBC, sont les valeurs factices écrites comme
  Postgres les enverrait. Un type que Sosie ne sait pas écrire ainsi (`regclass`, `money`, types composites, types range)
  est refusé en binaire, avec une erreur qui le nomme.

## Ce que Sosie n'est pas

- **Pas un service.** Il tourne sur votre machine, ou sur un hôte de votre choix. Vos données ne partent jamais chez
  personne, pas même chez nous.
- **Pas un outil d'écriture.** Il ne modifie jamais votre base de données.
- **Pas un rempart contre un agent qui cherche des secrets** sur la machine où tourne Sosie. Pour vous en protéger,
  faites tourner Sosie sur un autre hôte et ne donnez à l'agent que son adresse. Consultez le
  [modèle de menace](../docs/hld.md#threat-model).

## Développer

```sh
npm install
npm run check   # typecheck, build, and every test
```

Les tests de bout en bout démarrent un PostgreSQL 18 embarqué, ainsi que MySQL 8.4 et MongoDB 8 depuis leurs propres
binaires, téléchargés au premier lancement. Pour les lancer sur d'autres serveurs, donnez à `SOSIE_TEST_DATABASE_URL`,
`SOSIE_TEST_MYSQL_URL` et `SOSIE_TEST_MONGODB_URL` la chaîne de connexion d'un superutilisateur ou de root ; les tests
créent leur propre base et leur propre compte, et les suppriment ensuite. Les tests `psql` tournent quand `psql` est
dans le PATH, ou à l'emplacement indiqué par `PSQL`.

## Licence

MIT
