-- Create the database
CREATE DATABASE "AYD_v2";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT,
    auth_provider TEXT NOT NULL DEFAULT 'local',
    is_under_limit BOOLEAN NOT NULL DEFAULT TRUE
);
###########################################
###########################################
CREATE TABLE workspace (
    workspace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_name VARCHAR(255) NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT fk_workspace_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
ALTER TABLE tables
ADD CONSTRAINT unique_table_per_workspace
UNIQUE (workspace_id, table_name);

or


CREATE TABLE tables (
    table_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name VARCHAR(255) NOT NULL,
    workspace_id UUID NOT NULL,

    FOREIGN KEY (workspace_id)
        REFERENCES workspace(workspace_id)
        ON DELETE CASCADE,

    UNIQUE (workspace_id, table_name)
);

Notes user_id references the id column in the users table.ON DELETE CASCADE means if a user is deleted,
all their workspaces are deleted automatically.
###########################################
###########################################
CREATE TABLE tables (
    table_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name VARCHAR(255) NOT NULL,
    workspace_id UUID NOT NULL,
    CONSTRAINT fk_tables_workspace FOREIGN KEY (workspace_id) REFERENCES workspace(workspace_id) ON DELETE CASCADE
);
Notes ON DELETE CASCADE → if a workspace is deleted,
all related records in tables are automatically deleted.
###########################################
###########################################






-- trigers for adding inserted data to the global registry dynamicly
CREATE OR REPLACE FUNCTION sync_dynamic_table_to_global_registry()
RETURNS TRIGGER AS $$
DECLARE
    v_workspace_id UUID;
    v_source_table TEXT;
    v_registry_table TEXT; -- Dynamically generated target table name
    v_searchable_text TEXT := '';
    v_row_json JSONB;
    v_source_row_id UUID;
    v_key TEXT;
    v_val TEXT;
    v_dynamic_query TEXT;
BEGIN
    -- Extract properties dynamically from TG_TABLE_NAME (Format: tableName_workspaceId)
    v_workspace_id := right(TG_TABLE_NAME, 36)::UUID;
    v_source_table := left(TG_TABLE_NAME, length(TG_TABLE_NAME) - 37);
    
    -- Target registry table name format
    v_registry_table := 'global_registry_' || v_workspace_id::text;

    -- Capture row data based on transaction operational state
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_row_json := to_jsonb(NEW);
    ELSE
        v_row_json := to_jsonb(OLD);
    END IF;

    v_source_row_id := (v_row_json->>'id')::UUID;

    -- ================================================
    -- CASE 1: DELETE OPERATION
    -- ================================================
    IF TG_OP = 'DELETE' THEN
        v_dynamic_query := format('
            DELETE FROM %I 
            WHERE source_table = $1 AND source_row_id = $2
        ', v_registry_table);
        
        EXECUTE v_dynamic_query USING v_source_table, v_source_row_id;
        RETURN OLD;
    END IF;

    -- ================================================
    -- DYNAMIC TEXT EXTRACTION
    -- ================================================
    FOR v_key, v_val IN SELECT * FROM jsonb_each_text(v_row_json) LOOP
        IF v_key <> 'id' AND v_val IS NOT NULL AND jsonb_typeof(v_row_json->v_key) = 'string' THEN
            v_searchable_text := v_searchable_text || v_val || ' ';
        END IF;
    END LOOP;
    
    v_searchable_text := trim(v_searchable_text);

    -- ================================================
    -- CASE 2: INSERT OPERATION
    -- ================================================
    IF TG_OP = 'INSERT' THEN
        v_dynamic_query := format('
            INSERT INTO %I (
                workspace_id, source_table, source_row_id, 
                searchable_text, searchable_tsv, metadata, embedding_status
            ) VALUES ($1, $2, $3, $4, to_tsvector(''english'', coalesce($4, '''')), $5, ''pending'')
        ', v_registry_table);
        
        EXECUTE v_dynamic_query USING v_workspace_id, v_source_table, v_source_row_id, v_searchable_text, v_row_json;
        RETURN NEW;

    -- ================================================
    -- CASE 3: UPDATE OPERATION
    -- ================================================
    ELSIF TG_OP = 'UPDATE' THEN
        v_dynamic_query := format('
            UPDATE %I
            SET 
                searchable_text = $1,
                searchable_tsv = to_tsvector(''english'', coalesce($1, '''')),
                metadata = $2,
                embedding = NULL,
                embedding_status = ''pending'',
                updated_at = NOW()
            WHERE source_table = $3 AND source_row_id = $4
        ', v_registry_table);
        
        EXECUTE v_dynamic_query USING v_searchable_text, v_row_json, v_source_table, v_source_row_id;
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;









-- the core hybrid searching query
-- Target Parameter Layout: 
-- $1 = raw text search token, $2 = generated vector array string, $3 = metadata filter injection limit
WITH fts_search AS (
    SELECT 
        registry_id, 
        ROW_NUMBER() OVER (ORDER BY ts_rank(searchable_tsv, websearch_to_tsquery('english', $1)) DESC) as rank_position
    FROM "global_registry_{workspaceId}"
    WHERE searchable_tsv @@ websearch_to_tsquery('english', $1)
    -- {DYNAMIC_METADATA_FILTERS}
    LIMIT 50
),
vector_search AS (
    SELECT 
        registry_id, 
        ROW_NUMBER() OVER (ORDER BY embedding <=> $2 ASC) as rank_position
    FROM "global_registry_{workspaceId}"
    WHERE embedding_status = 'completed'
    -- {DYNAMIC_METADATA_FILTERS}
    ORDER BY embedding <=> $2 ASC
    LIMIT 50
),
fuzzy_search AS (
    SELECT 
        registry_id, 
        ROW_NUMBER() OVER (ORDER BY similarity(searchable_text, $1) DESC) as rank_position
    FROM "global_registry_{workspaceId}"
    WHERE searchable_text % $1
    -- {DYNAMIC_METADATA_FILTERS}
    LIMIT 50
),
unified_universe AS (
    SELECT registry_id FROM fts_search
    UNION
    SELECT registry_id FROM vector_search
    UNION
    SELECT registry_id FROM fuzzy_search
)
SELECT 
    u.registry_id,
    r.source_table,
    r.source_row_id,
    r.metadata,
    -- Apply RRF Math Core (k = 60)
    (
        COALESCE((SELECT 1.0 / (60.0 + rank_position) FROM fts_search WHERE registry_id = u.registry_id), 0.0) +
        COALESCE((SELECT 1.0 / (60.0 + rank_position) FROM vector_search WHERE registry_id = u.registry_id), 0.0) +
        COALESCE((SELECT 1.0 / (60.0 + rank_position) FROM fuzzy_search WHERE registry_id = u.registry_id), 0.0)
    ) AS rrf_score
FROM unified_universe u
JOIN "global_registry_{workspaceId}" r ON u.registry_id = r.registry_id
ORDER BY rrf_score DESC
LIMIT $3;












-- trigger to add fuzzy search indexing
-- 1. Enable the trigram text analysis extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Configuration function for automatic workspace trigram optimization
CREATE OR REPLACE FUNCTION configure_workspace_trigram_indexes(p_workspace_id UUID)
RETURNS VOID AS $$
DECLARE
    v_table_name TEXT := 'global_registry_' || p_workspace_id::text;
    v_index_name TEXT := 'idx_registry_trgm_' || p_workspace_id::text;
BEGIN
    -- Dynamically attach a GIN Trigram index to the combined text block
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I USING gin (searchable_text gin_trgm_ops);',
        v_index_name, v_table_name
    );
END;
$$ LANGUAGE plpgsql;






-- api key table creation and indexing
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- Resolves workspace via relation
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE, -- Hashes ONLY the secret part
    key_hint VARCHAR(8) NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE, -- Default active
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE is_revoked = FALSE;





-- event log creation and indexing
CREATE TABLE event_log (
    -- Unique internal identifier using native Postgres UUID v4 generation
    event_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    -- Tenant & Identity tracking (can be NULL if authentication or context fails)
    workspace_id UUID NULL,
    user_id UUID NULL,                      -- Adjusted to INT matching standard serial or identity IDs
    
    -- Metric classification vectors
    event_type VARCHAR(100) NOT NULL,
    endpoint VARCHAR(255) NOT NULL,
    status_code SMALLINT NOT NULL,         -- SMALLINT saves storage overhead over INT for 3-digit status codes
    duration_ms NUMERIC(10, 2) NOT NULL,   -- Supports precise decimals (e.g., 142.55ms)
    
    -- Rich payload audit store (Index metadata variables easily)
    meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    -- Network tracking and timeline records
    ip_address VARCHAR(45) NULL,           -- Length 45 comfortably accommodates IPv4 and long IPv6 strings
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);



-- 1. Optimize timeline lookups (e.g., Request Count/day, latency averages over the last 24 hours)
CREATE INDEX idx_event_log_created_at 
ON event_log (created_at DESC);

-- 2. Optimize user-side metrics and isolation validation (WHERE workspace_id = 'x')
CREATE INDEX idx_event_log_workspace 
ON event_log (workspace_id) 
WHERE workspace_id IS NOT NULL; -- Partial index avoids indexing null guest auth rows to save disk space

-- 3. Optimize SIEM event counters and breakdown charts (GROUP BY event_type, status_code)
CREATE INDEX idx_event_log_type_status 
ON event_log (event_type, status_code);

-- 4. Advanced JSONB Indexing: Optimize looking into your custom metadata objects
-- This allows your alerting engine to search internally for {"severity": "CRITICAL"} instantly
CREATE INDEX idx_event_log_meta_severity 
ON event_log USING gin ((meta_data -> 'severity'));




CREATE TABLE admins (
    admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL
);