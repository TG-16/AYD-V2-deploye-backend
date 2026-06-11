// services/logQueue.js
const db = require("../config/db");

let logBuffer = [];
const BATCH_LIMIT = 20;
const FLUSH_INTERVAL = 10000; // 10 seconds

const queueLog = (logData) => {
  console.log(logData);
  logBuffer.push(logData);
  if (logBuffer.length >= BATCH_LIMIT) {
    flushLogs();
  }
};

const flushLogs = async () => {
  if (logBuffer.length === 0) return;

  const currentBatch = [...logBuffer];
  logBuffer = []; // Immediately clear memory to avoid duplicate writes

  try {
    // Dynamically construct a highly efficient multi-row raw bulk INSERT statement
    const columns = [
      "workspace_id",
      "user_id",
      "event_type",
      "endpoint",
      "status_code",
      "duration_ms",
      "meta_data",
      "ip_address",
    ];

    const valuePlaceholders = [];
    const flattenedValues = [];
    let placeholderIndex = 1;

    currentBatch.forEach((log) => {
      const placeholders = columns.map(() => `$${placeholderIndex++}`);
      valuePlaceholders.push(`(${placeholders.join(", ")})`);

      flattenedValues.push(
        log.workspace_id,
        log.user_id,
        log.event_type,
        log.endpoint,
        log.status_code,
        log.duration_ms,
        JSON.stringify(log.meta_data), // Ensure metadata maps to JSONB/JSON column
        log.ip_address,
      );
    });

    const queryText = `
      INSERT INTO event_log (${columns.join(", ")}) 
      VALUES ${valuePlaceholders.join(", ")}
    `;

    await db.query(queryText, flattenedValues);
  } catch (err) {
    console.error("CRITICAL: Failed to flush event logs to Neon DB:", err);
  }
};

// Set fallback window interval to clear hanging logs
setInterval(flushLogs, FLUSH_INTERVAL);

module.exports = { queueLog };
