const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { validate: isUUID } = require("uuid");
// const { use } = require("../routes/auth.route");
const {
  createWorkspace,
  createTable,
  addColumns,
  insertData,
  fetchTableData,
 updateSingleRow,
 updateBatchRows,
 deleteSingleRow, deleteBatchRows,
} = require("../models/crud.model");
const { pipeline } = require('@huggingface/transformers');
const FilterBuilder = require('../utils/FilterBuilder');
const { updateCachedWorkspace, deleteCachedWorkspace } = require('../utils/workspaceCache');

const workspace = async (req, res) => {
  // get the user id and wokspace name
  // create a workspace workspace name + userid as a name
  // return success with workspace id
  const userId = req.user.id;
  const { workspaceName } = req.body;

  try {
    const workspace = await createWorkspace({ userId, workspaceName });

    updateCachedWorkspace(workspace.workspace_id, workspace.user_id);

    return res
      .status(200)
      .json({ status: true, message: { workspaceId: workspace.workspace_id } });
  } catch (error) {
    console.error("workspace creation error:", error);
    return res.status(500).json({
      status: false,
      message: "Internal Server Error please try later",
    });
  }
};

const tableCreation = async (req, res) => {
  const { workspaceId, tableName } = req.body;

  try {
    // Basic validation
    if (!workspaceId || !tableName) {
      return res.status(400).json({
        status: false,
        message: "workspaceId and tableName are required",
      });
    }

    if (!isUUID(workspaceId)) {
      return res.status(400).json({
        status: false,
        message: "Invalid workspaceId",
      });
    }

    // Table names cannot be parameterized, so strict regex validation is required
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      return res.status(400).json({
        status: false,
        message: "Invalid table name. Only alphanumeric characters and underscores are allowed.",
      });
    }

    // Execute table creation and trigger attachment
    const table = await createTable({
      workspaceId,
      tableName,
    });

    return res.status(201).json({
      status: true,
      message: {
        tableId: table.table_id,
      },
    });
    
  } catch (error) {
    console.error("Table creation error:", error);

    // Handle foreign key violation (e.g., workspace_id doesn't exist in the workspaces table)
    if (error.code === "23503") {
      return res.status(404).json({
        status: false,
        message: "Workspace not found",
      });
    }

    return res.status(500).json({
      status: false,
      message: "Internal server error. Please try again later.",
    });
  }
};

const addColumn = async (req, res) => {
  const { tableName, workspaceId, columns } = req.body;

  // 1. Authorization validation
  if (!isUUID(workspaceId)) {
    return res
      .status(400)
      .json({ status: false, message: "Invalid workspace" });
  }

  // Basic payload validation
  if (!tableName || !workspaceId || !Array.isArray(columns)) {
    return res
      .status(400)
      .json({ status: false, message: "Invalid payload layout" });
  }

  try {
    // 2. Format targeted table to: table_name_workspaceId
    const targetTable = `${tableName}_${workspaceId}`;

    // 3. Prepare columns array and process foreign key table prefixes
    const preparedColumns = columns.map((col) => {
      const clonedCol = { ...col };

      if (clonedCol.foreignKey) {
        clonedCol.foreignKey = {
          ...clonedCol.foreignKey,
          // Explicitly prefix the referenced table name to restrict it to this workspace
          referenceTable: `${clonedCol.foreignKey.referenceTable}_${workspaceId}`,
        };
      }
      return clonedCol;
    });

    // 4. Fire the dynamic engine
    await addColumns(targetTable, preparedColumns);

    return res.status(200).json({
      status: true,
      message: `Columns successfully added to ${tableName}`,
    });
  } catch (error) {
    console.error("DB Alteration Error:", error);
    return res.status(500).json({
      status: false,
      message: {
        message:
          "Database schema update failed. Verify table existence and layout parameters.",
        error,
      },
    });
  }
};

