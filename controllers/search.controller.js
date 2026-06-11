const { executeHybridQuery } = require('../models/search.model');
const FilterBuilder = require('../utils/FilterBuilder');
const { pipeline } = require('@huggingface/transformers');
const path = require('path'); // should be removed


// Change these to hold the initialization Promise instead of the raw pipeline
let modelsPromise = null;

const initModels = async () => {
  // If an initialization is already in progress or completed, return that same promise
  if (!modelsPromise) {
    modelsPromise = (async () => {
      console.log('[Search Engine] Initializing Neural Infrastructure layers...');
      
      console.log('[Search Engine] Loading Xenova/bge-small-en-v1.5...');
      const encoder = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
      
      console.log('[Search Engine] Loading Xenova/bge-reranker-base...');
      const reranker = await pipeline('text-classification', 'Xenova/bge-reranker-base');
      
      return { encoder, reranker };
    })();
  }
  
  return modelsPromise;
};

/**
 * Primary Unified Global Search Controller Route Method
 */
const globalSearch = async (req, res) => {
  const { query, workspaceId, filters, limit } = req.body;
  const clientLimit = parseInt(limit, 10) || 10;
  const candidateLimit = 100; 

  if (!workspaceId || !query) {
    return res.status(400).json({ 
      status: false, 
      message: "Required parameters missing: 'workspaceId' and 'query' string are mandatory inputs." 
    });
  }

  try {
    // Ensure pipelines are initialized and warmed in RAM
    const { encoder, reranker } = await initModels();

    // 1. Generate query vector using BAAI bge-small-en-v1.5 (matches your worker space)
    const cleanQuery = query.trim() || ' ';
    const embeddingOutput = await encoder(cleanQuery, { pooling: 'mean', normalize: true });
    const queryVector = Array.from(embeddingOutput.data);

    // 2. Map query expressions to your dynamic FilterBuilder module (Offsets start at $4)
    const filterData = FilterBuilder.build(filters, 4);

    // 3. Query database candidates using RRF
    const databaseCandidates = await executeHybridQuery({
      workspaceId,
      textQuery: query,
      vectorQueryString: JSON.stringify(queryVector),
      filterSql: filterData.sql,
      filterValues: filterData.values,
      candidateLimit
    });

    if (databaseCandidates.length === 0) {
      return res.status(200).json({ status: true, resultsCount: 0, data: [] });
    }

    // 4. Dynamic Mapping Layer for Cross-Encoder Input Context
    const rerankerInputs = databaseCandidates.map(row => {
      const meta = row.metadata || {};
      
      // Automatically serialize all primary metadata fields into a key-value format
      const dynamicMetaString = Object.entries(meta)
        .filter(([_, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        .map(([key, value]) => `${key}: ${value}`)
        .join(' | ');

      const contextString = `Metadata Context: ${dynamicMetaString} | Text Context: ${row.searchable_text || ''}`;
      
      return { text: query, text_pair: contextString };
    });

    // 5. Run Cross-Encoder Reranking using bge-reranker-base
    const rerankOutputs = await reranker(rerankerInputs);

    // 6. Merge scores: 30% structural RRF baseline positioning + 70% contextual verification
    const rerankedCollection = databaseCandidates.map((row, idx) => {
      const crossEncoderScore = rerankOutputs[idx].score;
      const normalizedRrf = row.rrf_score / 0.05; // Feature scale normalization

      const finalBlendedScore = (0.3 * normalizedRrf) + (0.7 * crossEncoderScore);

      return {
        source_table: row.source_table,
        source_row_id: row.source_row_id,
        metadata: row.metadata,
        score: finalBlendedScore
      };
    });

    // 7. Sort by final score and apply the client's limit constraint
    const finalResults = rerankedCollection
      .sort((a, b) => b.score - a.score)
      .slice(0, clientLimit);

    return res.status(200).json({
      status: true,
      resultsCount: finalResults.length,
      data: finalResults
    });

  } catch (error) {
    console.error("[Global Search Controller Error]:", error);
    return res.status(500).json({
      status: false,
      message: "An internal server error occurred while executing the search pipeline."
    });
  }
};

module.exports = { globalSearch, initModels };