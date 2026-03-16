const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const walletPath = process.env.WALLET_PATH;

if (args.length === 0) {
  console.error("Usage: node scripts/run-anchor.js <anchor-subcommand> [...args]");
  process.exit(1);
}

const isWindows = process.platform === "win32";
const shortTargetDir = isWindows
  ? process.env.SOLQUEUE_TARGET_DIR || path.join(os.tmpdir(), "solqueue-target")
  : null;

if (shortTargetDir) {
  fs.mkdirSync(shortTargetDir, { recursive: true });
}

const candidates = [
  path.join(repoRoot, ".tools", isWindows ? "anchor.exe" : "anchor"),
  "anchor",
];

function runAnchor(command, anchorArgs) {
  const finalArgs = [...anchorArgs];
  const env = { ...process.env };
  if (shortTargetDir) {
    env.CARGO_TARGET_DIR = shortTargetDir;
  }

  if (walletPath && !finalArgs.includes("--provider.wallet")) {
    finalArgs.push("--provider.wallet");
    finalArgs.push(path.isAbsolute(walletPath) ? walletPath : path.resolve(repoRoot, walletPath));
  }

  const result = spawnSync(command, finalArgs, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error && result.error.code === "ENOENT") {
    return { missing: true, status: 1 };
  }

  return { missing: false, status: result.status ?? 1 };
}

function syncArtifacts() {
  if (!shortTargetDir) {
    return;
  }

  const repoTarget = path.join(repoRoot, "target");
  const repoDeploy = path.join(repoTarget, "deploy");
  const customDeploy = path.join(shortTargetDir, "deploy");

  if (!fs.existsSync(customDeploy)) {
    return;
  }

  fs.mkdirSync(repoDeploy, { recursive: true });
  for (const entry of fs.readdirSync(customDeploy)) {
    fs.cpSync(path.join(customDeploy, entry), path.join(repoDeploy, entry), {
      recursive: true,
      force: true,
    });
  }
}

let finalStatus = 1;
for (const candidate of candidates) {
  if (candidate !== "anchor" && !fs.existsSync(candidate)) {
    continue;
  }

  const result = runAnchor(candidate, args);
  if (result.missing) {
    continue;
  }

  finalStatus = result.status;
  if (finalStatus === 0 && (args[0] === "build" || args[0] === "test")) {
    syncArtifacts();
  }
  process.exit(finalStatus);
}

console.error("Unable to find a working Anchor CLI. Install Anchor 0.30.1 or provide .tools/anchor.exe.");
process.exit(finalStatus);
