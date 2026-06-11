const db = require('../config/db');

/**
 * Gathers dashboard telemetry data utilizing the exact workspace and tables registries
 */
const fetchDashboardMetrics = async (userId) => {
  const client = await db.connect();
  
  try {
    // 1. Count workspaces belonging to this user
    const workspaceQuery = `
      SELECT COUNT(*)::int as count FROM workspace WHERE user_id = $1;
    `;
    const { rows: workspaces } = await client.query(workspaceQuery, [userId]);
    const workspaceCount = workspaces[0].count;

    // 2. Count active API keys allocated under this user
    const apiKeyQuery = `
      SELECT COUNT(*)::int as count FROM api_keys WHERE user_id = $1;
    `;
    const { rows: keys } = await client.query(apiKeyQuery, [userId]);
    const apiKeyCount = keys[0].count;

    // 3. Dynamic Storage Calculation
    // Fixed: Uses 't.table_name' and joins on 'w.workspace_id'
    const storageQuery = `
      SELECT COALESCE(SUM(pg_total_relation_size(to_regclass('"' || t.table_name || '_' || t.workspace_id || '"'))), 0)::bigint as bytes
      FROM tables t
      INNER JOIN workspace w ON t.workspace_id = w.workspace_id
      WHERE w.user_id = $1;
    `;
    const { rows: storage } = await client.query(storageQuery, [userId]);
    const totalBytes = storage[0]?.bytes || 0;

    console.log(totalBytes);

   // Convert bytes to Gigabytes safely with 2 decimal precision
const totalStorageGB = parseFloat((Number(totalBytes) / (1024 * 1024 * 1024)).toFixed(2));

    // 4. Hardcoded placeholder for monthly requests (to be implemented later)
    const monthlyRequestsPlaceholder = 12450; 

    return {
      totalStorageGB,
      workspaceCount,
      apiKeyCount,
      monthlyRequests: monthlyRequestsPlaceholder
    };

  } catch (error) {
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Retrieves all workspaces owned by a specific user profile
 */
const getUserWorkspaces = async (userId) => {
  const sql = `
    SELECT workspace_id, workspace_name 
    FROM workspace 
    WHERE user_id = $1
    ORDER BY workspace_name ASC;
  `;

  const { rows } = await db.query(sql, [userId]);
  return rows;
};


/**
 * Retrieves tables and their schemas for a workspace.
 * Strips the workspace ID suffix from the table name before returning.
 */
const getWorkspaceSchema = async (workspaceId) => {
  const sql = `
    SELECT 
      t.table_name AS full_table_name, 
      c.column_name, 
      c.data_type
    FROM tables t
    INNER JOIN information_schema.columns c 
      ON c.table_name = t.table_name
    WHERE t.workspace_id = $1::uuid
      AND c.table_schema = 'public'
    ORDER BY t.table_name, c.ordinal_position;
  `;

  const { rows } = await db.query(sql, [workspaceId]);

  const tablesMap = {};
  const suffixToRemove = `_${workspaceId}`;

  rows.forEach(row => {
    const full_name = row.full_table_name;
    
    // Dynamically remove the "_workspaceId" suffix from the end of the string
    let cleanTableName = full_name;
    if (full_name.toLowerCase().endsWith(suffixToRemove.toLowerCase())) {
      cleanTableName = full_name.slice(0, -suffixToRemove.length);
    }

    if (!tablesMap[cleanTableName]) {
      tablesMap[cleanTableName] = {
        tableName: cleanTableName,
        schema: []
      };
    }
    
    tablesMap[cleanTableName].schema.push({
      columnName: row.column_name,
      dataType: row.data_type
    });
  });

  return Object.values(tablesMap);
};


/**
 * Fetches profile information for a specific user
 */
const getUserProfileById = async (userId) => {
  //on the sql there should be user's plan
  const sql = `
    SELECT name, email
    FROM users 
    WHERE id = $1::uuid;
  `;
  
  const { rows } = await db.query(sql, [userId]);
  return rows[0];
};

/**
 * Fetches all API keys associated with a specific user profile
 */
const getApiKeysByUserId = async (userId) => {
  const sql = `
    SELECT 
      id, 
      key_hint, 
      last_used_at, 
      created_at 
    FROM api_keys 
    WHERE user_id = $1::uuid
    ORDER BY created_at DESC;
  `;

  const { rows } = await db.query(sql, [userId]);
  return rows;
};


module.exports = { fetchDashboardMetrics, getUserWorkspaces, getWorkspaceSchema,
  getUserProfileById,
  getApiKeysByUserId,
 };