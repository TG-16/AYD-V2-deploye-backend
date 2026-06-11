require("dotenv").config();
const cors = require("cors");
const express = require("express");
const app = express();
const morgan = require("morgan");
const monitorMiddleware = require("./middlewares/monitor.middleware");
const authRoutes = require("./routes/auth.route");
const crudRoutes = require("./routes/crud.route");
const searchRoutes = require("./routes/search.route");
const helperRoutes = require("./routes/helper.route");
const adminRoutes = require("./routes/admin.route");
const startEmbeddingWorker = require("./utils/embadingWorker");
const { initModels } = require("./controllers/search.controller");
const { initializeWorkspaceCache } = require('./utils/workspaceCache');


const port = process.env.PORT || 5000;

app.use(cors()); // Allow requests from localhost:3000 securely must be changed in production
app.use(morgan("dev"));
app.use(express.json({ limit: "5mb" }));

app.use(monitorMiddleware);

// load all api keys to the memory on sever starts

app.use("/api/auth", authRoutes);
app.use("/api/crud", crudRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/app", helperRoutes);
app.use("/api/admin", adminRoutes);

startEmbeddingWorker();

initializeWorkspaceCache();

console.log("[System] Initializing Neural Infrastructure...");

// initModels()
//   .then(() => {
//     console.log("[System] All BAAI Models successfully loaded into RAM.");

//     // 3. Only start accepting API traffic once the models are warm
//     app.listen(port, () => {
//       console.log(
//         `[Production Host Cluster Active] Listening on port: ${port}`,
//       );
//     });
//   })
//   .catch((err) => {
//     console.error(
//       "CRITICAL: Search infrastructure initialization failed:",
//       err,
//     );
//     process.exit(1); // Crash early if models can't load
//   });

// 3. Only start accepting API traffic once the models are warm
app.listen(port, () => {
  console.log(`[Production Host Cluster Active] Listening on port: ${port}`);


  initModels()
  .then(() => {
    console.log("[System] All BAAI Models successfully loaded into RAM.");

  })
  .catch((err) => {
    console.error(
      "CRITICAL: Search infrastructure initialization failed:",
      err,
    );
    process.exit(1); // Crash early if models can't load
  });
});
