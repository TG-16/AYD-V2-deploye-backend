const db = require("../config/db");
const crypto = require('crypto');

const getUser = async (email) => {
  const query = `
    SELECT id, name, password
    FROM users
    WHERE email = $1
    LIMIT 1;
  `;
  const values = [email];
  const { rows } = await db.query(query, values);
  return rows[0] || null;
};

const registerUser = async ({ userName, email, password, auth_provider }) => {
  const query = `
    INSERT INTO users (
      name,
      email,
      password,
      auth_provider
    )
    VALUES ($1, $2, $3, $4)
    RETURNING id, name, email;
  `;

  const values = [userName, email, password, auth_provider];

  const { rows } = await db.query(query, values);

  return rows[0];
};

const updateUserPassword = async (id, hashedPassword) => {
  const query = `
    UPDATE users
    SET password = $1
    WHERE id = $2
    RETURNING id;
  `;
  const values = [hashedPassword, id];

  const { rows } = await db.query(query, values);

  // Returns true if a row was updated, false if the user ID wasn't found
  return rows.length > 0;
};


const generateAndStoreApiKey = async ({ userId, name }) => {
  // 1. Generate the core, raw cryptographically secure random token
  const rawSecret = crypto.randomBytes(24).toString('hex');
  
  // 2. Hash ONLY the raw secret for strict database matching
  const keyHash = crypto.createHash('sha256').update(rawSecret).digest('hex');
  
  // 3. Keep a safe hint of the secret tail for client-side UI recognition lists
  const keyHint = `...${rawSecret.slice(-4)}`;

  const sql = `
    INSERT INTO api_keys (user_id, name, key_hash, key_hint)
    VALUES ($1, $2, $3, $4)
    RETURNING id, name, key_hint, created_at;
  `;

  const { rows } = await db.query(sql, [userId, name, keyHash, keyHint]);
  
  // 4. Attach the visual tracking prefix ONLY to the unhashed display key string
  const finalDisplayKey = `AYD-api-key-${rawSecret}`;

  return {
    ...rows[0],
    apiKey: finalDisplayKey
  };
};



/**
 * Fetches the current hashed password for a user
 */
const getPasswordHashById = async (userId) => {
  const sql = `SELECT password, auth_provider FROM users WHERE id = $1::uuid;`;
  const { rows } = await db.query(sql, [userId]);
  return rows[0];
};

/**
 * Updates a user's password with a new hash
 */
const updatePasswordHash = async (userId, newHash) => {
  const sql = `
    UPDATE users 
    SET password = $2 
    WHERE id = $1::uuid;
  `;
  await db.query(sql, [userId, newHash]);
};


module.exports = {
  getUser,
  registerUser,
  updateUserPassword,
  generateAndStoreApiKey,
  getPasswordHashById,
  updatePasswordHash,
};
