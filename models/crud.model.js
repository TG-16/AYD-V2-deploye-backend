const db = require("../config/db");

const createWorkspace = async ({ userId, workspaceName }) => {
  // Get a dedicated client from the connection pool for the transaction
  const client = await db.connect();

  try {
    // 1. Start the transaction
    await client.query('BEGIN');

    // 2. Insert the workspace record
    const insertWorkspaceQuery = `
      INSERT INTO workspace (user_id, workspace_name)
      VALUES ($1, $2)
      RETURNING *;
    `;
    const values = [userId, `${workspaceName}_${userId}`];
    const { rows } = await client.query(insertWorkspaceQuery, values);
    
    const newWorkspace = rows[0];
    // Note: If your primary key column name is 'workspace_id' instead of 'id', change this line to newWorkspace.workspace_id
    const workspaceId = newWorkspace.workspace_id; 

    // 3. Define the dynamic table name using the new workspace UUID
    const targetRegistryTable = `global_registry_${workspaceId}`;

    // 4. Construct the DDL query for the table and its isolated indexes
    // (Identifiers like table and index names cannot be parameterized with $1, so we interpolate them cleanly)
    const createShardedRegistryQuery = `
      CREATE TABLE "${targetRegistryTable}" (
          registry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id UUID NOT NULL,
          source_table TEXT NOT NULL,
          source_row_id UUID NOT NULL,
          searchable_text TEXT,
          searchable_tsv TSVECTOR,
          metadata JSONB,
          embedding VECTOR(384),
          embedding_status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX "idx_registry_tsv_${workspaceId}" ON "${targetRegistryTable}" USING gin(searchable_tsv);
      CREATE INDEX "idx_registry_metadata_${workspaceId}" ON "${targetRegistryTable}" USING gin(metadata);
      CREATE INDEX "idx_registry_embedding_${workspaceId}" ON "${targetRegistryTable}" USING hnsw (embedding vector_cosine_ops);
      CREATE INDEX "idx_registry_lookup_${workspaceId}" ON "${targetRegistryTable}" (source_table, source_row_id);
      CREATE INDEX "idx_registry_pending_${workspaceId}" ON "${targetRegistryTable}" (embedding_status) WHERE embedding_status = 'pending';
    `;

    // 5. Execute the table and index creation within the same transaction block
    await client.query(createShardedRegistryQuery);

    // 5.5. Execute the stored database helper function to provision the GIN trigram index
    // We pass the workspaceId safely as a parameter to bind to the stored function's logic
    await client.query('SELECT configure_workspace_trigram_indexes($1);', [workspaceId]);

    // 6. Commit the transaction if everything succeeded
    await client.query('COMMIT');

    return newWorkspace;

  } catch (error) {
    // If anything fails (e.g., duplicate workspace name, database error), roll back changes
    await client.query('ROLLBACK');
    console.error("Workspace & Registry provisioning failed:", error);
    throw error; 
  } finally {
    // Always release the client back to the pool
    client.release();
  }
};