const addData = async (req, res) => {
  const { tableName, workspaceId, data } = req.body;

  // 1. Authorization validation
  if (!isUUID(workspaceId)) {
    return res
      .status(400)
      .json({ status: false, message: "Invalid workspace" });
  }

  // Basic payload validation
  if (!tableName || !workspaceId || !data) {
    return res.status(400).json({ status: false, message: "Missing required fields (tableName, workspaceId, data)" });
  }

  try {
    // 2. Standardize data into an array (handles both single row object and multiple rows array)
    const rowsToInsert = Array.isArray(data) ? data : [data];

    if (rowsToInsert.length === 0) {
      return res.status(400).json({ status: false, message: "No data provided for insertion" });
    }

    // 3. Format the targeted isolated table name
    const targetTable = `${tableName}_${workspaceId}`;

    // 4. Pass execution to the dynamic model engine
    const result = await insertData({targetTable, rowsToInsert});

    return res.status(201).json({ 
      status: true, 
      message: `Successfully inserted ${rowsToInsert.length} row(s) into ${tableName}`,
      insertedCount: rowsToInsert.length
    });

  } catch (error) {
    console.error("Data Insertion Error:", error);
    return res.status(500).json({ 
      status: false, 
      message: "Database insertion failed. Verify table structure, constraints, and column data types." 
    });
  }
};



/**
 * Controller to fetch paginated and filtered records directly from a specified table
 */
const readData = async (req, res) => {
  const { workspaceId, tableName, filters, limit, page } = req.body;

  // 1. Validate mandatory target routing parameters
  if (!workspaceId || !tableName) {
    return res.status(400).json({
      status: false,
      message: "Missing required parameters: Both 'workspaceId' and 'tableName' must be provided."
    });
  }

  try {
    // 2. Establish pagination boundaries
    const clientLimit = parseInt(limit, 10) || 20;
    const clientPage = parseInt(page, 10) || 1;
    const clientOffset = (clientPage - 1) * clientLimit;

    // 3. Generate baseline filter syntax using your original FilterBuilder module
    const filterData = FilterBuilder.build(filters, 3);

    // 4. TRANSFORMATION LAYER: Convert JSONB path syntax to native table columns
    // This turns:  r.metadata->>'category'  ->  r."category"
    // and turns:   (r.metadata->>'price')::numeric  ->  (r."price")::numeric
    const nativeFilterSql = filterData.sql.replace(/r\.metadata->>'(\w+)'/g, 'r."$1"');

    // 5. Request data rows from the dynamic custom table layout
    const dataRecords = await fetchTableData({
      workspaceId,
      tableName,
      filterSql: nativeFilterSql, // Pass the corrected native SQL string
      filterValues: filterData.values,
      limit: clientLimit,
      offset: clientOffset
    });

    // 6. Return matched rows matching original interface specifications
    return res.status(200).json({
      status: true,
      meta: {
        workspaceId,
        tableName,
        page: clientPage,
        limit: clientLimit,
        count: dataRecords.length
      },
      results: dataRecords
    });

  } catch (error) {
    console.error("[Table Data Read Error]:", error);

    if (error.code === '42P01') {
      return res.status(404).json({
        status: false,
        message: `The table '${tableName}' for workspace '${workspaceId}' could not be found.`
      });
    }

    return res.status(500).json({
      status: false,
      message: "An internal database error occurred while querying the target table."
    });
  }
};


/**
 * Endpoint optimized for UI interactions modifying one data row at a time via its "id"
 */
const editSingleData = async (req, res) => {
  const { workspaceId, tableName, id, updates } = req.body;

  if (!workspaceId || !tableName || !id || !updates) {
    return res.status(400).json({
      status: false,
      message: "Missing parameters. 'workspaceId', 'tableName', 'id', and an 'updates' payload object are mandatory."
    });
  }

  try {
    const updatedRow = await updateSingleRow({
      workspaceId,
      tableName,
      id,
      updates
    });

    if (!updatedRow) {
      return res.status(404).json({
        status: false,
        message: "No record found matching the provided id in the target table."
      });
    }

    return res.status(200).json({
      status: true,
      message: "Record updated successfully.",
      data: updatedRow
    });

  } catch (error) {
    console.error("[Single Row Edit Error]:", error);
    if (error.code === '42P01') {
      return res.status(404).json({ status: false, message: "Targeted table resource could not be found." });
    }
    return res.status(500).json({ status: false, message: "Internal server error occurred while updating row." });
  }
};

