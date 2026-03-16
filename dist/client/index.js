"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecQueueClient = void 0;
exports.formatTxLocation = formatTxLocation;
exports.formatAddressLocation = formatAddressLocation;
exports.defaultWalletPath = defaultWalletPath;
exports.loadKeypairFromFile = loadKeypairFromFile;
exports.loadWalletFromFile = loadWalletFromFile;
const anchor = __importStar(require("@coral-xyz/anchor"));
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// @lightprotocol/stateless.js — TypeScript client for the Light System Program.
// This is a pure npm package; it has no Rust/Cargo dependency conflicts.
// It wraps the Light indexer RPC to:
//   1. Fetch compressed account data (stored in ledger, not getAccountInfo)
//   2. Fetch ValidityProofs needed to mutate compressed accounts on-chain
const stateless_js_1 = require("@lightprotocol/stateless.js");
const decqueue_core_1 = require("../shared/decqueue-core");
const dec_queue_json_1 = __importDefault(require("../target/idl/dec_queue.json"));
// Light Protocol indexer RPC endpoints per cluster.
// Workers fetch ValidityProofs from these before sending compressed-account
// transactions. Different from the standard Solana RPC — the Light indexer
// tracks the Merkle trees and can generate ZK proofs.
const LIGHT_RPC_ENDPOINT = {
    devnet: "https://zk-testnet.helius.dev:8899",
    "mainnet-beta": "https://mainnet.helius-rpc.com",
    localnet: "http://localhost:8899", // local validator with light-system-program
};
function lightRpcForCluster(cluster) {
    var _a;
    return (_a = LIGHT_RPC_ENDPOINT[cluster]) !== null && _a !== void 0 ? _a : LIGHT_RPC_ENDPOINT.devnet;
}
function formatTxLocation(signature, cluster) {
    if (cluster === "localnet") {
        return signature;
    }
    return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}
