const path = require("node:path");
const { createApp } = require("../src/app");
const { openDatabase } = require("../src/db");

const db = openDatabase(":memory:");
const app = createApp({
  db,
  env: {
    NODE_ENV: "test",
    SESSION_SECRET: "build-check",
    ADMIN_GITHUB_LOGINS: "admin"
  }
});

if (!app || typeof app.handle !== "function") {
  throw new Error("Express app failed to initialize");
}

for (const required of ["views", "public", "src"]) {
  require("node:fs").accessSync(path.join(__dirname, "..", required));
}

db.close();
console.log("build check passed");
