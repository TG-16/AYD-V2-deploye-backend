// services/workspaceCache.js
const db = require("../config/db");

// The in-memory Map store: workspace_id -> user_id
const workspaceCache = new Map();

/**
 * Fetches all workspaces from the DB and populates the memory cache
 */
const initializeWorkspaceCache = async () => {
  try {
    console.log("🔄 Initializing in-memory workspace cache...");
    
    // Updated to match your exact schema columns
    const query = `SELECT workspace_id, user_id FROM workspace`; 
    const { rows } = await db.query(query);

    workspaceCache.clear(); // Clear existing entries if re-syncing

    rows.forEach(row => {
      // Mapping workspace_id to the owner's user_id
      workspaceCache.set(String(row.workspace_id), String(row.user_id));
    });

    console.log(`✅ Cache loaded successfully. Cached ${workspaceCache.size} workspaces.`);
  } catch (error) {
    console.error("❌ Failed to initialize workspace cache:", error);
    throw error; 
  }
};

/**
 * Verifies if a specific user owns a specific workspace
 */
const isWorkspaceOwner = (workspaceId, userId) => {
  if (!workspaceId || !userId) return false;
  
  const cachedOwnerId = workspaceCache.get(String(workspaceId));
  return cachedOwnerId === String(userId);
};

/**
 * Utility helpers to keep memory in sync when workspaces are created or deleted
 */
const updateCachedWorkspace = (workspaceId, userId) => {
  workspaceCache.set(String(workspaceId), String(userId));
};

const deleteCachedWorkspace = (workspaceId) => {
  workspaceCache.delete(String(workspaceId));
};

module.exports = {
  initializeWorkspaceCache,
  isWorkspaceOwner,
  updateCachedWorkspace,
  deleteCachedWorkspace
};