const createTable = async ({ workspaceId, tableName }) => {
  const actualTableName = `${tableName}_${workspaceId}`;

  // 1. Save metadata
  const insertQuery = `
    INSERT INTO tables (workspace_id, table_name)
    VALUES ($1, $2)
    RETURNING *;
  `;

  const { rows } = await db.query(insertQuery, [
    workspaceId,
    actualTableName,
  ]);

  // 2. Create actual table (Ensure 'id' is a UUID as expected by your trigger)
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS "${actualTableName}" (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid()
    );
  `;
  await db.query(createTableQuery);

  // 3. Attach the Global Registry Sync Trigger
  // We use double quotes around actualTableName to safely handle the hyphens in the UUID
  const attachTriggerQuery = `
    CREATE TRIGGER sync_to_global_registry
    AFTER INSERT OR UPDATE OR DELETE ON "${actualTableName}"
    FOR EACH ROW
    EXECUTE FUNCTION sync_dynamic_table_to_global_registry();
  `;
  await db.query(attachTriggerQuery);

  return rows[0];
};


// Map abstract types to strict SQL data types
const SQL_TYPE_MAP = {
  text: 'VARCHAR(255)',
  number: 'NUMERIC', // Or 'INT' / 'DOUBLE PRECISION' depending on your preference
  date: 'TIMESTAMP', // Or 'DATE' depending on whether you need time tracking
  id: 'UUID'  
};

const addColumns = async (tableName, columns) => {
  const columnDefinitions = columns.map(col => {
    // 1. Resolve to the strict SQL type, default to VARCHAR(255) if 'text' or unrecognized
    const resolvedType = SQL_TYPE_MAP[col.dataType?.toLowerCase()] || 'VARCHAR(255)';
    
    // Clean column name to prevent any unexpected characters (alphanumeric and underscores only)
    const cleanColName = col.name.replace(/[^a-zA-Z0-9_]/g, '');
    
    let parts = [`ADD COLUMN ${cleanColName} ${resolvedType}`];

    // 2. Handle Constraints
    if (col.constraints) {
      if (col.constraints.notNull) parts.push("NOT NULL");
      if (col.constraints.unique) parts.push("UNIQUE");
    }

    // 3. Handle Foreign Keys
    if (col.foreignKey) {
      const { referenceTable, referenceColumn } = col.foreignKey;
      // Sanitize the dynamic reference components
      const cleanRefTable = referenceTable;
      const cleanRefColumn = referenceColumn;
      
      parts.push(`REFERENCES "${cleanRefTable}"(${cleanRefColumn})`);
    }

    return parts.join(" ");
  });

  // Construct the final statement safely
  // Clean the table name one last time for defensive security
  const cleanTableName = tableName;
  const sql = `ALTER TABLE "${cleanTableName}" ${columnDefinitions.join(", ")};`;

  // Execute the query
  return await db.query(sql);
};


const insertData = async ({targetTable, rowsToInsert}) => {
  // 1. Sanitize the table name identifier defensively
//   const cleanTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
const cleanTableName = targetTable;

  // 2. Extract column names from the first object keys and sanitize them
  const columnNames = Object.keys(rowsToInsert[0]).map(col => col.replace(/[^a-zA-Z0-9_]/g, ''));
  
  const valuePlaceholders = [];
  const flatValues = [];
  let placeholderIndex = 1;

  // 3. Dynamically loop through the rowsToInsert array to build the query values safely
  for (const row of rowsToInsert) {
    const rowPlaceholders = [];
    
    for (const column of Object.keys(rowsToInsert[0])) {
      // Push the raw data point to the flat parameter array
      flatValues.push(row[column] !== undefined ? row[column] : null);
      
      // If PostgreSQL: use $1, $2, etc. 
      rowPlaceholders.push(`$${placeholderIndex}`);
      placeholderIndex++;
      
      // IF USING MYSQL: comment out the two lines above and use this line instead:
      // rowPlaceholders.push('?');
    }
    
    // Group this row's placeholders: e.g., "($1, $2, $3)"
    valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
  }

  // 4. Assemble the complete optimized multi-row SQL Statement
  const sql = `
    INSERT INTO "${cleanTableName}" (${columnNames.join(', ')}) 
    VALUES ${valuePlaceholders.join(', ')};
  `;

  // 5. Execute the parameterized array query cleanly
  return await db.query(sql, flatValues);
};



/**
  *Reads records directly from a workspace-sharded user table using dynamic parameterized filters
 **/
const fetchTableData = async ({ workspaceId, tableName, filterSql, filterValues, limit, offset }) => {
  // 1. Defensively sanitize both inputs to prevent SQL Injection on identifiers
  const cleanTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const cleanWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_\-]/g, '');

  // 2. Reconstruct the actual table name matching your database schema layout
  const actualDbTable = `${cleanTableName}_${cleanWorkspaceId}`;

  // $1 = limit, $2 = offset. Dynamic filters map sequentially to $3, $4, etc.
  const queryParams = [limit, offset, ...filterValues];

  const sql = `
    SELECT *
    FROM "${actualDbTable}" r
    WHERE 1=1 ${filterSql}
    LIMIT $1 OFFSET $2;
  `;

  const { rows } = await db.query(sql, queryParams);
  return rows;
};



/**
 * Updates a single row by its "id" column in a specific workspace sharded table
 */
const updateSingleRow = async ({ workspaceId, tableName, id, updates }) => {
  const cleanTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const cleanWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_\-]/g, '');
  const actualDbTable = `${cleanTable}_${cleanWorkspaceId}`;

  const keys = Object.keys(updates);
  if (keys.length === 0) return null;

  const setClauses = [];
  const queryParams = [];
  let paramIndex = 1;

  // Dynamically map update parameters
  for (const key of keys) {
    const cleanKey = key.replace(/[^a-zA-Z0-9_]/g, '');
    setClauses.push(`"${cleanKey}" = $${paramIndex}`);
    queryParams.push(updates[key]);
    paramIndex++;
  }

  // Push the row id to the final parameter position
  queryParams.push(id);
  
  const sql = `
    UPDATE "${actualDbTable}"
    SET ${setClauses.join(', ')}
    WHERE "id" = $${paramIndex}
    RETURNING *;
  `;

  const { rows } = await db.query(sql, queryParams);
  return rows[0] || null;
};

/**
 * Updates multiple rows uniquely by their "id" inside an atomic transactional block
 */
const updateBatchRows = async ({ workspaceId, tableName, records }) => {
  const cleanTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const cleanWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_\-]/g, '');
  const actualDbTable = `${cleanTable}_${cleanWorkspaceId}`;

  const client = await db.connect();
  const updatedRecords = [];

  try {
    await client.query('BEGIN');

    for (const record of records) {
      const { id, updates } = record;
      const keys = Object.keys(updates);
      if (keys.length === 0) continue;

      const setClauses = [];
      const queryParams = [];
      let paramIndex = 1;

      for (const key of keys) {
        const cleanKey = key.replace(/[^a-zA-Z0-9_]/g, '');
        setClauses.push(`"${cleanKey}" = $${paramIndex}`);
        queryParams.push(updates[key]);
        paramIndex++;
      }

      queryParams.push(id);

      const sql = `
        UPDATE "${actualDbTable}"
        SET ${setClauses.join(', ')}
        WHERE "id" = $${paramIndex}
        RETURNING *;
      `;

      const { rows } = await client.query(sql, queryParams);
      if (rows[0]) {
        updatedRecords.push(rows[0]);
      }
    }

    await client.query('COMMIT');
    return updatedRecords;

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};








/**
 * Deletes a single row from a specific workspace sharded table by its id
 */
const deleteSingleRow = async ({ workspaceId, tableName, id }) => {
  const cleanTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const cleanWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_\-]/g, '');
  const actualDbTable = `${cleanTable}_${cleanWorkspaceId}`;

  const sql = `
    DELETE FROM "${actualDbTable}"
    WHERE "id" = $1
    RETURNING *;
  `;

  const { rows } = await db.query(sql, [id]);
  return rows[0] || null;
};

/**
 * Deletes multiple rows from a specific workspace sharded table using an array of ids
 */
const deleteBatchRows = async ({ workspaceId, tableName, ids }) => {
  const cleanTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const cleanWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_\-]/g, '');
  const actualDbTable = `${cleanTable}_${cleanWorkspaceId}`;

  // Dynamically map array positions to parameters ($1, $2, $3...)
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');

  const sql = `
    DELETE FROM "${actualDbTable}"
    WHERE "id" IN (${placeholders})
    RETURNING *;
  `;

  const { rows } = await db.query(sql, ids);
  return rows;
};














module.exports = {
  createWorkspace,
  createTable,
  addColumns,
  insertData,
  fetchTableData,
  updateSingleRow, updateBatchRows,
  deleteSingleRow, deleteBatchRows,
};
