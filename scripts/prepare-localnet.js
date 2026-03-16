const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const walletPath = path.resolve(
  repoRoot,
  process.env.WALLET_PATH || ".anchor/local-validator-wallet.json"
);
const rpcUrl = process.env.DECQUEUE_RPC_URL || "http://127.0.0.1:8899";

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
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
    if (allowFailure) {
      return false;
    }
    process.exit(result.status ?? 1);
  }

  return true;
}

fs.mkdirSync(path.dirname(walletPath), { recursive: true });

if (!fs.existsSync(walletPath)) {
  run("solana-keygen", [
    "new",
    "--force",
    "--silent",
    "--no-bip39-passphrase",
    "-o",
    walletPath,
  ]);
}

const funded = run(
  "solana",
  ["airdrop", "10", "--url", rpcUrl, "--keypair", walletPath],
  { allowFailure: true }
);

if (!funded) {
  console.warn("Localnet wallet created, but airdrop failed. Use an existing funded wallet or fund this keypair manually.");
}

console.log(`Localnet wallet ready: ${walletPath}`);
