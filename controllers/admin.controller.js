const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const {
  blockUserById,
  createApiKeyAdmin,
  createAdmin,
  createUser,
  createWorkspaceAdmin,
  deleteApiKey,
  deleteUser,
  deleteWorkspace,
  dropIdleConnections,
  fetchAdminSnapshot,
  getAdminById,
  getAdminByEmail,
  listApiKeys,
  listUsers,
  listWorkspaces,
  updateAdminPassword,
  updateAdminProfile,
  updateApiKey,
  updateUser,
  updateWorkspace,
} = require("../models/admin.model");

const createAdminToken = (admin) =>
  jwt.sign(
    {
      userId: admin.admin_id,
      adminId: admin.admin_id,
      adminEmail: admin.email,
      role: "admin",
    },
    process.env.JWT_SECRET_KEY,
    { expiresIn: "7d" }
  );

const registerAdmin = async (req, res) => {
  const { admin_name: adminName, adminName: camelAdminName, email, password } = req.body;
  const normalizedName = adminName || camelAdminName;

  if (!normalizedName || !email || !password) {
    return res.status(400).json({
      status: false,
      message: "admin_name, email, and password are required.",
    });
  }

  try {
    const existingAdmin = await getAdminByEmail(email);
    if (existingAdmin) {
      return res.status(400).json({ status: false, message: "Admin already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 11);
    const admin = await createAdmin({
      adminName: normalizedName,
      email,
      password: hashedPassword,
    });
    const token = createAdminToken(admin);

    return res.status(201).json({
      status: true,
      message: "Admin registered successfully.",
      data: {
        admin: { admin_id: admin.admin_id, admin_name: admin.admin_name, email: admin.email },
        token,
      },
    });
  } catch (error) {
    console.error("[Admin Register Error]:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to register admin.",
    });
  }
};

const loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ status: false, message: "email and password are required." });
  }

  try {
    const admin = await getAdminByEmail(email);
    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      return res.status(400).json({ status: false, message: "Invalid credentials." });
    }

    const token = createAdminToken(admin);

    return res.status(200).json({
      status: true,
      message: "Admin logged in successfully.",
      data: {
        admin: { admin_id: admin.admin_id, admin_name: admin.admin_name, email: admin.email },
        token,
      },
    });
  } catch (error) {
    console.error("[Admin Login Error]:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to login admin.",
    });
  }
};

const getSnapshot = async (req, res) => {
  try {
    const snapshot = await fetchAdminSnapshot(req.query);
    return res.status(200).json(snapshot);
  } catch (error) {
    console.error("[Admin Snapshot Error]:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to compile admin monitoring snapshot.",
    });
  }
};

const blockUser = async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ status: false, message: "userId is required." });
  }

  try {
    const result = await blockUserById(userId);

    return res.status(result.updated ? 200 : 404).json({
      status: result.updated,
      message: result.updated
        ? `User blocked through users.${result.column}.`
        : result.reason || "User not found.",
      data: result,
    });
  } catch (error) {
    console.error("[Admin Block User Error]:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to block user.",
    });
  }
};

const dropIdle = async (req, res) => {
  try {
    const dropped = await dropIdleConnections();
    return res.status(200).json({
      status: true,
      dropped,
      message: `${dropped} idle connection(s) dropped.`,
    });
  } catch (error) {
    console.error("[Admin Drop Idle Connections Error]:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to drop idle database connections.",
    });
  }
};

const sendList = (loader) => async (req, res) => {
  try {
    const data = await loader();
    return res.status(200).json({ status: true, count: data.length, data });
  } catch (error) {
    console.error("[Admin List Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to load admin resource." });
  }
};

const createManagedUser = async (req, res) => {
  try {
    const { name, email, password, auth_provider, is_under_limit } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ status: false, message: "name, email, and password are required." });
    }
    const hashedPassword = await bcrypt.hash(password, 11);
    const data = await createUser({ name, email, password: hashedPassword, auth_provider, is_under_limit });
    return res.status(201).json({ status: true, data });
  } catch (error) {
    console.error("[Admin Create User Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to create user." });
  }
};

const updateManagedUser = async (req, res) => {
  try {
    const data = await updateUser(req.params.id, req.body);
    return res.status(data ? 200 : 404).json({ status: Boolean(data), data });
  } catch (error) {
    console.error("[Admin Update User Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to update user." });
  }
};

