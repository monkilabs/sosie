<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/sosie-logo-white.svg">
    <img alt="Sosie" src="../assets/sosie-logo-black.svg" height="56">
  </picture>
</h1>

[English](../README.md) · **Español** · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md)

*Traducción del [README en inglés](../README.md), que es el vigente si no coinciden. Los documentos que enlaza están en inglés.*

**Tu agente de IA ve un doble de tus datos. Nunca los reales.**

Sosie se sitúa entre tus datos y tu agente de IA. El agente, tu app y sus herramientas lo consultan como consultarían el
original, y cada valor vuelve convertido en un valor falso realista. El mismo valor real siempre da el mismo valor
falso, así que los joins siguen funcionando y el código escrito contra los valores falsos se ejecuta sin cambios sobre
los datos reales. Los registros, las credenciales y los nombres de host reales se quedan de tu lado.

> *Sosie* es «sosia» en francés, por el criado del *Anfitrión* de Molière en cuyo doble exacto se convierte el dios
> Mercurio.

**[Documentación e historia completa: monkilabs.github.io/sosie](https://monkilabs.github.io/sosie/)**

## Estado

Sosie está en npm como [`@sosie/cli`](https://www.npmjs.com/package/@sosie/cli). Funciona de extremo a extremo
delante de PostgreSQL 15 a 18, MySQL 8.4 y 9, MongoDB 6.0 a 8.0, APIs REST y GraphQL, en Node 26 y 24. El
[MVP](../docs/mvp.md), el [diseño de alto nivel](../docs/hld.md) y el [diseño de bajo nivel](../docs/lld.md) explican
qué hace y cómo.

## Cómo funciona

En la carpeta de tu proyecto, en tu propia terminal, no en la del agente:

```sh
npx @sosie/cli
```

La primera vez, Sosie te pide la cadena de conexión de tu primera fuente sin mostrar lo que escribes, y crea un
`sosie.yml` que indica la variable donde guardarla, nunca la cadena en sí:

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

La cadena de conexión nunca va como argumento: los argumentos aparecen en el historial de comandos y en la lista de
procesos, donde un agente puede leerlos. La próxima vez, define `APP_URL` en tu terminal o vuelve a escribirla cuando
Sosie te la pida.

Después, apunta el agente, la app y sus tests a la dirección que mostró Sosie:

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  512.87
 Janick Dach      | paid      |    7.06
 Cristian Kuhlman | shipped   | 3916.25
```

Cada valor real se sustituye por un valor falso del mismo tipo y formato. El mismo valor real siempre da el mismo valor
falso, así que los joins siguen funcionando, y un valor que el agente vio vuelve a encontrar su fila:
`WHERE email = 'van29@example.com'` lee la fila real que hay detrás de ese valor falso. Las escrituras se rechazan.

Cuando importe, comprueba que ninguna transcripción contiene nada real:

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✓ No real values found in 412 files.
```

### Un solo archivo: sosie.yml

Esa es toda la herramienta: tres comandos y un archivo. `sosie.yml` enumera todas las fuentes del proyecto, bases de
datos y APIs, y los campos que decides dejar pasar sin cambios. Un solo Sosie las expone todas, cada una en su propia
dirección, a partir del 7674; una persona tiene los mismos valores falsos en todas, y `sosie mcp` las expone todas.

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

En él nunca se escribe una cadena de conexión ni un token: cada `${NAME}` se lee de la terminal donde arranca Sosie, o
se pide sin mostrar lo que escribes. La primera vez que una fuente va a enviar uno, un token en una cabecera, Sosie te
dice adónde y te pide permiso, para que un cambio que haga un agente no pueda enviarlo a otro sitio sin preguntarte. No
hay nada más que configurar: no hay flags, y la única variable propia de Sosie es `SOSIE_HOME`, donde está su almacén.
Si lo instalas una vez con `npm i -g @sosie/cli`, el comando es simplemente `sosie`.
En [Configuración](https://monkilabs.github.io/sosie/docs/configuration/) están todas las claves.

Probado con `psql`, `node-postgres`, `postgres.js`, Drizzle y Prisma; en binario, comprobado a mano con asyncpg y
pgJDBC.

### Delante de tu API

Lo mismo, para la API REST de tu propio equipo: el agente la consulta a través de Sosie, y una persona tiene los mismos
valores falsos en la API que en la base de datos. A la API solo llegan `GET` y `HEAD`, con las credenciales de Sosie,
que salen de los `headers` de la fuente, nunca las del agente. Sosie lee el documento OpenAPI de la API cuando esta lo
sirve, o el que indica el `schema` de la fuente; si no hay ninguno, identifica cada valor por el lugar que ocupa. Los
enlaces de las respuestas de la API apuntan a Sosie, con valores falsos en lugar de los reales, y al seguir uno se lee
el registro que indica; una palabra propia de la API, como el nombre de una colección o de un parámetro de consulta que
aparece en su documento o en sus respuestas, se queda tal cual.

Una API GraphQL funciona igual, en su endpoint (`https://api.internal/graphql`, o el `/graphql/v1` de Supabase; si está
en otra ruta, con `kind: graphql`). Sosie lee el esquema por introspección, o del `schema` de la fuente, responde con
él a la introspección del cliente y solo reenvía consultas, nunca mutaciones. Un campo de consulta que escribe, igual
que un `GET` que escribe, es responsabilidad de la API; el `refuse` de una fuente REST bloquea las rutas que enumera.

### Delante de MySQL

Una fuente con una cadena de conexión `mysql://`. El cliente `mysql` y tu app leen a través de ella: sentencias como
texto, varias por consulta, y preparadas, tal como las envían el `execute()` de mysql2 y el driver `mariadb`. Se prueba
con MySQL 8.4 y 9. Dale al usuario los permisos `SELECT` y `SHOW VIEW`, para que las columnas de una vista compartan los
valores falsos de sus tablas.

### Delante de MongoDB

Una fuente con una cadena de conexión `mongodb://` o `mongodb+srv://`. El driver de Node.js (el de Mongoose), mongosh y
tu app leen a través de ella. MongoDB no dice de dónde viene un valor, así que Sosie lo deduce del comando: cada valor
de un `find` o de un pipeline se sustituye por un valor falso según el campo de la colección del que viene, o según su
tipo BSON cuando lo calcula una etapa. Todos los ObjectId comparten un mismo dominio, así que las referencias entre
colecciones siguen funcionando. Se prueba con MongoDB 6.0, 7.0 y 8.0. Dale al usuario el rol `read`.

Postgres, MySQL, MongoDB, REST y GraphQL son las primeras fuentes. Después viene SQL Server; cada una es un paquete
detrás de la misma interfaz ([cómo crece Sosie](../docs/hld.md#how-sosie-grows)).

### En tu asistente

Sosie también es un plugin para Claude Code, GitHub Copilot, VS Code, Cursor, Codex, Kiro y Devin: su servidor MCP y
una skill que le explica al agente cómo leer a través de Sosie, qué significan los valores falsos y por qué un resultado
puede parecer incorrecto.

```sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
```

Copilot y Codex añaden el mismo marketplace (`copilot plugin marketplace add monkilabs/sosie`,
`codex plugin marketplace add monkilabs/sosie`); Cursor lo importa en Dashboard → Plugins → Team Marketplaces. Con
`--scope project` en los dos comandos, Claude Code los registra en el `.claude/settings.json` del repositorio, para
todo el equipo.

En Claude Code, Copilot CLI y VS Code, el plugin hace dos cosas más. Al empezar una sesión, le dice al agente qué Sosies
están en marcha o, en un proyecto con un `sosie.yml` y ninguno en marcha, que te pida que arranques uno. Al terminar una
sesión, o en VS Code después de cada turno, analiza la transcripción de la sesión, y la siguiente sesión te avisa si
algún valor real llegó a ella.

El plugin no arranca ningún Sosie ni guarda credenciales: Sosie sigue arrancando en tu propia terminal, en la carpeta
del proyecto, como se explica arriba.

## A tener en cuenta

- **El orden y los rangos se basan en los valores reales.** `ORDER BY id` ordena por los ids reales, así que los
  valores falsos vuelven desordenados; `WHERE total > 100` compara los totales reales.
- **Los valores que calcula una consulta se sustituyen por valores falsos según su tipo.** `length(email)` o `max(id)`
  no son la longitud ni el máximo de los valores falsos. `count(…)` pasa sin cambios.
- **Las coincidencias parciales no encuentran valores falsos.** `LIKE '%van%'` filtra los valores reales, así que un
  fragmento de un valor falso no encuentra nada.
- **Los resultados en binario,** como los piden asyncpg, pgx y JDBC, son los valores falsos escritos tal como los
  enviaría Postgres. Un tipo que Sosie no sabe escribir así (`regclass`, `money`, tipos compuestos, rangos) se rechaza
  en binario, con un error que lo nombra.

## Lo que Sosie no es

- **No es un servicio.** Se ejecuta en tu máquina o en un host que tú elijas. Tus datos no se envían a nadie, ni
  siquiera a nosotros.
- **No escribe.** Nunca modifica tu base de datos.
- **No es un muro contra un agente que busca secretos** en la máquina donde se ejecuta Sosie. Para eso, ejecuta Sosie
  en otro host y dale al agente solo su dirección. Consulta el [modelo de amenazas](../docs/hld.md#threat-model).

## Desarrollo

```sh
npm install
npm run check   # typecheck, build, and every test
```

Los tests end-to-end arrancan un PostgreSQL 18 embebido, y MySQL 8.4 y MongoDB 8 desde sus propios binarios, que se
descargan en la primera ejecución. Para ejecutarlos contra otros servidores, define `SOSIE_TEST_DATABASE_URL`,
`SOSIE_TEST_MYSQL_URL` y `SOSIE_TEST_MONGODB_URL` con la cadena de conexión de un superusuario o de root; los tests
crean su propia base de datos y su propio usuario, y los borran al terminar.
Los tests de `psql` se ejecutan cuando `psql` está en el PATH, o en la ruta que indica `PSQL`.

## Licencia

MIT
