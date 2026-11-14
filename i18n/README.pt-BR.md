<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/sosie-logo-white.svg">
    <img alt="Sosie" src="../assets/sosie-logo-black.svg" height="56">
  </picture>
</h1>

[English](../README.md) · [Español](README.es.md) · **Português (Brasil)** · [Français](README.fr.md) · [Deutsch](README.de.md) · [简体中文](README.zh-CN.md)

*Tradução do [README em inglês](../README.md), que é a versão atualizada quando os dois divergem; a documentação dos links está em inglês.*

**Seu agente de IA vê um sósia dos seus dados. Nunca o original.**

O Sosie fica entre os seus dados e o seu agente de IA. O agente, o seu app e as ferramentas dele consultam o Sosie
como consultariam os dados reais, e cada valor volta como um valor falso realista. O mesmo valor real vira sempre o
mesmo valor falso, então os joins continuam funcionando e o código escrito em cima dos valores falsos roda sem
mudança nenhuma nos dados reais. Registros, credenciais e hostnames reais ficam do seu lado.

> *Sosie* é sósia em francês, palavra que vem do criado, no *Anfitrião* de Molière, de quem o deus Mercúrio se torna
> a cópia exata.

**[A documentação e a história completa: monkilabs.github.io/sosie](https://monkilabs.github.io/sosie/)**

## Status

O Sosie 0.4.2 está no npm como [`@sosie/cli`](https://www.npmjs.com/package/@sosie/cli). Ele funciona de ponta a ponta
na frente de PostgreSQL 15 a 18, MySQL 8.4 e 9, MongoDB 6.0 a 8.0, APIs REST e APIs GraphQL, no Node 26 e 24. O
[MVP](../docs/mvp.md), o [design de alto nível](../docs/hld.md) e o [design de baixo nível](../docs/lld.md) explicam o
que ele faz e como.

## Como funciona

Na pasta do seu projeto, no seu próprio terminal, não no do agente:

```sh
npx @sosie/cli
```

Na primeira vez, o Sosie pede a string de conexão da sua primeira fonte num prompt oculto e grava um `sosie.yml` com o
nome da variável onde guardá-la, nunca a string em si:

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

A string de conexão nunca é passada como argumento: argumentos aparecem no histórico do shell e na lista de processos,
onde um agente consegue lê-los. Da próxima vez, defina `APP_URL` no seu terminal ou digite a string no prompt de novo.

Depois, aponte o agente, o app e os testes dele para o endereço que o Sosie mostrou:

```
$ psql postgres://localhost:7674/app -c 'SELECT u.full_name, o.status, o.total FROM orders o JOIN users u ON u.id = o.user_id'
    full_name     |  status   |  total
------------------+-----------+---------
 Janick Dach      | cancelled |  512.87
 Janick Dach      | paid      |    7.06
 Cristian Kuhlman | shipped   | 3916.25
```

Cada valor é um valor falso no lugar do real, do mesmo tipo e formato. O mesmo valor real vira sempre o mesmo valor
falso, então os joins continuam funcionando, e um valor que o agente viu volta a achar a sua linha:
`WHERE email = 'van29@example.com'` lê a linha real por trás desse valor falso. Toda escrita é recusada.

Quando isso importar, confira que nada de real foi parar numa transcrição:

```sh
npx @sosie/cli scan ~/.claude/projects
```

```
  ✓ No real values found in 412 files.
```

### Um arquivo: sosie.yml

Essa é a ferramenta inteira: três comandos e um arquivo. O `sosie.yml` lista todas as fontes do projeto, bancos de
dados e APIs, e os campos que, por decisão sua, podem passar sem alteração. Um só Sosie atende todas, cada uma no seu
próprio endereço, a partir de 7674; uma pessoa tem os mesmos valores falsos em cada uma, e o `sosie mcp` dá acesso a
todas.

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

Nunca se escreve nele uma string de conexão ou um token: cada `${NAME}` é lido do terminal em que o Sosie é iniciado,
ou pedido num prompt oculto. Na primeira vez que uma fonte for enviar um deles, como um token num header, o Sosie diz
para onde vai e pergunta se pode, para que uma edição feita por um agente não consiga mandá-lo para outro lugar sem
consultar você. Não há mais nada para configurar: não existem flags, e a única variável do próprio Sosie é
`SOSIE_HOME`, que diz onde fica o armazenamento dele. Depois de instalar uma vez com `npm i -g @sosie/cli`, o comando
é só `sosie`. Todas as chaves estão em [Configuração](https://monkilabs.github.io/sosie/docs/configuration/).

Testado com `psql`, `node-postgres`, `postgres.js`, Drizzle e Prisma; no formato binário, conferido à mão com asyncpg
e pgJDBC.

### Na frente da sua API

O mesmo vale para a API REST do seu próprio time: o agente lê a API pelo Sosie, e uma pessoa tem os mesmos valores
falsos na API e no banco. Só `GET` e `HEAD` chegam à API, com as credenciais do Sosie, tiradas dos `headers` da fonte,
nunca as do agente. O Sosie lê o documento OpenAPI da API quando ela disponibiliza um, ou o que o `schema` da fonte
indica; sem nenhum, ele identifica cada valor pelo lugar onde ele aparece. Os links nas respostas da API apontam para o
Sosie, com todos os valores neles já trocados por valores falsos, e seguir um deles leva ao registro que ele indica;
uma palavra que é da própria API, como o nome de uma coleção ou de um parâmetro de query que o documento ou as
respostas dela mostram, fica como está.

Uma API GraphQL funciona do mesmo jeito, no endpoint dela (`https://api.internal/graphql`, ou o `/graphql/v1` do
Supabase; em outro caminho, com `kind: graphql`). O Sosie lê o schema por introspecção, ou do `schema` da fonte,
responde à introspecção do cliente a partir dele e só repassa queries, nunca mutations. Proteger um campo de query que
escreve, assim como um `GET` que escreve, fica por conta da API; o `refuse` de uma fonte REST bloqueia os caminhos que
ele lista.

### Na frente do MySQL

Uma fonte com uma string de conexão `mysql://`. O cliente `mysql` e o seu app leem através dela: statements em texto,
vários numa mesma query, e prepared statements, do jeito que o `execute()` do mysql2 e o driver `mariadb` mandam. São
testados o MySQL 8.4 e o 9. Conceda `SELECT` e `SHOW VIEW` ao login, para que as colunas de uma view tenham os mesmos
valores falsos das tabelas de onde vêm.

### Na frente do MongoDB

Uma fonte com uma string de conexão `mongodb://` ou `mongodb+srv://`. O driver de Node.js (o do Mongoose), o mongosh e
o seu app leem através dela. O MongoDB não diz de onde um valor veio, então o Sosie descobre isso pelo comando: cada
valor de um `find` ou de um pipeline vira um valor falso conforme o campo da coleção de onde ele vem, ou conforme o
tipo BSON quando um estágio o calculou. Todo ObjectId compartilha um mesmo domínio, então as referências entre
coleções continuam funcionando. São testados o MongoDB 6.0, 7.0 e 8.0. Dê ao login a role `read`.

Postgres, MySQL, MongoDB, REST e GraphQL são as primeiras fontes. O SQL Server vem em seguida, cada fonte um pacote por
trás da mesma interface ([como o Sosie cresce](../docs/hld.md#how-sosie-grows)).

### No seu assistente

O Sosie também é um plugin para Claude Code, GitHub Copilot, VS Code, Cursor, Codex, Kiro e Devin: o servidor MCP dele
e uma skill que explica ao agente como ler pelo Sosie, o que os valores falsos significam e por que um resultado pode
parecer errado.

```sh
claude plugin marketplace add monkilabs/sosie
claude plugin install sosie@sosie
```

O Copilot e o Codex adicionam o mesmo marketplace (`copilot plugin marketplace add monkilabs/sosie`,
`codex plugin marketplace add monkilabs/sosie`); o Cursor o importa em Dashboard → Plugins → Team Marketplaces. Com
`--scope project` nos dois comandos, o Claude Code os registra no `.claude/settings.json` do repositório, para o time
todo.

No Claude Code, no Copilot CLI e no VS Code, o plugin faz mais duas coisas. Quando uma sessão começa, ele diz ao agente
quais Sosies estão rodando ou, num projeto com um `sosie.yml` e nenhum rodando, que peça para você iniciar um. Quando
uma sessão termina, ou no VS Code depois de cada turno, ele varre a transcrição da sessão, e a sessão seguinte avisa
você se algum valor real chegou a ela.

O plugin não inicia nenhum Sosie e não guarda nenhuma credencial: o Sosie continua sendo iniciado no seu próprio
terminal, na pasta do projeto, como mostrado acima.

## Bom saber

- **Ordem e intervalos seguem os valores reais.** `ORDER BY id` ordena pelos ids reais, então os valores falsos voltam
  fora de ordem; `WHERE total > 100` compara os totais reais.
- **Valores que uma query calcula viram valores falsos conforme o tipo.** `length(email)` ou `max(id)` não são o
  tamanho nem o máximo dos valores falsos. `count(…)` passa sem alteração.
- **Buscas parciais não encontram valores falsos.** `LIKE '%van%'` filtra os valores reais, então um pedaço de um
  valor falso não encontra nada.
- **Resultados em binário,** como o asyncpg, o pgx e o JDBC pedem, são os valores falsos escritos do jeito que o
  Postgres os mandaria. Um tipo que o Sosie não consegue escrever assim (`regclass`, `money`, tipos compostos, ranges)
  é recusado em binário, com um erro que diz qual é o tipo.

## O que o Sosie não é

- **Não é um serviço.** Ele roda na sua máquina, ou num host que você escolhe. Seus dados nunca vão para ninguém, nem
  para nós.
- **Não grava nada.** Ele nunca altera o seu banco de dados.
- **Não é uma barreira contra um agente à caça de segredos** na máquina onde o Sosie roda. Para isso, rode o Sosie em
  outro host e passe ao agente só o endereço dele. Veja o [modelo de ameaças](../docs/hld.md#threat-model).

## Desenvolvimento

```sh
npm install
npm run check   # typecheck, build, and every test
```

Os testes end-to-end sobem um PostgreSQL 18 embutido, e um MySQL 8.4 e um MongoDB 8 a partir dos próprios binários,
baixados na primeira execução. Para rodar os testes contra outros servidores, defina `SOSIE_TEST_DATABASE_URL`,
`SOSIE_TEST_MYSQL_URL` e `SOSIE_TEST_MONGODB_URL` com a string de conexão de um superusuário ou do root; os testes
criam o próprio banco e login, e apagam os dois no final. Os testes do `psql` rodam quando o `psql` está no PATH, ou no
caminho que estiver em `PSQL`.

## Licença

MIT
