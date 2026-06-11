const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const workspaceMiddleware = require("../middlewares/workspace.middleware");
const limitChecker = require("../middlewares/limitChecker.middleware");
const {
  workspace,
  tableCreation,
  addColumn,
  addData,
  readData,
  editSingleData,
  editBatchData,
  deleteSingleData,
  deleteBatchData,
} = require("../controllers/crud.controller");
const registerValidation = require("../middlewares/validators/register.validator");


const largeJsonParser = express.json({ limit: '5mb' });

router.post("/createWorkspace", auth, limitChecker, workspace);
router.post("/createTable", auth, workspaceMiddleware, limitChecker, tableCreation);
router.post("/addColumns", auth, workspaceMiddleware, limitChecker, addColumn);
router.post("/insertData", largeJsonParser, auth, workspaceMiddleware, limitChecker, addData);
router.post("/readData", auth, workspaceMiddleware, limitChecker, readData);

router.post("/editSingleData", auth, workspaceMiddleware, limitChecker, editSingleData);
router.post("/editBatchData", auth, workspaceMiddleware, limitChecker, editBatchData);


router.post("/deleteSingleData", auth, workspaceMiddleware, limitChecker, deleteSingleData);
router.post("/deleteBatchData", auth, workspaceMiddleware, limitChecker, deleteBatchData);


module.exports = router;
