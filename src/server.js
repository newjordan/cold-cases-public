const path = require("node:path");
const { createApp } = require("./app");
const { openDatabase } = require("./db");

const databasePath = process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "cold-cases.sqlite");
const port = Number(process.env.PORT || 3000);
const db = openDatabase(databasePath);
const app = createApp({ db, env: process.env });

app.listen(port, () => {
  console.log(`cold-cases listening on ${port}`);
});
