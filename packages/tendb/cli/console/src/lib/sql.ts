/** Quote an identifier that came out of the catalog. Doubling embedded quotes
 *  is what keeps a table literally named `weird"name` from breaking the query. */
export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function previewQuery(schema: string, table: string, limit = 50): string {
  return `select * from ${quoteIdent(schema)}.${quoteIdent(table)} limit ${limit};`;
}
