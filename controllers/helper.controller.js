const {
  fetchDashboardMetrics,
  getUserWorkspaces,
  getWorkspaceSchema,
  getUserProfileById,
  getApiKeysByUserId
} = require("../models/helper.model");

/**
 * Controller to fetch a combined utilization report for the user overview panels
 */
const getDashboardOverview = async (req, res) => {
  const { id: userId } = req.user; // Context set dynamically by your authentication middleware

  try {
    const metrics = await fetchDashboardMetrics(userId);

    return res.status(200).json({
      status: true,
      message: "Dashboard summary stats compiled successfully.",
      data: {
        storageUsedGB: metrics.totalStorageGB,
        workspacesCreated: metrics.workspaceCount,
        apiKeysGenerated: metrics.apiKeyCount,
        requestsThisMonth: metrics.monthlyRequests, // Currently using hardcoded fallback value
      },
    });
  } catch (error) {
    console.error("[Dashboard Summary Generation Error]:", error);
    return res.status(500).json({
      status: false,
      message:
        "An internal server error occurred while calculating your platform metrics.",
    });
  }
};

/**
 * Controller to look up and output a user's active workspaces
 */
const listWorkspaces = async (req, res) => {
  const { id: userId } = req.user; // Context provided by your authentication middleware

  try {
    const workspaces = await getUserWorkspaces(userId);

    return res.status(200).json({
      status: true,
      message: "User workspaces retrieved successfully.",
      count: workspaces.length,
      data: workspaces,
    });
  } catch (error) {
    console.error("[List Workspaces Error]:", error);
    return res.status(500).json({
      status: false,
      message: "An internal server error occurred while fetching workspaces.",
    });
  }
};

/**
 * Controller to look up and return tables and clean schemas for a workspace payload
 */
const getWorkspaceTablesOverview = async (req, res) => {
  const { workspaceId } = req.body;

  if (!workspaceId) {
    return res.status(400).json({
      status: false,
      message:
        "Missing parameter. 'workspaceId' is required in the request body.",
    });
  }

  try {
    const tableInventory = await getWorkspaceSchema(workspaceId);

    return res.status(200).json({
      status: true,
      message: "Workspace table schemas retrieved successfully.",
      count: tableInventory.length,
      data: tableInventory,
    });
  } catch (error) {
    console.error("[Workspace Schema Error]:", error);
    return res.status(500).json({
      status: false,
      message: "An error occurred while fetching the table schemas.",
    });
  }
};

/**
 * Controller to display the authenticated user's profile information
 */
const showProfile = async (req, res) => {
  const { id: userId } = req.user; // Context provided by your auth middleware

  try {
    const profile = await getUserProfileById(userId);

    if (!profile) {
      return res.status(404).json({
        status: false,
        message: "User profile could not be found.",
      });
    }

    return res.status(200).json({
      status: true,
      message: "User profile retrieved successfully.",
      data: {
        username: profile.name,
        email: profile.email,
        // plan: profile.plan, // returns 'free', 'business', or 'pro'
      },
    });
  } catch (error) {
    console.error("[Show Profile Error]:", error);
    return res.status(500).json({
      status: false,
      message:
        "An internal server error occurred while fetching the profile details.",
    });
  }
};



/**
 * Controller to list all active API credentials for the authenticated user
 */
const listApiKeys = async (req, res) => {
  const { id: userId } = req.user; // Context populated by your token verification middleware

  try {
    const keys = await getApiKeysByUserId(userId);

    return res.status(200).json({
      status: true,
      message: "API keys retrieved successfully.",
      count: keys.length,
      data: keys
    });

  } catch (error) {
    console.error("[Get API Keys Error]:", error);
    return res.status(500).json({
      status: false,
      message: "An internal server error occurred while retrieving your API keys."
    });
  }
};


module.exports = {
  getDashboardOverview,
  listWorkspaces,
  getWorkspaceTablesOverview,
  showProfile,
  listApiKeys,
};
