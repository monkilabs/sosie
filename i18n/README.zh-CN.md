<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/sosie-logo-white.svg">
    <img alt="Sosie" src="../assets/sosie-logo-black.svg" height="56">
  </picture>
</h1>

[English](../README.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **简体中文**

*本文译自[英文版 README](../README.md)，两者有出入时以英文版为准。文中链接的文档均为英文。*

**你的 AI 智能体看到的是你数据的替身，永远不是真身。**

Sosie 位于你的数据和你的 AI 智能体之间。智能体、你的应用及其工具像查询真实数据一样查询它，返回的每个值都是逼真的假值。同一个真实值总是对应同一个假值，所以 join 依然成立，基于假值写的代码无需改动就能在真实数据上运行。真实记录、凭据和主机名都留在你这一侧。

> *Sosie* 在法语里指相貌酷似的人，典出莫里哀《安菲特律翁》中的同名仆人：天神墨丘利变成了和他一模一样的替身。

**[文档和完整介绍：monkilabs.github.io/sosie](https://monkilabs.github.io/sosie/)**

## 状态

Sosie 已发布到 npm，包名为 [`@sosie/cli`](https://www.npmjs.com/package/@sosie/cli)。它已能在 Node 26 和 24 上端到端运行，代理 PostgreSQL 15 至 18、MySQL 8.4 和 9、MongoDB 6.0 至 8.0、REST API 和 GraphQL API。[MVP](../docs/mvp.md)、[概要设计](../docs/hld.md)和[详细设计](../docs/lld.md)说明了它做什么、怎么做。

## 工作方式

在你的项目文件夹里，用你自己的终端（而不是智能体的终端）运行：

```sh
npx @sosie/cli
```

第一次运行时，Sosie 会在不回显的输入提示中询问第一个数据源的连接字符串，然后写入一个 `sosie.yml`，其中只记下存放它的变量名，从不写入连接字符串本身：

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

连接字符串从不作为命令行参数传入：参数会出现在 shell 历史和进程列表里，智能体能读到。下次运行前，在终端里设置 `APP_URL`，或者在提示时再输入一次。

然后把智能体、应用及其测试指向 Sosie 打印出的地址：

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  512.87
 Janick Dach      | paid      |    7.06
 Cristian Kuhlman | shipped   | 3916.25
```

每个值都是对应真实值的假值，类型和格式与之相同。同一个真实值总是对应同一个假值，所以 join 依然成立，智能体见过的值也能找回它所在的行：`WHERE email = 'van29@example.com'` 读到的是这个假值背后的真实行。写操作一律被拒绝。

必要时，检查一下有没有真实值进入对话记录：

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✓ No real values found in 412 files.
```

### 一个文件：sosie.yml

整个工具就是这些：三个命令，一个文件。`sosie.yml` 列出项目的每个数据源（数据库和 API），以及你决定可以原样放行的字段。一个 Sosie 同时服务所有数据源，每个数据源有自己的地址，端口从 7674 起依次递增；同一个人在每个数据源里得到的假值都相同，而 `sosie mcp` 一并提供所有数据源。

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

文件里从不写连接字符串或令牌：每个 `${NAME}` 都从启动 Sosie 的终端读取，或在不回显的输入提示中询问。某个数据源第一次要发送凭据（比如请求头里的令牌）时，Sosie 会说明要发往哪里，并先问过你，这样即使智能体改了文件，也没法不经你同意就把凭据发到别处。要配置的就只有这些：没有命令行选项，除了指向其存储位置的 `SOSIE_HOME`，Sosie 也没有自己的环境变量。用 `npm i -g @sosie/cli` 全局安装一次后，命令就是 `sosie`。[配置说明](https://monkilabs.github.io/sosie/docs/configuration/)列出了所有配置项。

已用 `psql`、`node-postgres`、`postgres.js`、Drizzle 和 Prisma 测试；二进制格式则用 asyncpg 和 pgJDBC 手动验证过。

### 代理你的 API

你团队自己的 REST API 也一样：智能体通过 Sosie 读取它，同一个人从 API 和从数据库得到的是同一个假值。只有 `GET` 和 `HEAD` 请求会到达 API，带的是数据源 `headers` 里 Sosie 的凭据，绝不是智能体的。Sosie 会读取 API 自己提供的 OpenAPI 文档，或数据源的 `schema` 指定的那一份；两者都没有时，它按每个值所在的位置为其命名。API 响应中的链接指向 Sosie，链接里的每个值都换成了假值，访问这样的链接就会读到它所指的记录。属于 API 自身的词，即文档或响应中出现的集合名、查询参数名，保持原样。

GraphQL API 的用法相同，指向它的端点即可（`https://api.internal/graphql`，或 Supabase 的 `/graphql/v1`；端点在其他路径上的，加上 `kind: graphql`）。Sosie 通过内省读取 schema，或从数据源的 `schema` 读取，并据此回答客户端的内省查询；它只向上游转发 query，从不转发 mutation。会写数据的 query 字段，和会写数据的 `GET` 一样，需要 API 自己把关；REST 数据源的 `refuse` 会封掉其中列出的路径。

### 代理 MySQL

数据源用 `mysql://` 连接字符串即可。`mysql` 客户端和你的应用都通过它读取：支持文本语句、一次查询中的多条语句，以及 mysql2 的 `execute()` 和 `mariadb` 驱动所发送的预处理语句。已测试 MySQL 8.4 和 9。给登录账号授予 `SELECT` 和 `SHOW VIEW` 权限，这样视图的列会与其底层表共用相同的假值。

### 代理 MongoDB

数据源用 `mongodb://` 或 `mongodb+srv://` 连接字符串即可。Node.js 驱动（Mongoose 所用的那个）、mongosh 和你的应用都通过它读取。MongoDB 不会说明一个值从何而来，所以 Sosie 从命令中推断：`find` 或聚合管道返回的每个值，按它所来自的集合字段生成假值；如果值是某个阶段计算出来的，则按它的 BSON 类型生成。所有 ObjectId 共用同一套假值，所以集合之间的引用依然成立。已测试 MongoDB 6.0、7.0 和 8.0。给登录账号授予 `read` 角色。

Postgres、MySQL、MongoDB、REST 和 GraphQL 是首批数据源。接下来是 SQL Server，每种数据源都是同一接口背后的一个独立包（[Sosie 如何扩展](../docs/hld.md#how-sosie-grows)）。

### 在你的 AI 助手中

Sosie 也是 Claude Code、GitHub Copilot、VS Code、Cursor、Codex、Kiro 和 Devin 的插件，内含它的 MCP 服务器和一个技能。这个技能告诉智能体如何通过 Sosie 读取数据、假值意味着什么，以及结果为什么可能看起来不对。

```sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
```

Copilot 和 Codex 添加的是同一个插件市场（`copilot plugin marketplace add monkilabs/sosie`、`codex plugin marketplace add monkilabs/sosie`）；Cursor 在 Dashboard → Plugins → Team Marketplaces 中导入它。两个命令都加上 `--scope project` 时，Claude Code 会把它们记录到仓库的 `.claude/settings.json` 中，供整个团队使用。

在 Claude Code、Copilot CLI 和 VS Code 中，插件还会做两件事。会话开始时，它告诉智能体有哪些 Sosie 正在运行；如果项目里有 `sosie.yml` 却没有 Sosie 在运行，就让智能体请你启动一个。会话结束时（在 VS Code 中则是每轮对话之后），它会扫描本次会话的对话记录；如果有真实值进入其中，下一个会话会告诉你。

插件不会启动 Sosie，也不持有任何凭据：Sosie 仍然像上面那样，在你自己的终端里、在项目文件夹中启动。

## 须知

- **排序和范围依据真实值。** `ORDER BY id` 按真实 id 排序，所以返回的假值看起来是乱序的；`WHERE total > 100` 比较的是真实的 total。
- **查询计算出的值按类型生成假值。** `length(email)` 或 `max(id)` 不是假值的长度或最大值。`count(…)` 原样返回。
- **部分匹配找不到假值。** `LIKE '%van%'` 过滤的是真实值，所以用假值的片段什么也查不到。
- **二进制结果**（asyncpg、pgx 和 JDBC 会请求这种格式）是按 Postgres 的发送方式编码的假值。Sosie 无法这样编码的类型（`regclass`、`money`、复合类型、范围类型）在二进制格式下会被拒绝，并报出指明该类型的错误。

## Sosie 不是什么

- **不是托管服务。** 它运行在你的机器上，或你选定的主机上。你的数据不会交给任何人，包括我们。
- **不是写入工具。** 它从不修改你的数据库。
- **不是屏障，挡不住在 Sosie 所在机器上搜寻机密的智能体。** 要防这种情况，就在另一台主机上运行 Sosie，只把它的地址交给智能体。参见[威胁模型](../docs/hld.md#threat-model)。

## 开发

```sh
npm install
npm run check   # typecheck, build, and every test
```

端到端测试会启动一个内嵌的 PostgreSQL 18，以及用各自二进制文件运行的 MySQL 8.4 和 MongoDB 8，这些二进制文件在首次运行时下载。要针对其他服务器运行测试，把 `SOSIE_TEST_DATABASE_URL`、`SOSIE_TEST_MYSQL_URL` 和 `SOSIE_TEST_MONGODB_URL` 设为超级用户或 root 的连接字符串；测试会自己创建数据库和登录账号，结束后再删除。PATH 中有 `psql`，或 `PSQL` 给出了它的路径时，才会运行 `psql` 相关的测试。

## 许可证

MIT
