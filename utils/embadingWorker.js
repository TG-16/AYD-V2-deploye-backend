const db = require('../config/db');
const { pipeline } = require('@huggingface/transformers');
const { initModels } = require("../controllers/search.controller");

const BATCH_SIZE = 100;
const PROCESSING_INTERVAL_MS = 1000;

// Globally held pipeline reference so it only loads into memory once
let embeddingPipeline = null;

/**
 * Initializes the local machine learning model pipeline
 */
const initPipeline = async () => {
  if (!embeddingPipeline) {
    console.log('[Worker] Loading Xenova/all-MiniLM-L6-v2 (Quantized)...');
    
    // Invoke the function with await to get the returned object
    const models = await initModels(); 
    
    // Extract the encoder from that object
    embeddingPipeline = models.encoder;

    console.log('[Worker] ML Model successfully loaded into memory.');
  }
  return embeddingPipeline;
};

/**
 * Generates an actual 384-dimensional embedding vector array
 * @param {string} text 
 * @returns {Promise<number[]>}
 */
const generateLiveEmbedding384 = async (text) => {
  const extractor = await initPipeline();
  
  // Fallback for completely empty string inputs to avoid pipeline failures
  const cleanText = text.trim() || " "; 

  // Compute raw tensor data output
  const output = await extractor(cleanText, { pooling: 'mean', normalize: true });
  
  // Convert ONNX Tensor values cleanly into a flat vanilla JavaScript Array
  const embeddingArray = Array.from(output.data);
  
  return embeddingArray;
};

/**
 * Iterates over pending rows inside all discoverable registry tables sequentially
 */
const processPendingEmbeddings = async () => {
  let client;
  
  try {
    client = await db.connect();

    // 1. Discover all active workspace registry tables
    const discoveryQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name LIKE 'global_registry_%' 
        AND table_schema = 'public';
    `;
    const { rows: registryTables } = await client.query(discoveryQuery);

    if (registryTables.length === 0) return;

    // 2. Cycle through tables sequentially per iteration loop
    for (const table of registryTables) {
      const targetTable = table.table_name;

      // Wrap individual table workflows in their own try/catch block
      // This protects your worker loop from crashing globally if a single table hits a snag
      try {
        await client.query('BEGIN');

        // Thread-safe fetch utilizing SKIP LOCKED structure
        const selectQuery = `
          SELECT registry_id, searchable_text 
          FROM "${targetTable}"
          WHERE embedding_status = 'pending'
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED;
        `;
        const { rows: pendingRows } = await client.query(selectQuery, [BATCH_SIZE]);

        if (pendingRows.length === 0) {
          await client.query('COMMIT');
          continue; 
        }

        console.log(`[Worker] Generating real embeddings for ${pendingRows.length} rows inside: ${targetTable}`);

        // 3. Process records sequentially
        for (const row of pendingRows) {
          const textToEmbed = row.searchable_text || '';
          
          // Compute the live 384 vector array using transformers.js
          const embeddingVector = await generateLiveEmbedding384(textToEmbed);
          
          // Format vector array to standard string layout for pgvector syntax match
          const formattedVectorString = JSON.stringify(embeddingVector);

          const updateQuery = `
            UPDATE "${targetTable}"
            SET 
              embedding = $1,
              embedding_status = 'completed',
              updated_at = NOW()
            WHERE registry_id = $2;
          `;
          await client.query(updateQuery, [formattedVectorString, row.registry_id]);
        }

        await client.query('COMMIT');
      } catch (tableError) {
        // Safe contextual rollback for this specific table transaction
        await client.query('ROLLBACK');
        console.error(`[Worker Error] Failed processing updates for table ${targetTable}:`, tableError);
      }
    }
  } catch (error) {
    console.error("[Worker Error] Global registry discovery structure crashed:", error);
  } finally {
    if (client) {
      client.release();
    }
  }
};

/**
 * Initializes and manages the execution loop of the worker background engine
 */
const startEmbeddingWorker = async () => {
  try {
    // Ensure the model files download/cache successfully before polling the database
    await initPipeline();
    
    console.log(`[Worker Initialization] Multi-Registry ML Worker Live.`);

    // Recursive function loop execution that guarantees absolute sequential processing
    const runTick = async () => {
      try {
        await processPendingEmbeddings();
      } catch (tickError) {
        console.error("[Worker Tick Error] Internal runner exception occurred:", tickError);
      } finally {
        // Enforce a strict break window between executions to allow V8 garbage collection to free RAM
        setTimeout(runTick, PROCESSING_INTERVAL_MS);
      }
    };

    // Kickoff loop execution
    runTick();

  } catch (err) {
    console.error("CRITICAL: Failed to initialize background embedding pipeline engine:", err);
    process.exit(1);
  }
};

module.exports = startEmbeddingWorker;
