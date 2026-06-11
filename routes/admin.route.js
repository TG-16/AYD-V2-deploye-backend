const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const {
  blockUser,
  changeAdminPassword,
  createManagedApiKey,
  createManagedUser,
  createManagedWorkspace,
  deleteManagedApiKey,
  deleteManagedUser,
  deleteManagedWorkspace,
  dropIdle,
  getSnapshot,
  listManagedApiKeys,
  listManagedUsers,
  listManagedWorkspaces,
  loginAdmin,
  registerAdmin,
  saveAdminProfile,
  showAdminProfile,
  updateManagedApiKey,
  updateManagedUser,
  updateManagedWorkspace,
} = require("../controllers/admin.controller");

router.post("/auth/register", registerAdmin);
router.post("/auth/login", loginAdmin);
router.get("/snapshot", auth, getSnapshot);
router.patch("/users/:userId/block", auth, blockUser);
router.post("/database/drop-idle-connections", auth, dropIdle);

router.get("/manage/users", auth, listManagedUsers);
router.post("/manage/users", auth, createManagedUser);
router.patch("/manage/users/:id", auth, updateManagedUser);
router.delete("/manage/users/:id", auth, deleteManagedUser);

router.get("/manage/workspaces", auth, listManagedWorkspaces);
router.post("/manage/workspaces", auth, createManagedWorkspace);
router.patch("/manage/workspaces/:id", auth, updateManagedWorkspace);
router.delete("/manage/workspaces/:id", auth, deleteManagedWorkspace);

router.get("/manage/api-keys", auth, listManagedApiKeys);
router.post("/manage/api-keys", auth, createManagedApiKey);
router.patch("/manage/api-keys/:id", auth, updateManagedApiKey);
router.delete("/manage/api-keys/:id", auth, deleteManagedApiKey);

router.get("/settings/profile", auth, showAdminProfile);
router.patch("/settings/profile", auth, saveAdminProfile);
router.patch("/settings/password", auth, changeAdminPassword);

module.exports = router;
