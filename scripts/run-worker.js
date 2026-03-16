const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const args = process.argv.slice(2);
const tsNodeBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  isWindows ? "ts-node.cmd" : "ts-node"
);

const result = spawnSync(tsNodeBin, ["client/worker.ts", ...args], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
  shell: isWindows,
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("Unable to find ts-node. Run npm install first.");
  } else {
    console.error(result.error.message);
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