const deleteManagedUser = async (req, res) => {
  try {
    const deleted = await deleteUser(req.params.id);
    return res.status(deleted ? 200 : 404).json({ status: deleted });
  } catch (error) {
    console.error("[Admin Delete User Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to delete user." });
  }
};

const createManagedWorkspace = async (req, res) => {
  try {
    const { workspace_name, user_id } = req.body;
    if (!workspace_name || !user_id) {
      return res.status(400).json({ status: false, message: "workspace_name and user_id are required." });
    }
    const data = await createWorkspaceAdmin({ workspace_name, user_id });
    return res.status(201).json({ status: true, data });
  } catch (error) {
    console.error("[Admin Create Workspace Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to create workspace." });
  }
};

const updateManagedWorkspace = async (req, res) => {
  try {
    const data = await updateWorkspace(req.params.id, req.body);
    return res.status(data ? 200 : 404).json({ status: Boolean(data), data });
  } catch (error) {
    console.error("[Admin Update Workspace Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to update workspace." });
  }
};

const deleteManagedWorkspace = async (req, res) => {
  try {
    const deleted = await deleteWorkspace(req.params.id);
    return res.status(deleted ? 200 : 404).json({ status: deleted });
  } catch (error) {
    console.error("[Admin Delete Workspace Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to delete workspace." });
  }
};

const createManagedApiKey = async (req, res) => {
  try {
    const { user_id, name } = req.body;
    if (!user_id || !name) {
      return res.status(400).json({ status: false, message: "user_id and name are required." });
    }
    const rawSecret = crypto.randomBytes(24).toString("hex");
    const key_hash = crypto.createHash("sha256").update(rawSecret).digest("hex");
    const key_hint = `...${rawSecret.slice(-4)}`;
    const data = await createApiKeyAdmin({ user_id, name, key_hash, key_hint });
    return res.status(201).json({ status: true, data: { ...data, apiKey: `AYD-api-key-${rawSecret}` } });
  } catch (error) {
    console.error("[Admin Create API Key Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to create API key." });
  }
};

const updateManagedApiKey = async (req, res) => {
  try {
    const data = await updateApiKey(req.params.id, req.body);
    return res.status(data ? 200 : 404).json({ status: Boolean(data), data });
  } catch (error) {
    console.error("[Admin Update API Key Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to update API key." });
  }
};

const deleteManagedApiKey = async (req, res) => {
  try {
    const deleted = await deleteApiKey(req.params.id);
    return res.status(deleted ? 200 : 404).json({ status: deleted });
  } catch (error) {
    console.error("[Admin Delete API Key Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to delete API key." });
  }
};

const showAdminProfile = async (req, res) => {
  try {
    const data = await getAdminById(req.user.id);
    return res.status(data ? 200 : 404).json({ status: Boolean(data), data });
  } catch (error) {
    console.error("[Admin Profile Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to load admin profile." });
  }
};

const saveAdminProfile = async (req, res) => {
  try {
    const data = await updateAdminProfile(req.user.id, req.body);
    return res.status(data ? 200 : 404).json({ status: Boolean(data), data });
  } catch (error) {
    console.error("[Admin Profile Update Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to update admin profile." });
  }
};

const changeAdminPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ status: false, message: "newPassword is required." });
    const hashedPassword = await bcrypt.hash(newPassword, 11);
    const data = await updateAdminPassword(req.user.id, hashedPassword);
    return res.status(data ? 200 : 404).json({ status: Boolean(data), message: "Password updated." });
  } catch (error) {
    console.error("[Admin Password Change Error]:", error);
    return res.status(500).json({ status: false, message: "Failed to change admin password." });
  }
};

module.exports = {
  registerAdmin,
  loginAdmin,
  getSnapshot,
  blockUser,
  dropIdle,
  listManagedUsers: sendList(listUsers),
  createManagedUser,
  updateManagedUser,
  deleteManagedUser,
  listManagedWorkspaces: sendList(listWorkspaces),
  createManagedWorkspace,
  updateManagedWorkspace,
  deleteManagedWorkspace,
  listManagedApiKeys: sendList(listApiKeys),
  createManagedApiKey,
  updateManagedApiKey,
  deleteManagedApiKey,
  showAdminProfile,
  saveAdminProfile,
  changeAdminPassword,
};
