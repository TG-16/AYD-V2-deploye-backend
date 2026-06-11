const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const workspaceMiddleware = require("../middlewares/workspace.middleware");
const limitChecker = require("../middlewares/limitChecker.middleware");
const { globalSearch } = require("../controllers/search.controller");

router.post("/globalSearch", auth, workspaceMiddleware, limitChecker, globalSearch);


module.exports = router;
