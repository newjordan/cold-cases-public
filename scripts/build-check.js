const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createApp } = require("../src/app");
const { openDatabase } = require("../src/db");

const root = path.join(__dirname, "..");

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    const result = spawnSync(process.execPath, ["--check", full], { encoding: "utf8" });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      throw new Error(`syntax check failed for ${path.relative(root, full)}`);
    }
  }
}

for (const dir of ["src", "scripts", "test"]) {
  walk(path.join(root, dir));
}

for (const required of ["views", "public", "src"]) {
  fs.accessSync(path.join(root, required));
}

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

db.close();
console.log("build check passed");
