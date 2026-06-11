const db = require('../config/db');
const { pipeline } = require('@huggingface/transformers');

const BATCH_SIZE = 100;
const PROCESSING_INTERVAL_MS = 1000;

// Globally held pipeline reference so it only loads into memory once
let embeddingPipeline = null;

/**
 * Initializes the local machine learning model pipeline
 */
const initPipeline = async () => {
  if (!embeddingPipeline) {
    console.log('[Worker] Loading ML Model (Xenova/bge-small-en-v1.5)...');
    // Using feature-extraction task for creating embedding vectors
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
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

const processPendingEmbeddings = async () => {
  const client = await db.connect();
  
  try {
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

      // 3. Process records
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
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[Worker Error] Vector generation pipeline crashed:", error);
  } finally {
    client.release();
  }
};

const startEmbeddingWorker = async () => {
  try {
    // Ensure the model files download/cache successfully before polling the database
    await initPipeline();
    
    console.log(`[Worker Initialization] Multi-Registry ML Worker Live.`);
    setInterval(async () => {
      await processPendingEmbeddings();
    }, PROCESSING_INTERVAL_MS);

  } catch (err) {
    console.error("CRITICAL: Failed to initialize background embedding pipeline engine:", err);
    process.exit(1);
  }
};



module.exports = startEmbeddingWorker;