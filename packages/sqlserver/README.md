# @sosie/sqlserver

The SQL Server source of [Sosie](https://github.com/monkilabs/sosie): a local
SQL Server endpoint in front of your database, read-only, that fakes every value
through [`@sosie/core`](https://www.npmjs.com/package/@sosie/core). `sqlcmd`,
your app and its tests connect to it with their own drivers: ODBC, JDBC,
SqlClient or tedious.

Most people want [`@sosie/cli`](https://www.npmjs.com/package/@sosie/cli).
