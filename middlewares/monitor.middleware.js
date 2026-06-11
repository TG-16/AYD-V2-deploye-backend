// middlewares/monitorMiddleware.js
const { queueLog } = require("../utils/logQueue");

const monitorMiddleware = (req, res, next) => {
  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationInMs = parseFloat((diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2));

    const path = req.originalUrl.split('?')[0]; // Strip query parameters for clean matching
    const method = req.method;
    const statusCode = res.statusCode;

    // 1. Resolve User and Workspace Identity
    const user_id = req.user && req.user.id ? req.user.id : null;
    const workspace_id = req.body?.workspaceId || req.query?.workspaceId || req.params?.workspaceId || null;
    const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

    // 2. Initialize Core SIEM Variable Containers
    let event_type = 'UNKNOWN_EVENT';
    let severity = 'LOW';

    // 3. Precise Route Mapping Matrix
    // --- AUTHENTICATION ROUTES ---
    if (path.includes('/api/auth')) {
      severity = statusCode >= 400 ? 'MEDIUM' : 'LOW'; // Elevate failed auth security posture

      switch (path) {
        case '/api/auth/register':
          event_type = statusCode === 200 ? 'USER_REGISTERED' : 'REGISTRATION_FAILED';
          break;
        case '/api/auth/login':
          event_type = statusCode === 200 ? 'USER_LOGGED_IN' : 'LOGIN_FAILURE';
          if (statusCode === 400) severity = 'HIGH'; // Brute-force signal tracking
          break;
        case '/api/auth/restPassword':
          event_type = 'PASSWORD_RESET_REQUESTED';
          break;
        case '/api/auth/realResetPassword':
          event_type = statusCode === 200 ? 'PASSWORD_RESET_COMPLETED' : 'PASSWORD_RESET_FAILED';
          break;
        case '/api/auth/createApiKey':
          event_type = statusCode === 200 ? 'API_KEY_CREATED' : 'API_KEY_CREATION_FAILED';
          break;
        case '/api/auth/changePassword':
          event_type = statusCode === 200 ? 'PASSWORD_CHANGED' : 'PASSWORD_CHANGE_FAILED';
          break;
        case '/api/auth/google':
          event_type = 'GOOGLE_AUTH_INITIATED';
          break;
        case '/api/auth/google/callback':
          event_type = statusCode === 200 ? 'GOOGLE_LOGIN_SUCCESSFUL' : 'GOOGLE_LOGIN_FAILED';
          break;
      }
    }


    // --- admin routes
    else if (path.includes('/api/admin')) {
      severity = statusCode >= 400 ? 'MEDIUM' : 'LOW'; // Elevate failed auth security posture

      switch (path) {
        case '/api/admin/auth/register':
          event_type = statusCode === 200 ? 'ADMIN_REGISTERED' : 'ADMIN_REGISTRATION_FAILED';
          break;
        case '/api/admin/auth/login':
          event_type = statusCode === 200 ? 'ADMIN_LOGGED_IN' : 'ADMIN_LOGIN_FAILURE';
          if (statusCode === 400) severity = 'HIGH';
          break;
        case '/api/admin/settings/password':
          event_type = statusCode === 200 ? 'ADMIN_PASSWORD_RESET_COMPLETED' : 'ADMIN_PASSWORD_RESET_FAILED';
          break;
        case '/api/admin/manage/api-keys':
          event_type = statusCode === 200 ? 'API_KEY_CREATED' : 'API_KEY_CREATION_FAILED';
          break;
        case '/api/admin//manage/workspaces':
          event_type = statusCode === 200 ? 'WORKSPACE_CREATED' : 'WORKSPACE_CREATION_FAILED';
          break;
        case '/api/admin/manage/users':
          event_type = statusCode === 200 ? 'USER_CREATED' : 'USER_CREATION_FAILED';
          break;
        case '/api/admin/snapshot':
          event_type = statusCode === 200 ? 'SNAPSHOT_SUCCESSFUL' : 'SNAPSHOT_FAILED';
          break;
      }
    }

    // --- CRUD / ENGINE WORKSPACE ROUTES ---
    else if (path.includes('/api/crud')) {
      severity = statusCode >= 400 ? 'MEDIUM' : 'LOW';

      switch (path) {
        case '/api/crud/createWorkspace':
          event_type = 'WORKSPACE_CREATED';
          break;
        case '/api/crud/createTable':
          event_type = 'TABLE_CREATED';
          break;
        case '/api/crud/addColumns':
          event_type = 'COLUMNS_ADDED';
          break;
        case '/api/crud/insertData':
          event_type = 'DATA_INSERTED';
          if (statusCode === 413) severity = 'MEDIUM'; // Payload too large flag
          break;
        case '/api/crud/readData':
          event_type = 'DATA_RETRIEVED';
          break;
        case '/api/crud/editSingleData':
          event_type = 'SINGLE_RECORD_UPDATED';
          break;
        case '/api/crud/editBatchData':
          event_type = 'BATCH_UPDATE_EXECUTED';
          severity = statusCode === 200 ? 'MEDIUM' : 'HIGH'; // Scale based on impact scope
          break;
        case '/api/crud/deleteSingleData':
          event_type = 'SINGLE_RECORD_DELETED';
          severity = 'MEDIUM';
          break;
        case '/api/crud/deleteBatchData':
          event_type = 'BATCH_DELETE_EXECUTED';
          severity = statusCode === 200 ? 'HIGH' : 'CRITICAL'; // Massive destruction risk vectors
          break;
      }
    }

    // --- HYBRID SEARCH ENGINE CORRIDOR ---
    else if (path.includes('/api/search')) {
      if (path === '/api/search/globalSearch') {
        event_type = 'GLOBAL_HYBRID_SEARCH_PERFORMED';
        severity = durationInMs > 2000 ? 'MEDIUM' : 'LOW'; // Heavy vector distance calculation monitoring
      }
    }

    // --- INTERNAL APPLICATION CONTROL DASHBOARD ROUTES ---
    else if (path.includes('/api/app')) {
      switch (path) {
        case '/api/app/dashboard':
          event_type = 'DASHBOARD_VIEWED';
          break;
        case '/api/app/workspaces':
          event_type = 'WORKSPACE_LIST_REQUESTED';
          break;
        case '/api/app/tables':
          event_type = 'TABLE_OVERVIEW_REQUESTED';
          break;
        case '/api/app/showProfile':
          event_type = 'PROFILE_VIEWED';
          break;
        case '/api/app/getApiKeys':
          event_type = 'API_KEYS_VIEWED';
          break;
      }
    }

    // 4. Fallback for unmapped or unauthorized generic rejects
    if (event_type === 'UNKNOWN_EVENT' && statusCode === 401) {
      event_type = 'UNAUTHORIZED_ACCESS_DENIED';
      severity = 'HIGH';
    }

    // 5. Package Telemetry Payload Meta Block
    const logData = {
      workspace_id,
      user_id,
      event_type,
      endpoint: path,
      status_code: statusCode,
      duration_ms: durationInMs,
      ip_address,
      meta_data: {
        method,
        severity,
        tableName: req.body?.tableName || null, // Captures targeted asset contexts automatically 
        row_count: res.locals?.rowCount || null,  // Extracted from database operations responses
        query: req.body?.query || null,
      }
    };

    // Forward asynchronously to buffer pipeline
    queueLog(logData);
  });

  next();
};

module.exports = monitorMiddleware;