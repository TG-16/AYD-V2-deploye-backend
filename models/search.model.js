const db = require('../config/db');

/**
 * Executes a high-performance Hybrid Search using CTEs to leverage GIN, HNSW, and Trigram indexes.
 */
const executeHybridQuery = async ({ workspaceId, textQuery, vectorQueryString, filterSql, filterValues, candidateLimit }) => {
  const targetTable = `global_registry_${workspaceId}`;
  
  // Positional assignments: $1 = textQuery, $2 = vectorQueryString, $3 = candidateLimit
  // Dynamic filter values will spread sequentially starting from $4
  const queryParams = [textQuery, vectorQueryString, candidateLimit, ...filterValues];

  const sql = `
    WITH fts_search AS (
        SELECT registry_id, ROW_NUMBER() OVER (ORDER BY ts_rank(searchable_tsv, websearch_to_tsquery('english', $1)) DESC) as rank_position
        FROM "${targetTable}" AS r   -- <--- Added alias 'r' here
        WHERE searchable_tsv @@ websearch_to_tsquery('english', $1) ${filterSql}
        LIMIT $3
    ),
    vector_search AS (
        SELECT registry_id, ROW_NUMBER() OVER (ORDER BY embedding <=> $2 ASC) as rank_position
        FROM "${targetTable}" AS r   -- <--- Added alias 'r' here
        WHERE embedding_status = 'completed' ${filterSql}
        LIMIT $3
    ),
    fuzzy_search AS (
        SELECT registry_id, ROW_NUMBER() OVER (ORDER BY similarity(searchable_text, $1) DESC) as rank_position
        FROM "${targetTable}" AS r   -- <--- Added alias 'r' here
        WHERE searchable_text % $1 ${filterSql}
        LIMIT $3
    ),
    unified_universe AS (
        SELECT registry_id FROM fts_search
        UNION
        SELECT registry_id FROM vector_search
        UNION
        SELECT registry_id FROM fuzzy_search
    )
    SELECT 
        u.registry_id, 
        r.source_table, 
        r.source_row_id, 
        r.metadata, 
        r.searchable_text,
        (
            COALESCE((SELECT 1.0 / (60.0 + rank_position) FROM fts_search WHERE registry_id = u.registry_id), 0.0) +
            COALESCE((SELECT 1.0 / (60.0 + rank_position) FROM vector_search WHERE registry_id = u.registry_id), 0.0) +
            COALESCE((SELECT 1.0 / (60.0 + rank_position) FROM fuzzy_search WHERE registry_id = u.registry_id), 0.0)
        ) AS rrf_score
    FROM unified_universe u
    JOIN "${targetTable}" r ON u.registry_id = r.registry_id
    ORDER BY rrf_score DESC;
  `;

  const { rows } = await db.query(sql, queryParams);
  return rows;
};

module.exports = { executeHybridQuery };