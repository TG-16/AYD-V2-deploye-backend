// Example helper for executing vector search in a specific workspace
const vectorSearchInWorkspace = async (workspaceId, queryVector, limit = 5) => {
  const targetTable = `global_registry_${workspaceId}`;
  const vectorString = JSON.stringify(queryVector);

  const sql = `
    SELECT source_table, source_row_id, metadata, (1 - (embedding <=> $1)) AS similarity
    FROM "${targetTable}"
    WHERE embedding_status = 'completed'
    ORDER BY embedding <=> $1
    LIMIT $2;
  `;

  const { rows } = await db.query(sql, [vectorString, limit]);
  return rows;
};