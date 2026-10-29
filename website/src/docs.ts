/** The docs, in reading order, grouped as the sidebar shows them. */
export const DOCS = [
  { group: 'Start', pages: [
    { path: 'docs/', file: 'index', title: 'Getting started' },
    { path: 'docs/how-it-works/', file: 'how-it-works', title: 'How it works' },
  ] },
  { group: 'Sources', pages: [
    { path: 'docs/postgres/', file: 'postgres', title: 'Postgres' },
    { path: 'docs/rest/', file: 'rest', title: 'REST APIs' },
    { path: 'docs/graphql/', file: 'graphql', title: 'GraphQL APIs' },
  ] },
  { group: 'Reference', pages: [
    { path: 'docs/configuration/', file: 'configuration', title: 'Configuration' },
    { path: 'docs/mcp-and-scan/', file: 'mcp-and-scan', title: 'MCP and scan' },
    { path: 'docs/security/', file: 'security', title: 'Security' },
  ] },
];
