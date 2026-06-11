const { isWorkspaceOwner } = require('../utils/workspaceCache');

const workspaceMiddleware = async (req, res, next) => {
    const userId = req.user.id;
    const workspaceId = req.body.workspaceId;

    const reponse = isWorkspaceOwner(workspaceId, userId);

    if(reponse) return next();

    return res.status(401).json({ status: false, message: "Unauthorized: Invalid workspace" });
};


module.exports = workspaceMiddleware;