const db = require("../config/db");

const DB_CAPACITY_LIMIT_MB = 500;
const CONNECTION_LIMIT = 10;
const MAX_LOG_ROWS = 200;
const HARD_MAX_LOG_ROWS = 1000;

const severityExpression = "COALESCE(meta_data->>'severity', meta_data->>'severity_type', 'unknown')";
const tableExpression = "COALESCE(meta_data->>'table_name', meta_data->>'table nam', meta_data->>'tableName', 'unknown')";
const requestMethodExpression = "COALESCE(meta_data->>'request_method', meta_data->>'request method', meta_data->>'method', 'unknown')";

const timeUnitToMs = {
  min: 60 * 1000,
  hours: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  months: 30 * 24 * 60 * 60 * 1000,
};

const getTimeRange = ({ timeValue = 4, timeUnit = "hours", dateFrom, dateTo }) => {
  const to = dateTo ? new Date(dateTo) : new Date();
  const safeUnit = timeUnitToMs[timeUnit] ? timeUnit : "hours";
  const safeValue = Math.max(1, Number(timeValue) || 4);
  const from = dateFrom ? new Date(dateFrom) : new Date(to.getTime() - safeValue * timeUnitToMs[safeUnit]);

  return {
    from: Number.isNaN(from.getTime()) ? new Date(Date.now() - 4 * timeUnitToMs.hours) : from,
    to: Number.isNaN(to.getTime()) ? new Date() : to,
  };
};

const parseSelectedFilter = (selectedFilter) => {
  if (!selectedFilter) return null;
  if (typeof selectedFilter === "object") return selectedFilter;

  try {
    return JSON.parse(selectedFilter);
  } catch (error) {
    return null;
  }
};

const addEventLogFilter = (filter, values, whereParts) => {
  if (!filter) return;

  if (filter.kind === "severity") {
    values.push(filter.value);
    whereParts.push(`${severityExpression} = $${values.length}`);
  }

  if (filter.kind === "eventType") {
    values.push(filter.value);
    whereParts.push(`event_type = $${values.length}`);
  }

  if (filter.kind === "endpoint") {
    values.push(filter.value);
    whereParts.push(`endpoint = $${values.length}`);
  }

  if (filter.kind === "status") {
    values.push(Number(filter.value));
    whereParts.push(`status_code = $${values.length}`);
  }

  if (filter.kind === "table") {
    values.push(filter.value);
    whereParts.push(`${tableExpression} = $${values.length}`);
  }

  if (filter.kind === "workspace") {
    values.push(filter.value);
    whereParts.push(`workspace_id::text = $${values.length}`);
  }

  if (filter.kind === "latency" || filter.kind === "latencyHour") {
    values.push(Number(filter.min || 0));
    whereParts.push(`duration_ms >= $${values.length}`);
    values.push(Number(filter.max || 999999));
    whereParts.push(`duration_ms < $${values.length}`);
  }

  if (filter.hour) {
    values.push(filter.hour);
    whereParts.push(`to_char(created_at, 'HH24:00') = $${values.length}`);
  }
};

const fetchRows = async (sql, values = []) => {
  const { rows } = await db.query(sql, values);
  return rows;
};

const getAdminByEmail = async (email) => {
  const rows = await fetchRows(
    `
      SELECT admin_id, admin_name, email, password
      FROM admins
      WHERE email = $1
      LIMIT 1;
    `,
    [email]
  );

  return rows[0] || null;
};

const createAdmin = async ({ adminName, email, password }) => {
  const rows = await fetchRows(
    `
      INSERT INTO admins (admin_name, email, password)
      VALUES ($1, $2, $3)
      RETURNING admin_id, admin_name, email;
    `,
    [adminName, email, password]
  );

  return rows[0];
};

const getSafeLogLimit = (limit) => {
  const parsedLimit = Number(limit);
  if (!Number.isFinite(parsedLimit)) return MAX_LOG_ROWS;
  return Math.min(HARD_MAX_LOG_ROWS, Math.max(1, Math.floor(parsedLimit)));
};

