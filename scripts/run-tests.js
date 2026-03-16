const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const cluster = process.argv[2] || "localnet";
const walletPath =
  process.env.WALLET_PATH || path.join(os.homedir(), ".config", "solana", "id.json");
const tsMochaBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  isWindows ? "ts-mocha.cmd" : "ts-mocha"
);

const endpoints = {
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: isWindows && command.toLowerCase().endsWith(".cmd"),
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error(`Missing required command: ${command}`);
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("node", ["scripts/run-anchor.js", "deploy", "--provider.cluster", cluster], {
  ...process.env,
  WALLET_PATH: walletPath,
});

run(tsMochaBin, ["-p", "./tsconfig.json", "-t", "1000000", "tests/**/*.ts"], {
  ...process.env,
  ANCHOR_PROVIDER_URL: endpoints[cluster] || endpoints.localnet,
  ANCHOR_WALLET: walletPath,
  WALLET_PATH: walletPath,
});