function formatAddressLocation(address, cluster) {
    if (cluster === "localnet") {
        return address;
    }
    return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
}
function defaultWalletPath() {
    return path.join(os.homedir(), ".config", "solana", "id.json");
}
function loadKeypairFromFile(walletPath) {
    let keypairData;
    if (process.env.WALLET_JSON) {
        keypairData = JSON.parse(process.env.WALLET_JSON);
    }
    else {
        keypairData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
    }
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(keypairData));
}
function loadWalletFromFile(walletPath = defaultWalletPath()) {
    return new anchor.Wallet(loadKeypairFromFile(walletPath));
}
class DecQueueClient {
    constructor(program, provider) {
        this.program = program;
        this.provider = provider;
    }
    static connect(wallet_1) {
        return __awaiter(this, arguments, void 0, function* (wallet, cluster = "localnet") {
            const connection = new web3_js_1.Connection((0, decqueue_core_1.endpointForCluster)(cluster), "confirmed");
            const provider = new anchor_1.AnchorProvider(connection, wallet, {
                commitment: "confirmed",
            });
            anchor.setProvider(provider);
            const program = new anchor_1.Program(dec_queue_json_1.default, provider);
            return new DecQueueClient(program, provider);
        });
    }
    deriveQueuePda(authority, queueName) {
        return (0, decqueue_core_1.deriveQueuePda)(this.program.programId, authority, queueName);
    }
    deriveJobPda(queuePubkey, jobId) {
        return (0, decqueue_core_1.deriveJobPda)(this.program.programId, queuePubkey, jobId);
    }
    deriveIndexPda(queuePubkey, indexType) {
        return (0, decqueue_core_1.deriveIndexPda)(this.program.programId, queuePubkey, indexType);
    }
    createQueue(name_1) {
        return __awaiter(this, arguments, void 0, function* (name, options = {}) {
            const { maxRetries = 3 } = options;
            const authority = this.provider.wallet.publicKey;
            const [queuePda] = this.deriveQueuePda(authority, name);
            const signature = yield this.program.methods
                .initializeQueue(name, maxRetries)
                .accounts({
                queue: queuePda,
                authority,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .rpc();
            return { queuePda, signature };
        });
    }
    initializeIndexes(queuePda) {
        return __awaiter(this, void 0, void 0, function* () {
            const authority = this.provider.wallet.publicKey;
            const [pendingIndex] = this.deriveIndexPda(queuePda, "pending");
            const [processingIndex] = this.deriveIndexPda(queuePda, "processing");
            const [delayedIndex] = this.deriveIndexPda(queuePda, "delayed");
            const [failedIndex] = this.deriveIndexPda(queuePda, "failed");
            const [completedIndex] = this.deriveIndexPda(queuePda, "completed");
            const [cancelledIndex] = this.deriveIndexPda(queuePda, "cancelled");
            return this.program.methods
                .initializeIndexes()
                .accounts({
                queue: queuePda,
                pendingIndex,
                processingIndex,
                delayedIndex,
                failedIndex,
                completedIndex,
                cancelledIndex,
                authority,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .rpc();
        });
    }
    getIndexJobIds(queuePda, indexType) {
        return __awaiter(this, void 0, void 0, function* () {
            const [indexPda] = this.deriveIndexPda(queuePda, indexType);
            try {
                const data = yield this.program.account.jobIndex.fetch(indexPda);
                return data.jobIds.map((id) => (typeof id === "number" ? id : id.toNumber()));
            }
            catch (_a) {
                return [];
            }
        });
    }
    getReadyJobIds(queuePda) {
        return __awaiter(this, void 0, void 0, function* () {
            const [pendingIds, delayedIds] = yield Promise.all([
                this.getIndexJobIds(queuePda, "pending"),
                this.getIndexJobIds(queuePda, "delayed"),
            ]);
            return [...pendingIds, ...delayedIds];
        });
    }
    getQueueStats(queuePda) {
        return __awaiter(this, void 0, void 0, function* () {
            const data = yield this.program.account.queue.fetch(queuePda);
            return {
                name: data.name,
                authority: data.authority.toBase58(),
                totalJobs: data.jobCount.toNumber(),
                pendingJobs: data.pendingCount.toNumber(),
                completedJobs: data.processedCount.toNumber(),
                failedJobs: data.failedCount.toNumber(),
                paused: data.paused,
                createdAt: new Date(data.createdAt.toNumber() * 1000),
            };
        });
    }
    addJob(queuePda_1, jobType_1, data_1) {
        return __awaiter(this, arguments, void 0, function* (queuePda, jobType, data, options = {}) {
            const result = yield (0, decqueue_core_1.enqueueJobWithProgram)({
                program: this.program,
                payer: this.provider.wallet.publicKey,
                queuePda,
                jobType,
                payload: data,
                options,
            });
            return {
                jobPda: result.jobPda,
                jobId: result.jobId,
                signature: result.signature,
            };
        });
    }
    getJob(jobPda) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const data = yield this.program.account.job.fetch(jobPda);
            const statusKey = Object.keys(data.status)[0];
            return {
                publicKey: jobPda,
                jobId: data.jobId.toNumber(),
                jobType: data.jobType,
                payload: JSON.parse(Buffer.from(data.payload).toString()),
                status: statusKey,
                priority: data.priority,
                createdAt: new Date(data.createdAt.toNumber() * 1000),
                executeAfter: new Date(data.executeAfter.toNumber() * 1000),
                attempts: data.attempts,
                maxRetries: data.maxRetries,
                worker: (_a = data.worker) === null || _a === void 0 ? void 0 : _a.toBase58(),
                startedAt: data.startedAt ? new Date(data.startedAt.toNumber() * 1000) : undefined,
                completedAt: data.completedAt ? new Date(data.completedAt.toNumber() * 1000) : undefined,
                result: (_b = data.result) !== null && _b !== void 0 ? _b : undefined,
                errorMessage: (_c = data.errorMessage) !== null && _c !== void 0 ? _c : undefined,
            };
        });
    }
    getAllJobs(queuePda) {
        return __awaiter(this, void 0, void 0, function* () {
            const queueData = yield this.program.account.queue.fetch(queuePda);
            const totalJobs = queueData.jobCount.toNumber();
            const jobs = [];
            for (let id = 0; id < totalJobs; id += 1) {
                const [jobPda] = this.deriveJobPda(queuePda, id);
                try {
                    jobs.push(yield this.getJob(jobPda));
                }
                catch (_a) {
                    // Skip missing accounts.
                }
            }
            return jobs;
        });
    }
    // ── claimJob ─────────────────────────────────────────────────────────────
    // Standard path: mutates the on-chain Job PDA directly.
    // Compressed path: fetches a ValidityProof from the Light indexer and sends
    //   a claimCompressedJob instruction that atomically:
    //     1. Verifies proof (proves job is in PENDING state in Merkle tree)
    //     2. Removes job_id from source_index_page
    //     3. Updates compressed job hash to PROCESSING state
    claimJob(jobPda_1, queuePda_1, workerKeypair_1) {
        return __awaiter(this, arguments, void 0, function* (jobPda, queuePda, workerKeypair, options = {}) {
            const { useCompressed = false, cluster = "devnet", indexPageSeq = 0 } = options;
            if (useCompressed) {
                return this._claimCompressed(jobPda, queuePda, workerKeypair, cluster, indexPageSeq);
            }
            // Standard path — derives source_index_page from the current head page seq.
            // For simplicity the page is passed as the first index page (seq=0) unless
            // the caller provides a specific seq via indexPageSeq.
            const [sourceIndexPage] = this._deriveIndexPagePda(queuePda, indexPageSeq);
            return this.program.methods
                .claimJob()
                .accounts({
                job: jobPda,
                worker: workerKeypair.publicKey,
                sourceIndexPage,
            })
                .signers([workerKeypair])
                .rpc();
        });
    }
    _claimCompressed(jobPda, queuePda, workerKeypair, cluster, indexPageSeq) {
        return __awaiter(this, void 0, void 0, function* () {
            const lightRpc = (0, stateless_js_1.createRpc)(lightRpcForCluster(cluster));
            const { proof, meta, jobDataBytes } = yield this._fetchProofAndMeta(lightRpc, jobPda);
            const [sourceIndexPage] = this._deriveIndexPagePda(queuePda, indexPageSeq);
            return this.program.methods
                .claimCompressedJob(proof, meta, Array.from(jobDataBytes))
                .accounts({
                worker: workerKeypair.publicKey,
                payer: workerKeypair.publicKey,
                sourceIndexPage,
            })
                .remainingAccounts(yield this._buildLightRemainingAccounts(lightRpc, meta))
                .signers([workerKeypair])
                .rpc();
        });
    }
    // ── completeJob ────────────────────────────────────────────────────────────
    completeJob(queuePda_1, jobPda_1, workerKeypair_1, result_1) {
        return __awaiter(this, arguments, void 0, function* (queuePda, jobPda, workerKeypair, result, options = {}) {
            const { useCompressed = false, cluster = "devnet" } = options;
            if (useCompressed) {
                return this._completeCompressed(queuePda, jobPda, workerKeypair, result, cluster);
            }
            return this.program.methods
                .completeJob(result !== null && result !== void 0 ? result : null)
                .accounts({
                queue: queuePda,
                job: jobPda,
                worker: workerKeypair.publicKey,
            })
                .signers([workerKeypair])
                .rpc();
        });
    }
    _completeCompressed(queuePda, jobPda, workerKeypair, result, cluster) {
        return __awaiter(this, void 0, void 0, function* () {
            const lightRpc = (0, stateless_js_1.createRpc)(lightRpcForCluster(cluster));
            const { proof, meta, jobDataBytes } = yield this._fetchProofAndMeta(lightRpc, jobPda);
            return this.program.methods
                .completeCompressedJob(proof, meta, Array.from(jobDataBytes), result !== null && result !== void 0 ? result : null)
                .accounts({
                queue: queuePda,
                worker: workerKeypair.publicKey,
                payer: workerKeypair.publicKey,
            })
                .remainingAccounts(yield this._buildLightRemainingAccounts(lightRpc, meta))
                .signers([workerKeypair])
                .rpc();
        });
    }
    // ── failJob ────────────────────────────────────────────────────────────────
    failJob(queuePda_1, jobPda_1, workerKeypair_1, errorMessage_1) {
        return __awaiter(this, arguments, void 0, function* (queuePda, jobPda, workerKeypair, errorMessage, retryAfterSecs = 30, options = {}) {
            const { useCompressed = false, cluster = "devnet", retryIndexPageSeq = 0 } = options;
            if (useCompressed) {
                return this._failCompressed(queuePda, jobPda, workerKeypair, errorMessage, retryAfterSecs, cluster, retryIndexPageSeq);
            }
            const [retryIndexPage] = this._deriveIndexPagePda(queuePda, retryIndexPageSeq);
            return this.program.methods
                .failJob(errorMessage, new anchor_1.BN(retryAfterSecs))
                .accounts({
                queue: queuePda,
                job: jobPda,
                worker: workerKeypair.publicKey,
                retryIndexPage,
            })
                .signers([workerKeypair])
                .rpc();
        });
    }
    _failCompressed(queuePda, jobPda, workerKeypair, errorMessage, retryAfterSecs, cluster, retryIndexPageSeq) {
        return __awaiter(this, void 0, void 0, function* () {
            const lightRpc = (0, stateless_js_1.createRpc)(lightRpcForCluster(cluster));
            const { proof, meta, jobDataBytes } = yield this._fetchProofAndMeta(lightRpc, jobPda);
            const [retryIndexPage] = this._deriveIndexPagePda(queuePda, retryIndexPageSeq);
            return this.program.methods
                .failCompressedJob(proof, meta, Array.from(jobDataBytes), errorMessage, new anchor_1.BN(retryAfterSecs))
                .accounts({
                queue: queuePda,
                worker: workerKeypair.publicKey,
                payer: workerKeypair.publicKey,
                retryIndexPage,
            })
                .remainingAccounts(yield this._buildLightRemainingAccounts(lightRpc, meta))
                .signers([workerKeypair])
                .rpc();
        });
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Private Light Protocol helpers
    // ─────────────────────────────────────────────────────────────────────────
    // Derive a JobIndex page PDA by sequence number.
    // Seeds: ["index", queuePubkey, seq.to_le_bytes()]
    _deriveIndexPagePda(queuePda, seq) {
        const seqBuf = Buffer.alloc(8);
        seqBuf.writeBigUInt64LE(BigInt(seq));
        return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("index"), queuePda.toBuffer(), seqBuf], this.program.programId);
    }
    // Fetch a compressed job's current data + validity proof from the Light indexer.
    //
    // What the Light indexer returns:
    //   - compressedAccount.data.data  → borsh-serialized JobAccount bytes
    //     (this is what the on-chain handler borsh-deserializes from job_data)
    //   - compressedAccount.address    → the compressed account's unique address
    //   - proof                        → ValidityProof struct (ZK-SNARK)
    //   - CompressedAccountMeta        → hash + tree indices for LightAccount::new_mut()
    //
    // The proof is only valid for the CURRENT Merkle root.  If another transaction
    // updates the same leaf before this tx lands, the root changes and the proof
    // becomes invalid → tx reverts.  This is how double-claim is prevented.
    _fetchProofAndMeta(lightRpc, jobPda // used as the compressed account address (deterministic seed)
    ) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            // getCompressedAccount fetches the current state from the Light indexer.
            // Unlike getAccountInfo, this reads from the Merkle tree not from account data.
            const compressedAccount = yield lightRpc.getCompressedAccount(undefined, jobPda // address — same deterministic key used during enqueue
            );
            if (!compressedAccount) {
                throw new Error(`Compressed job account not found for address ${jobPda.toBase58()}. ` +
                    `Ensure the job was created with enqueue_compressed_job, ` +
                    `not the standard enqueue_job.`);
            }
            const jobDataBytes = ((_a = compressedAccount.data) === null || _a === void 0 ? void 0 : _a.data)
                ? Buffer.from(compressedAccount.data.data)
                : Buffer.alloc(0);
            // getValidityProof fetches a fresh ZK-SNARK proof from the indexer.
            // This proves: "this hash exists in the current Merkle root".
            // The proof is tied to the current root — it expires if the root changes.
            const proofResult = yield lightRpc.getValidityProof([{ hash: compressedAccount.hash, tree: compressedAccount.tree }], [] // no new addresses needed for updates
            );
            // Build CompressedAccountMeta from the fetched data.
            // This tells LightAccount::new_mut() which leaf to nullify.
            const meta = {
                hash: compressedAccount.hash,
                address: compressedAccount.address,
                treeInfo: proofResult.treeInfo,
                outputStateMerkleTreeIndex: (_c = (_b = proofResult.treeInfo) === null || _b === void 0 ? void 0 : _b.treeIndex) !== null && _c !== void 0 ? _c : 0,
            };
            return { proof: proofResult.proof, meta, jobDataBytes };
        });
    }
    // Build the remaining_accounts list required by the Light System Program.
    // These accounts are the State Merkle Tree + Nullifier Queue on-chain PDAs.
    // Their indices are packed into the instruction data by PackedAccounts.
    _buildLightRemainingAccounts(lightRpc, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            // The stateless.js SDK exposes `getStateTreeAccounts` or equivalent.
            // For now we return the canonical devnet state tree and nullifier queue.
            // In production, derive these from the treeInfo in the proof metadata.
            const LIGHT_STATE_TREE_DEVNET = new web3_js_1.PublicKey("smt1NamzXdq4AMqS2fS2F1i5KTYPZRhoHgWx38d8WsT");
            const LIGHT_NULLIFIER_QUEUE_DEVNET = new web3_js_1.PublicKey("nfq1NvQDJ2GEgnS8zt9prAe8rjjpAW1zFkrvZoBR148");
            const LIGHT_SYSTEM_PROGRAM = new web3_js_1.PublicKey("H5sFv8VwWmjxHYS2GB4fTDsK7uTtnRT4WiixtHrET3bN");
            return [
                { pubkey: LIGHT_SYSTEM_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: LIGHT_STATE_TREE_DEVNET, isSigner: false, isWritable: true },
                { pubkey: LIGHT_NULLIFIER_QUEUE_DEVNET, isSigner: false, isWritable: true },
            ];
        });
    }
    setQueuePaused(queuePda, paused) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.program.methods
                .setQueuePaused(paused)
                .accounts({ queue: queuePda, authority: this.provider.wallet.publicKey })
                .rpc();
        });
    }
    onJobCompleted(callback) {
        return this.program.addEventListener("jobCompleted", (event) => {
            var _a;
            callback({ jobId: event.jobId.toNumber(), result: (_a = event.result) !== null && _a !== void 0 ? _a : undefined });
        });
    }
    onJobFailed(callback) {
        return this.program.addEventListener("jobFailed", (event) => {
            callback({ jobId: event.jobId.toNumber(), error: event.error, attempts: event.attempts });
        });
    }
    removeListener(listenerId) {
        return this.program.removeEventListener(listenerId);
    }
}
exports.DecQueueClient = DecQueueClient;
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const walletPath = (_a = process.env.WALLET_PATH) !== null && _a !== void 0 ? _a : defaultWalletPath();
        const cluster = (_b = process.env.DECQUEUE_CLUSTER) !== null && _b !== void 0 ? _b : "localnet";
        const queueName = (_c = process.env.DECQUEUE_QUEUE_NAME) !== null && _c !== void 0 ? _c : `email-${Date.now().toString(36)}`;
        const payer = loadKeypairFromFile(walletPath);
        const wallet = new anchor.Wallet(payer);
        console.log(`Connecting to ${cluster}...`);
        const client = yield DecQueueClient.connect(wallet, cluster);
        console.log(`   Wallet: ${payer.publicKey.toBase58()}\n`);
        console.log(`Creating queue: ${queueName}`);
        const { queuePda, signature: createSig } = yield client.createQueue(queueName, {
            maxRetries: 3,
        });
        console.log(`   Queue PDA: ${queuePda.toBase58()}`);
        console.log(`   Tx: ${formatTxLocation(createSig, cluster)}`);
        console.log(`Initializing indexes...`);
        const indexSig = yield client.initializeIndexes(queuePda);
        console.log(`   Tx: ${formatTxLocation(indexSig, cluster)}\n`);
        console.log("Enqueuing jobs...");
        const jobs = [
            { type: "send-email", data: { to: "alice@example.com", subject: "Welcome" }, priority: 2 },
            { type: "send-email", data: { to: "bob@example.com", subject: "Invoice" }, priority: 1 },
            {
                type: "webhook-call",
                data: { url: "https://api.example.com/hook", event: "signup" },
                priority: 1,
            },
            { type: "daily-report", data: { reportId: "Q1-2025" }, priority: 0, delay: 60000 },
        ];
        for (const jobDef of jobs) {
            const { jobPda, jobId, signature } = yield client.addJob(queuePda, jobDef.type, jobDef.data, {
                priority: jobDef.priority,
                delay: jobDef.delay,
            });
            console.log(`   Job #${jobId} (${jobDef.type}) -> ${jobPda.toBase58().slice(0, 20)}...`);
            console.log(`   Tx: ${formatTxLocation(signature, cluster)}`);
        }
        console.log("\nQueue Stats:");
        const stats = yield client.getQueueStats(queuePda);
        console.log(`   Pending:   ${stats.pendingJobs}`);
        console.log(`   Total:     ${stats.totalJobs}`);
        console.log(`   Completed: ${stats.completedJobs}`);
        console.log(`   Failed:    ${stats.failedJobs}`);
        console.log(`   Paused:    ${stats.paused}`);
        console.log("\nAll Jobs:");
        const allJobs = yield client.getAllJobs(queuePda);
        for (const job of allJobs) {
            const since = Math.round((Date.now() - job.createdAt.getTime()) / 1000);
            console.log(`   #${job.jobId} [${job.status.padEnd(10)}] ${job.jobType.padEnd(15)} ${since}s ago`);
        }
        if (cluster === "localnet") {
            console.log("\nDone. Queue address:");
        }
        else {
            console.log("\nDone. Queue location:");
        }
        console.log(`   ${formatAddressLocation(queuePda.toBase58(), cluster)}`);
    });
}
if (require.main === module) {
    main().catch(console.error);
}