const fetchAdminSnapshot = async ({ timeValue, timeUnit, dateFrom, dateTo, selectedFilter, logLimit }) => {
  const { from, to } = getTimeRange({ timeValue, timeUnit, dateFrom, dateTo });
  const filter = parseSelectedFilter(selectedFilter);
  const baseValues = [from, to];
  const safeLogLimit = getSafeLogLimit(logLimit);

  const [
    logs,
    threatFeed,
    destructiveEvents,
    authBreakdown,
    apiUsageRows,
    latencyRows,
    statusCodes,
    databaseStats,
    workspaceConsumers,
    scanRatio,
  ] = await Promise.all([
    fetchEventLogs(baseValues, filter, safeLogLimit),
    fetchThreatFeed(baseValues),
    fetchDestructiveEvents(baseValues),
    fetchAuthBreakdown(baseValues),
    fetchApiUsage(baseValues),
    fetchLatencyMatrix(baseValues),
    fetchStatusCodes(baseValues),
    fetchDatabaseStats(),
    fetchWorkspaceConsumers(),
    fetchScanRatio(),
  ]);

  return {
    generated_at: new Date().toISOString(),
    logs,
    siem: {
      threatFeed,
      destructiveEvents,
      authBreakdown: normalizeAuthBreakdown(authBreakdown),
    },
    performance: {
      apiUsage: normalizeApiUsage(apiUsageRows),
      latencyMatrix: normalizeLatencyMatrix(latencyRows),
      statusCodes,
    },
    database: {
      capacityMb: databaseStats.capacityMb,
      capacityLimitMb: DB_CAPACITY_LIMIT_MB,
      activeConnections: databaseStats.activeConnections,
      connectionLimit: CONNECTION_LIMIT,
      workspaceConsumers,
      scanRatio,
    },
  };
};

const fetchEventLogs = async (baseValues, filter, logLimit) => {
  const values = [...baseValues];
  const whereParts = ["created_at BETWEEN $1 AND $2"];
  addEventLogFilter(filter, values, whereParts);
  values.push(logLimit);

  return fetchRows(
    `
      SELECT
        event_id,
        workspace_id,
        user_id,
        event_type,
        endpoint,
        status_code,
        duration_ms,
        meta_data,
        ip_address,
        created_at
      FROM event_log
      WHERE ${whereParts.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${values.length};
    `,
    values
  );
};

const fetchThreatFeed = (baseValues) =>
  fetchRows(
    `
      SELECT ${severityExpression} AS severity, COUNT(*)::int AS qty
      FROM event_log
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY severity
      ORDER BY qty DESC;
    `,
    baseValues
  );

const fetchDestructiveEvents = async (baseValues) => {
  const rows = await fetchRows(
    `
      SELECT COALESCE(SUM(COALESCE((meta_data->>'row_count')::int, 1)), 0)::int AS total
      FROM event_log
      WHERE created_at BETWEEN $1 AND $2
        AND (
          event_type ILIKE '%DELETE%'
          OR endpoint ILIKE '%delete%'
          OR ${requestMethodExpression} = 'DELETE'
        );
    `,
    baseValues
  );

  return rows[0]?.total || 0;
};

const fetchAuthBreakdown = (baseValues) =>
  fetchRows(
    `
      SELECT
        event_type AS label,
        COUNT(*)::int AS value,
        CASE WHEN event_type = 'USER_LOGGED_IN' THEN 'success' ELSE 'failure' END AS color
      FROM event_log
      WHERE created_at BETWEEN $1 AND $2
        AND event_type IN ('USER_LOGGED_IN', 'LOGIN_FAILURE')
      GROUP BY event_type
      ORDER BY event_type DESC;
    `,
    baseValues
  );

const fetchApiUsage = (baseValues) =>
  fetchRows(
    `
      SELECT
        to_char(date_trunc('hour', created_at), 'HH24:00') AS hour,
        endpoint,
        COUNT(*)::int AS count
      FROM event_log
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY date_trunc('hour', created_at), endpoint
      ORDER BY date_trunc('hour', created_at), count DESC;
    `,
    baseValues
  );

