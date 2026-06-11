// download-models.js
const { pipeline } = require('@huggingface/transformers');
const path = require('path');

async function download() {
    console.log("Starting model downloads...");
    
    // Set up an absolute path targeting your project's local models folder
    const localModelsPath = path.join(__dirname, './model');
    
    console.log(`Target folder configured: ${localModelsPath}`);
    console.log("Downloading bge-small-en-v1.5 (Quantized)...");
    await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { 
        quantized: true,
        cache_dir: localModelsPath // 👈 Forces the download straight here
    });
    
    console.log("Downloading bge-reranker-base (Quantized)...");
    await pipeline('text-classification', 'Xenova/bge-reranker-base', { 
        quantized: true,
        cache_dir: localModelsPath // 👈 Forces the download straight here
    });
    
    console.log("Downloads completed safely!");
}

download().catch(console.error);