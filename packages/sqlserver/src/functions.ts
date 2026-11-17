/**
 * SQL Server's own functions: what a query calls by these names reads no table, unless an argument does. Any other
 * name may be a user's function, whose code may read rows the guard cannot see: a query that calls one reads data.
 */
export const NATIVE_FUNCTIONS: ReadonlySet<string> = new Set([
  // Aggregates and windows.
  'avg', 'checksum_agg', 'count', 'count_big', 'grouping', 'grouping_id', 'max', 'min', 'stdev', 'stdevp', 'string_agg', 'sum', 'var', 'varp',
  'approx_count_distinct', 'approx_percentile_cont', 'approx_percentile_disc', 'cume_dist', 'first_value', 'lag', 'last_value', 'lead',
  'percent_rank', 'percentile_cont', 'percentile_disc', 'dense_rank', 'ntile', 'rank', 'row_number',
  // Conversion and logic.
  'cast', 'convert', 'parse', 'try_cast', 'try_convert', 'try_parse', 'choose', 'iif', 'coalesce', 'isnull', 'nullif', 'greatest', 'least',
  // Dates and times.
  'current_timestamp', 'current_timezone', 'current_timezone_id', 'date_bucket', 'dateadd', 'datediff', 'datediff_big', 'datefromparts', 'datename',
  'datepart', 'datetime2fromparts', 'datetimefromparts', 'datetimeoffsetfromparts', 'datetrunc', 'day', 'eomonth', 'getdate', 'getutcdate', 'isdate',
  'month', 'smalldatetimefromparts', 'switchoffset', 'sysdatetime', 'sysdatetimeoffset', 'sysutcdatetime', 'timefromparts', 'todatetimeoffset', 'year',
  // Numbers.
  'abs', 'acos', 'asin', 'atan', 'atn2', 'ceiling', 'cos', 'cot', 'degrees', 'exp', 'floor', 'log', 'log10', 'pi', 'power', 'radians', 'rand', 'round',
  'sign', 'sin', 'sqrt', 'square', 'tan', 'isnumeric', 'bit_count', 'get_bit', 'left_shift', 'right_shift', 'set_bit',
  // Text.
  'ascii', 'char', 'charindex', 'concat', 'concat_ws', 'difference', 'format', 'left', 'len', 'lower', 'ltrim', 'nchar', 'patindex', 'quotename',
  'replace', 'replicate', 'reverse', 'right', 'rtrim', 'soundex', 'space', 'str', 'string_escape', 'stuff', 'substring', 'translate', 'trim',
  'unicode', 'upper', 'datalength', 'string_split', 'regexp_like', 'regexp_replace', 'regexp_substr', 'regexp_instr', 'regexp_count',
  'regexp_matches', 'regexp_split_to_table', 'base64_encode', 'base64_decode', 'unistr',
  // JSON.
  'isjson', 'json_value', 'json_query', 'json_modify', 'json_object', 'json_array', 'json_path_exists', 'json_objectagg', 'json_arrayagg', 'openjson',
  // Hashing and ids.
  'binary_checksum', 'checksum', 'hashbytes', 'newid', 'newsequentialid', 'compress', 'decompress',
  // The session and the schema.
  'app_name', 'col_length', 'col_name', 'columnproperty', 'context_info', 'current_request_id', 'current_transaction_id', 'current_user', 'database_principal_id',
  'databasepropertyex', 'db_id', 'db_name', 'error_line', 'error_message', 'error_number', 'error_procedure', 'error_severity', 'error_state',
  'formatmessage', 'has_dbaccess', 'has_perms_by_name', 'host_id', 'host_name', 'ident_current', 'ident_incr', 'ident_seed', 'index_col', 'indexkey_property',
  'indexproperty', 'is_member', 'is_rolemember', 'is_srvrolemember', 'isnull', 'object_definition', 'object_id', 'object_name', 'object_schema_name',
  'objectproperty', 'objectpropertyex', 'original_login', 'permissions', 'pwdcompare', 'schema_id', 'schema_name', 'scope_identity', 'session_context',
  'session_user', 'sessionproperty', 'stats_date', 'suser_id', 'suser_name', 'suser_sid', 'suser_sname', 'system_user', 'type_id', 'type_name',
  'typeproperty', 'user', 'user_id', 'user_name', 'xact_state', 'collationproperty', 'filegroup_id', 'filegroup_name', 'filegroupproperty', 'file_id',
  'file_idex', 'file_name', 'fileproperty', 'fulltextcatalogproperty', 'fulltextserviceproperty', 'serverproperty', 'connectionproperty',
  'certencoded', 'certprivatekey', 'is_objectsigned', 'min_active_rowversion', 'trigger_nestlevel',
])

/** Functions that read what Sosie must not show, run as another server, or reach outside the database. */
export const REFUSED_FUNCTIONS: Readonly<Record<string, string>> = {
  openrowset: 'reads another server, or files on this one',
  opendatasource: 'reads another server',
  openquery: 'runs a query on a linked server',
  openxml: 'reads a document prepared by a procedure Sosie does not run',
  fn_dblog: 'reads the transaction log, with the real values in it',
  fn_dump_dblog: 'reads the transaction log, with the real values in it',
  fn_full_dblog: 'reads the transaction log, with the real values in it',
  fn_get_audit_file: 'reads audit files, with the real values in them',
  fn_xe_file_target_read_file: 'reads event files, with queries and their values in them',
  fn_trace_gettable: 'reads trace files, with queries and their values in them',
  fn_get_sql: 'reads the text of queries running',
  pwdencrypt: 'hashes passwords',
  certprivatekey: 'reads a private key',
}

/** SERVERPROPERTY's and CONNECTIONPROPERTY's properties that say where the database is: its machine, files or address. */
export const LOCATION_PROPERTIES: ReadonlySet<string> = new Set([
  'machinename', 'servername', 'instancename', 'computernamephysicalnetbios', 'instancedefaultdatapath', 'instancedefaultlogpath',
  'instancedefaultbackuppath', 'errorlogfilename', 'filestreamsharename', 'local_net_address', 'local_tcp_port', 'client_net_address',
])