const fetchLatencyMatrix = (baseValues) =>
  fetchRows(
    `
      SELECT
        hour,
        label,
        color,
        min,
        max,
        COUNT(*)::int AS count
      FROM (
        SELECT
          date_trunc('hour', created_at) AS hour_bucket,
          to_char(date_trunc('hour', created_at), 'HH24:00') AS hour,
          CASE
            WHEN duration_ms < 20 THEN '<20ms'
            WHEN duration_ms < 50 THEN '20-50ms'
            WHEN duration_ms < 200 THEN '50-200ms'
            WHEN duration_ms < 1000 THEN '200-1000ms'
            ELSE '>1000ms'
          END AS label,
          CASE
            WHEN duration_ms < 20 THEN 'fast'
            WHEN duration_ms < 50 THEN 'quick'
            WHEN duration_ms < 200 THEN 'normal'
            WHEN duration_ms < 1000 THEN 'heavy'
            ELSE 'danger'
          END AS color,
          CASE
            WHEN duration_ms < 20 THEN 0
            WHEN duration_ms < 50 THEN 20
            WHEN duration_ms < 200 THEN 50
            WHEN duration_ms < 1000 THEN 200
            ELSE 1000
          END::numeric AS min,
          CASE
            WHEN duration_ms < 20 THEN 20
            WHEN duration_ms < 50 THEN 50
            WHEN duration_ms < 200 THEN 200
            WHEN duration_ms < 1000 THEN 1000
            ELSE 999999
          END::numeric AS max
        FROM event_log
        WHERE created_at BETWEEN $1 AND $2
      ) classified
      GROUP BY hour_bucket, hour, label, color, min, max
      ORDER BY hour_bucket;
    `,
    baseValues
  );

const fetchStatusCodes = (baseValues) =>
  fetchRows(
    `
      SELECT status_code AS status, COUNT(*)::int AS count
      FROM event_log
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY status_code
      ORDER BY status_code;
    `,
    baseValues
  );

const fetchDatabaseStats = async () => {
  const rows = await fetchRows(`
    SELECT
      ROUND(pg_database_size(current_database()) / 1024.0 / 1024.0, 2)::float AS "capacityMb",
      (
        SELECT COUNT(*)::int
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
      ) AS "activeConnections";
  `);

  return rows[0] || { capacityMb: 0, activeConnections: 0 };
};

const fetchWorkspaceConsumers = () =>
  fetchRows(`
    SELECT
      regexp_replace(w.workspace_name, '_[0-9a-fA-F-]{36}$', '') AS name,
      w.workspace_name AS "fullName",
      w.workspace_id::text AS "workspaceId",
      ROUND(
        COALESCE(SUM(pg_total_relation_size(to_regclass(format('%I', t.table_name)))), 0)
        / 1024.0 / 1024.0,
        2
      )::float AS "sizeMb"
    FROM workspace w
    LEFT JOIN tables t ON t.workspace_id = w.workspace_id
    GROUP BY w.workspace_id, w.workspace_name
    ORDER BY "sizeMb" DESC
    LIMIT 5;
  `);

const fetchScanRatio = () =>
  fetchRows(`
    SELECT
      relname AS table,
      idx_scan::bigint,
      seq_scan::bigint
    FROM pg_stat_user_tables
    ORDER BY (idx_scan + seq_scan) DESC
    LIMIT 40;
  `);

const normalizeApiUsage = (rows) => {
  const colorMap = ["green", "blue", "orange", "violet", "cyan", "red"];
  const routeColors = new Map();
  const hourMap = new Map();
  const endpoints = [];

  rows.forEach((row) => {
    if (!routeColors.has(row.endpoint)) {
      routeColors.set(row.endpoint, colorMap[routeColors.size % colorMap.length]);
      endpoints.push(row.endpoint);
    }

    if (!hourMap.has(row.hour)) {
      hourMap.set(row.hour, { hour: row.hour, routes: [], total: 0 });
    }

    const point = hourMap.get(row.hour);
    point.routes.push({
      endpoint: row.endpoint,
      label: row.endpoint.replace("/api/", ""),
      count: row.count,
      color: routeColors.get(row.endpoint),
    });
    point.total += row.count;
  });

  return [...hourMap.values()].slice(-12).map((point) => ({
    ...point,
    routes: endpoints.map((endpoint) => {
      const existing = point.routes.find((route) => route.endpoint === endpoint);
      return existing || {
        endpoint,
        label: endpoint.replace("/api/", ""),
        count: 0,
        color: routeColors.get(endpoint),
      };
    }),
  }));
};

