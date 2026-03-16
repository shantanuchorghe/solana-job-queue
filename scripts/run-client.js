const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const cluster = process.argv[2] || process.env.DECQUEUE_CLUSTER || "localnet";
const explicitWallet = process.argv[3] || process.env.WALLET_PATH;
const walletPath = explicitWallet;
const tsNodeBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  isWindows ? "ts-node.cmd" : "ts-node"
);

const env = {
  ...process.env,
  DECQUEUE_CLUSTER: cluster,
};

if (walletPath) {
  env.WALLET_PATH = path.resolve(repoRoot, walletPath);
}

const result = spawnSync(tsNodeBin, ["client/index.ts"], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
  shell: isWindows,
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("Unable to find npx. Install Node.js and npm first.");
  } else {
    console.error(result.error.message);
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
