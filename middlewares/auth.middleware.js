const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require("../config/db");


const authMiddleware = async (req, res, next) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'];
    // ---- SCENARIO A: Machine API Key Security Validation Pipeline ----
    if (apiKeyHeader) {
      const targetPrefix = 'AYD-api-key-';

      // Validation: Enforce the presence of your visual prefix brand identifier
      if (!apiKeyHeader.startsWith(targetPrefix)) {
        return res.status(401).json({ status: false, message: "Invalid API Key format payload token structure." });
      }

      // Extract the raw secret portion by stripping away the prefix string
      const rawSecret = apiKeyHeader.replace(targetPrefix, '');

      // Compute the lookup fingerprint hash using the isolated secret
      const incomingHash = crypto.createHash('sha256').update(rawSecret).digest('hex');

      // Recover key metadata and corresponding workspace linkage context safely
      const query = `
        SELECT ak.user_id, ak.is_revoked
        FROM api_keys ak
        INNER JOIN users u ON ak.user_id = u.id
        WHERE ak.key_hash = $1;
      `;
      const { rows } = await db.query(query, [incomingHash]);

      if (rows.length === 0) {
        return res.status(401).json({ status: false, message: "Invalid API Key." });
      }

      const keyRecord = rows[0];

      // Block entry if the key's revocation status flag is true
      if (keyRecord.is_revoked) {
        return res.status(401).json({ status: false, message: "This API Key has been revoked and can no longer be used." });
      }

      // Unify request environment state contexts smoothly for subsequent endpoint controllers
      req.user = { 
        id: keyRecord.user_id, 
        // workspaceId: keyRecord.workspace_id 
      };
      
      // Update usage timestamps asynchronously 
      db.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1', [incomingHash]).catch(console.error);

      return next();
    }


    
    // 2. Check for JWT Token (Typically used by web dashboard)
    const authHeader = req.headers['authorization'];
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];

      // Verify the JWT token
      jwt.verify(token, process.env.JWT_SECRET_KEY, async (err, decoded) => {
        if (err) {
          return res.status(401).json({ status: false, message: "Unauthorized: Invalid or expired token" });
        }

        // Fetch user or memory data if you need to enforce limits/plans
        // const userContext = await getUserWorkspaceContext(decoded.userId);

        req.user = { id: decoded.userId };
        req.authType = 'jwt';
        
        return next(); // Successfully authenticated via JWT
      });
      
      return; // Prevent falling through while jwt.verify runs asynchronously
    }

    // 3. Neither authentication method was provided
    return res.status(401).json({ 
      status: false, 
      message: "Access Denied: Missing JWT Token or API Key" 
    });

  } catch (error) {
    console.error("Auth Middleware Error:", error);
    return res.status(500).json({ status: false, message: "Internal Server Error during authentication" });
  }
};

module.exports = authMiddleware;