const normalizeAuthBreakdown = (rows) => {
  const defaults = [
    { label: "USER_LOGGED_IN", value: 0, color: "success" },
    { label: "LOGIN_FAILURE", value: 0, color: "failure" },
  ];

  return defaults.map((item) => {
    const match = rows.find((row) => row.label === item.label);
    return match ? { ...item, value: Number(match.value) || 0 } : item;
  });
};

const normalizeLatencyMatrix = (rows) => {
  const bucketDefaults = [
    { label: "<20ms", min: 0, max: 20, color: "fast" },
    { label: "20-50ms", min: 20, max: 50, color: "quick" },
    { label: "50-200ms", min: 50, max: 200, color: "normal" },
    { label: "200-1000ms", min: 200, max: 1000, color: "heavy" },
    { label: ">1000ms", min: 1000, max: 999999, color: "danger" },
  ];
  const hourMap = new Map();

  rows.forEach((row) => {
    if (!hourMap.has(row.hour)) {
      hourMap.set(row.hour, { hour: row.hour, buckets: bucketDefaults.map((bucket) => ({ ...bucket, count: 0 })) });
    }

    const point = hourMap.get(row.hour);
    const bucket = point.buckets.find((item) => item.label === row.label);
    if (bucket) bucket.count = row.count;
  });

  return [...hourMap.values()].slice(-12);
};

