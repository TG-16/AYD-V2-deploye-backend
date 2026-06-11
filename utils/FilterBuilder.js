// File: services/FilterBuilder.js

class FilterBuilder {
  /**
   * Safe mapping definition of native root table layout parameters
   */
  static ROOT_COLUMNS = ['registry_id', 'workspace_id', 'source_table', 'source_row_id', 'created_at', 'updated_at'];

  /**
   * Converts complex query parameter definitions into strict parameterized clauses
   * @param {Object} filters JSON schema payload block
   * @param {number} startingParamIndex Current index offset for SQL parameters ($1, $2...)
   */
  static build(filters, startingParamIndex = 4) {
    if (!filters || Object.keys(filters).length === 0) {
      return { sql: '', values: [] };
    }

    const sqlClauses = [];
    const values = [];
    let paramIndex = startingParamIndex;

    for (const [field, operationMap] of Object.entries(filters)) {
      // 1. Defensively sanitize field paths to block SQL Injection
      const cleanField = field.replace(/[^a-zA-Z0-9_]/g, '');
      const isRoot = this.ROOT_COLUMNS.includes(cleanField);
      
      // Target definition path logic
      const targetColumn = isRoot ? `"${cleanField}"` : `r.metadata->>'${cleanField}'`;

      if (typeof operationMap !== 'object' || Array.isArray(operationMap)) {
        // Fallback handling to support standard equality defaults: { category: "Electronics" }
        sqlClauses.push(`${targetColumn} = $${paramIndex}`);
        values.push(String(operationMap));
        paramIndex++;
        continue;
      }

      for (const [operator, value] of Object.entries(operationMap)) {
        switch (operator) {
          case 'eq':
            sqlClauses.push(`${targetColumn} = $${paramIndex}`);
            values.push(String(value));
            paramIndex++;
            break;
          case 'gt':
            sqlClauses.push(isRoot ? `${targetColumn} > $${paramIndex}` : `(${targetColumn})::numeric > $${paramIndex}`);
            values.push(Number(value));
            paramIndex++;
            break;
          case 'gte':
            sqlClauses.push(isRoot ? `${targetColumn} >= $${paramIndex}` : `(${targetColumn})::numeric >= $${paramIndex}`);
            values.push(Number(value));
            paramIndex++;
            break;
          case 'lt':
            sqlClauses.push(isRoot ? `${targetColumn} < $${paramIndex}` : `(${targetColumn})::numeric < $${paramIndex}`);
            values.push(Number(value));
            paramIndex++;
            break;
          case 'lte':
            sqlClauses.push(isRoot ? `${targetColumn} <= $${paramIndex}` : `(${targetColumn})::numeric <= $${paramIndex}`);
            values.push(Number(value));
            paramIndex++;
            break;
          case 'between':
            if (!Array.isArray(value) || value.length !== 2) break;
            sqlClauses.push(isRoot 
              ? `${targetColumn} BETWEEN $${paramIndex} AND $${paramIndex + 1}`
              : `(${targetColumn})::numeric BETWEEN $${paramIndex} AND $${paramIndex + 1}`
            );
            values.push(Number(value[0]), Number(value[1]));
            paramIndex += 2;
            break;
          case 'in':
            if (!Array.isArray(value)) break;
            const inPlaceholders = value.map((_, i) => `$${paramIndex + i}`).join(', ');
            sqlClauses.push(`${targetColumn} IN (${inPlaceholders})`);
            value.forEach(val => values.push(String(val)));
            paramIndex += value.length;
            break;
          case 'notIn':
            if (!Array.isArray(value)) break;
            const notInPlaceholders = value.map((_, i) => `$${paramIndex + i}`).join(', ');
            sqlClauses.push(`${targetColumn} NOT IN (${notInPlaceholders})`);
            value.forEach(val => values.push(String(val)));
            paramIndex += value.length;
            break;
          case 'contains':
            sqlClauses.push(`${targetColumn} ILIKE $${paramIndex}`);
            values.push(`%${value}%`);
            paramIndex++;
            break;
          case 'startsWith':
            sqlClauses.push(`${targetColumn} ILIKE $${paramIndex}`);
            values.push(`${value}%`);
            paramIndex++;
            break;
          case 'endsWith':
            sqlClauses.push(`${targetColumn} ILIKE $${paramIndex}`);
            values.push(`%${value}`);
            paramIndex++;
            break;
          default:
            break;
        }
      }
    }

    return {
      sql: sqlClauses.length > 0 ? ` AND ${sqlClauses.join(' AND ')}` : '',
      values
    };
  }
}

module.exports = FilterBuilder;