/**
 * API-facing batch processing endpoint to modify multiple rows by their respective "id" values
 */
const editBatchData = async (req, res) => {
  const { workspaceId, tableName, records } = req.body;

  if (!workspaceId || !tableName || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({
      status: false,
      message: "Required inputs missing. Expecting a non-empty payload array under 'records'."
    });
  }

  try {
    const processedRows = await updateBatchRows({
      workspaceId,
      tableName,
      records
    });

    return res.status(200).json({
      status: true,
      metrics: {
        submitted: records.length,
        succeeded: processedRows.length
      },
      message: `Batch transaction complete. Successfully updated ${processedRows.length} records.`
    });

  } catch (error) {
    console.error("[Batch Rows Edit Error]:", error);
    if (error.code === '42P01') {
      return res.status(404).json({ status: false, message: "Targeted table system relation was not found." });
    }
    return res.status(500).json({ status: false, message: "Database batch execution collapsed. All changes aborted." });
  }
};




/**
 * UI Endpoint: Optimized for single row removal actions from frontend lists
 */
const deleteSingleData = async (req, res) => {
  // Extract workspaceId directly from the request body payload
  const { workspaceId, tableName, ids } = req.body;
  console.log(workspaceId,tableName,ids);

  if (!workspaceId || !tableName || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({
      status: false,
      message: "Required parameters missing. Provide 'workspaceId', 'tableName', and a non-empty 'ids' array."
    });
  }

  try {
    // Isolate the targeted single row from the provided identifier list
    const targetId = ids[0];

    const deletedRecord = await deleteSingleRow({
      workspaceId,
      tableName,
      id: targetId
    });

    if (!deletedRecord) {
      return res.status(404).json({
        status: false,
        message: "No record found matching the provided id in the target table configuration."
      });
    }

    return res.status(200).json({
      status: true,
      message: "Record dropped successfully.",
      data: deletedRecord
    });

  } catch (error) {
    console.error("[Single Row Delete Error]:", error);
    if (error.code === '42P01') {
      return res.status(404).json({ status: false, message: "Targeted table resource could not be found." });
    }
    return res.status(500).json({ status: false, message: "Internal server error occurred during row excision." });
  }
};

/**
 * Developer Endpoint: Optimized for programmatic bulk deletion streams
 */
const deleteBatchData = async (req, res) => {
  // Extract workspaceId directly from the request body payload
  const { workspaceId, tableName, ids } = req.body;

  if (!workspaceId || !tableName || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({
      status: false,
      message: "Required parameters missing. Provide 'workspaceId', 'tableName', and a non-empty 'ids' array list."
    });
  }

  try {
    const deletedRecords = await deleteBatchRows({
      workspaceId,
      tableName,
      ids
    });

    return res.status(200).json({
      status: true,
      metrics: {
        submitted: ids.length,
        deleted: deletedRecords.length
      },
      message: `Batch complete. Successfully purged ${deletedRecords.length} records from the data matrix.`
    });

  } catch (error) {
    console.error("[Batch Rows Delete Error]:", error);
    if (error.code === '42P01') {
      return res.status(404).json({ status: false, message: "Targeted table resource could not be found." });
    }
    return res.status(500).json({ status: false, message: "Internal server error collapsed batch deletion statement." });
  }
};














module.exports = {
  workspace,
  tableCreation,
  addColumn,
  addData,
  readData,
  editSingleData,
  editBatchData,
  deleteSingleData, deleteBatchData,
  
};