const blockUserById = async (userId) => {
  const columnRows = await fetchRows(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN ('status', 'is_active', 'is_under_limit');
    `
  );
  const availableColumns = columnRows.map((row) => row.column_name);
  const targetColumn =
    availableColumns.find((column) => column === "status") ||
    availableColumns.find((column) => column === "is_active") ||
    availableColumns.find((column) => column === "is_under_limit");

  if (!targetColumn) {
    return { updated: false, reason: "No supported users status column found." };
  }

  const { rowCount } = await db.query(`UPDATE users SET ${targetColumn} = FALSE WHERE id = $1::uuid;`, [userId]);
  return { updated: rowCount > 0, column: targetColumn };
};

const dropIdleConnections = async () => {
  const rows = await fetchRows(`
    SELECT COUNT(*)::int AS dropped
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state = 'idle'
      AND pg_terminate_backend(pid);
  `);

  return rows[0]?.dropped || 0;
};

const listUsers = () =>
  fetchRows(`
    SELECT id, name, email, auth_provider, is_under_limit
    FROM users
    ORDER BY name ASC
    LIMIT 300;
  `);

const createUser = async ({ name, email, password, auth_provider = "local", is_under_limit = true }) => {
  const rows = await fetchRows(
    `
      INSERT INTO users (name, email, password, auth_provider, is_under_limit)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email, auth_provider, is_under_limit;
    `,
    [name, email, password, auth_provider, is_under_limit]
  );
  return rows[0];
};

const updateUser = async (id, { name, email, auth_provider, is_under_limit }) => {
  const rows = await fetchRows(
    `
      UPDATE users
      SET
        name = COALESCE($2, name),
        email = COALESCE($3, email),
        auth_provider = COALESCE($4, auth_provider),
        is_under_limit = COALESCE($5, is_under_limit)
      WHERE id = $1::uuid
      RETURNING id, name, email, auth_provider, is_under_limit;
    `,
    [id, name || null, email || null, auth_provider || null, typeof is_under_limit === "boolean" ? is_under_limit : null]
  );
  return rows[0];
};

const deleteUser = async (id) => {
  const result = await db.query("DELETE FROM users WHERE id = $1::uuid;", [id]);
  return result.rowCount > 0;
};

const listWorkspaces = () =>
  fetchRows(`
    SELECT
      w.workspace_id,
      regexp_replace(w.workspace_name, '_[0-9a-fA-F-]{36}$', '') AS workspace_name,
      w.workspace_name AS full_workspace_name,
      w.user_id,
      u.email AS owner_email
    FROM workspace w
    LEFT JOIN users u ON u.id = w.user_id
    ORDER BY w.workspace_name ASC
    LIMIT 300;
  `);

const createWorkspaceAdmin = async ({ workspace_name, user_id }) => {
  const actualName = workspace_name.endsWith(`_${user_id}`) ? workspace_name : `${workspace_name}_${user_id}`;
  const rows = await fetchRows(
    `
      INSERT INTO workspace (workspace_name, user_id)
      VALUES ($1, $2::uuid)
      RETURNING workspace_id, workspace_name, user_id;
    `,
    [actualName, user_id]
  );
  return rows[0];
};

const updateWorkspace = async (workspaceId, { workspace_name, user_id }) => {
  const actualName = workspace_name && user_id ? `${workspace_name}_${user_id}` : workspace_name;
  const rows = await fetchRows(
    `
      UPDATE workspace
      SET
        workspace_name = COALESCE($2, workspace_name),
        user_id = COALESCE($3::uuid, user_id)
      WHERE workspace_id = $1::uuid
      RETURNING workspace_id, workspace_name, user_id;
    `,
    [workspaceId, actualName || null, user_id || null]
  );
  return rows[0];
};

const deleteWorkspace = async (workspaceId) => {
  const result = await db.query("DELETE FROM workspace WHERE workspace_id = $1::uuid;", [workspaceId]);
  return result.rowCount > 0;
};

const listApiKeys = () =>
  fetchRows(`
    SELECT ak.id, ak.user_id, u.email AS owner_email, ak.name, ak.key_hint, ak.is_revoked, ak.created_at, ak.last_used_at
    FROM api_keys ak
    LEFT JOIN users u ON u.id = ak.user_id
    ORDER BY ak.created_at DESC
    LIMIT 300;
  `);

const createApiKeyAdmin = async ({ user_id, name, key_hash, key_hint }) => {
  const rows = await fetchRows(
    `
      INSERT INTO api_keys (user_id, name, key_hash, key_hint)
      VALUES ($1::uuid, $2, $3, $4)
      RETURNING id, user_id, name, key_hint, is_revoked, created_at, last_used_at;
    `,
    [user_id, name, key_hash, key_hint]
  );
  return rows[0];
};

const updateApiKey = async (id, { name, is_revoked }) => {
  const rows = await fetchRows(
    `
      UPDATE api_keys
      SET name = COALESCE($2, name),
          is_revoked = COALESCE($3, is_revoked)
      WHERE id = $1::uuid
      RETURNING id, user_id, name, key_hint, is_revoked, created_at, last_used_at;
    `,
    [id, name || null, typeof is_revoked === "boolean" ? is_revoked : null]
  );
  return rows[0];
};

const deleteApiKey = async (id) => {
  const result = await db.query("DELETE FROM api_keys WHERE id = $1::uuid;", [id]);
  return result.rowCount > 0;
};

const getAdminById = async (adminId) => {
  const rows = await fetchRows(
    "SELECT admin_id, admin_name, email FROM admins WHERE admin_id = $1::uuid LIMIT 1;",
    [adminId]
  );
  return rows[0] || null;
};

const updateAdminProfile = async (adminId, { admin_name, email }) => {
  const rows = await fetchRows(
    `
      UPDATE admins
      SET admin_name = COALESCE($2, admin_name),
          email = COALESCE($3, email)
      WHERE admin_id = $1::uuid
      RETURNING admin_id, admin_name, email;
    `,
    [adminId, admin_name || null, email || null]
  );
  return rows[0];
};

const updateAdminPassword = async (adminId, password) => {
  const rows = await fetchRows(
    `
      UPDATE admins
      SET password = $2
      WHERE admin_id = $1::uuid
      RETURNING admin_id;
    `,
    [adminId, password]
  );
  return rows[0];
};

module.exports = {
  getAdminByEmail,
  createAdmin,
  getAdminById,
  updateAdminProfile,
  updateAdminPassword,
  fetchAdminSnapshot,
  blockUserById,
  dropIdleConnections,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listWorkspaces,
  createWorkspaceAdmin,
  updateWorkspace,
  deleteWorkspace,
  listApiKeys,
  createApiKeyAdmin,
  updateApiKey,
  deleteApiKey,
};
