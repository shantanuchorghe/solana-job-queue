"use strict";
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
exports.MAX_JOB_TYPE_LENGTH = exports.MAX_JOB_PAYLOAD_BYTES = void 0;
exports.getProgramId = getProgramId;
exports.getPayloadByteLength = getPayloadByteLength;
exports.enqueueJobFromWallet = enqueueJobFromWallet;
exports.cancelJobFromWallet = cancelJobFromWallet;
exports.fetchQueueSnapshot = fetchQueueSnapshot;
exports.subscribeToQueueEvents = subscribeToQueueEvents;
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const dec_queue_json_1 = __importDefault(require("./idl/dec_queue.json"));
const decqueue_core_1 = require("./decqueue-core");
Object.defineProperty(exports, "MAX_JOB_PAYLOAD_BYTES", { enumerable: true, get: function () { return decqueue_core_1.MAX_JOB_PAYLOAD_BYTES; } });
Object.defineProperty(exports, "MAX_JOB_TYPE_LENGTH", { enumerable: true, get: function () { return decqueue_core_1.MAX_JOB_TYPE_LENGTH; } });
const IDL = dec_queue_json_1.default;
const decoder = new TextDecoder();
const IDL_PROGRAM_ID = new web3_js_1.PublicKey(dec_queue_json_1.default.address);
const READONLY_WALLET = {
    publicKey: new web3_js_1.PublicKey("11111111111111111111111111111111"),
    signTransaction(transaction) {
        return __awaiter(this, void 0, void 0, function* () {
            return transaction;
        });
    },
    signAllTransactions(transactions) {
        return __awaiter(this, void 0, void 0, function* () {
            return transactions;
        });
    },
};
function createAnchorWallet(wallet) {
    return {
        get publicKey() {
            if (!wallet.publicKey) {
                throw new Error("Connect your wallet to enqueue a job.");
            }
            return wallet.publicKey;
        },
        signTransaction(transaction) {
            return __awaiter(this, void 0, void 0, function* () {
                return wallet.signTransaction(transaction);
            });
        },
        signAllTransactions(transactions) {
            return __awaiter(this, void 0, void 0, function* () {
                if (wallet.signAllTransactions) {
                    return wallet.signAllTransactions(transactions);
                }
                return Promise.all(transactions.map((transaction) => wallet.signTransaction(transaction)));
            });
        },
    };
}
function getProgram(cluster, wallet) {
    const connection = new web3_js_1.Connection((0, decqueue_core_1.endpointForCluster)(cluster), "confirmed");
    const provider = new anchor_1.AnchorProvider(connection, wallet ? createAnchorWallet(wallet) : READONLY_WALLET, {
        commitment: "confirmed",
    });
    const program = new anchor_1.Program(IDL, provider);
    return { connection, program };
}
function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}
function toNumber(value) {
    return typeof value === "number" ? value : value.toNumber();
}
function toDate(value) {
    if (value == null) {
        return undefined;
    }
    return new Date(toNumber(value) * 1000);
}
function parsePayload(payload) {
    const text = decoder.decode(payload instanceof Uint8Array ? payload : Uint8Array.from(payload));
    if (!text) {
        return { parsed: {}, text: "" };
    }
    try {
        return { parsed: JSON.parse(text), text };
    }
    catch (_a) {
        return { parsed: text, text };
    }
}
function normalizeJob(jobPublicKey, rawJob) {
    var _a, _b, _c, _d, _e, _f;
    const { parsed, text } = parsePayload(rawJob.payload);
    const status = ((_a = Object.keys(rawJob.status)[0]) !== null && _a !== void 0 ? _a : "pending");
    return {
        publicKey: jobPublicKey.toBase58(),
        jobId: toNumber(rawJob.jobId),
        jobType: rawJob.jobType,
        payload: parsed,
        payloadText: text,
        status,
        priority: rawJob.priority,
        createdAt: (_b = toDate(rawJob.createdAt)) !== null && _b !== void 0 ? _b : new Date(0),
        executeAfter: (_c = toDate(rawJob.executeAfter)) !== null && _c !== void 0 ? _c : new Date(0),
        attempts: rawJob.attempts,
        maxRetries: rawJob.maxRetries,
        worker: (_d = rawJob.worker) === null || _d === void 0 ? void 0 : _d.toBase58(),
        startedAt: toDate(rawJob.startedAt),
        completedAt: toDate(rawJob.completedAt),
        result: (_e = rawJob.result) !== null && _e !== void 0 ? _e : undefined,
        errorMessage: (_f = rawJob.errorMessage) !== null && _f !== void 0 ? _f : undefined,
    };
}
function formatEvent(eventName, event) {
    switch (eventName) {
        case "jobEnqueued":
            return `JOB #${event.jobId.toNumber()} [${event.jobType}] ENQUEUED`;
        case "jobClaimed":
            return `JOB #${event.jobId.toNumber()} CLAIMED by ${event.worker.toBase58().slice(0, 4)}...${event.worker.toBase58().slice(-4)}`;
        case "jobCompleted":
            return `JOB #${event.jobId.toNumber()} COMPLETED`;
        case "jobFailed":
            return `JOB #${event.jobId.toNumber()} FAILED after ${event.attempts} attempts`;
        case "jobRetrying":
            return `JOB #${event.jobId.toNumber()} RETRYING -> attempt ${event.attempt}`;
        case "jobCancelled":
            return `JOB #${event.jobId.toNumber()} CANCELLED`;
        case "queuePauseChanged":
            return `QUEUE ${event.paused ? "PAUSED" : "RESUMED"}`;
        default:
            return eventName;
    }
}
function getProgramId() {
    return IDL_PROGRAM_ID.toBase58();
}
function getPayloadByteLength(payload) {
    return (0, decqueue_core_1.payloadByteLength)(payload);
}
function enqueueJobFromWallet(_a) {
    return __awaiter(this, arguments, void 0, function* ({ cluster, queueAddress, wallet, jobType, payload, priority = 1, delay = 0, }) {
        if (!(wallet === null || wallet === void 0 ? void 0 : wallet.publicKey)) {
            throw new Error("Connect your wallet to enqueue a job.");
        }
        const queuePublicKey = new web3_js_1.PublicKey(queueAddress);
        const { program } = getProgram(cluster, wallet);
        const result = yield (0, decqueue_core_1.enqueueJobWithProgram)({
            program,
            payer: wallet.publicKey,
            queuePda: queuePublicKey,
            jobType,
            payload,
            options: { priority, delay },
        });
        return {
            jobId: result.jobId,
            jobPda: result.jobPda.toBase58(),
            signature: result.signature,
            payloadBytes: result.payloadBytes,
        };
    });
}
function cancelJobFromWallet(_a) {
    return __awaiter(this, arguments, void 0, function* ({ cluster, queueAddress, wallet, jobAddress, }) {
        if (!(wallet === null || wallet === void 0 ? void 0 : wallet.publicKey)) {
            throw new Error("Connect your wallet to cancel a job.");
        }
        const queuePublicKey = new web3_js_1.PublicKey(queueAddress);
        const jobPublicKey = new web3_js_1.PublicKey(jobAddress);
        const { program } = getProgram(cluster, wallet);
        return (0, decqueue_core_1.cancelJobWithProgram)({
            program,
            authority: wallet.publicKey,
            queuePda: queuePublicKey,
            jobPda: jobPublicKey,
            indexPageSeq: 0,
        });
    });
}
function fetchQueueSnapshot(cluster, queueAddress) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const queuePublicKey = new web3_js_1.PublicKey(queueAddress);
        const { connection, program } = getProgram(cluster);
        const [rawQueue, slot] = yield Promise.all([
            program.account.queue.fetch(queuePublicKey),
            connection.getSlot("confirmed"),
        ]);
        const totalJobs = toNumber(rawQueue.jobCount);
        const jobKeys = Array.from({ length: totalJobs }, (_, index) => (0, decqueue_core_1.deriveJobPda)(decqueue_core_1.PROGRAM_ID, queuePublicKey, index)[0]);
        const jobs = [];
        for (const keyChunk of chunk(jobKeys, 50)) {
            const batch = yield program.account.job.fetchMultiple(keyChunk);
            batch.forEach((rawJob, index) => {
                if (rawJob) {
                    jobs.push(normalizeJob(keyChunk[index], rawJob));
                }
            });
        }
        jobs.sort((left, right) => {
            if (left.status !== right.status) {
                const order = {
                    processing: 0,
                    pending: 1,
                    failed: 2,
                    completed: 3,
                    cancelled: 4,
                };
                return order[left.status] - order[right.status];
            }
            if (left.priority !== right.priority) {
                return right.priority - left.priority;
            }
            return right.createdAt.getTime() - left.createdAt.getTime();
        });
        return {
            queue: {
                publicKey: queuePublicKey.toBase58(),
                name: rawQueue.name,
                authority: rawQueue.authority.toBase58(),
                totalJobs,
                pendingJobs: toNumber(rawQueue.pendingCount),
                completedJobs: toNumber(rawQueue.processedCount),
                failedJobs: toNumber(rawQueue.failedCount),
                maxRetries: rawQueue.maxRetries,
                paused: rawQueue.paused,
                createdAt: (_a = toDate(rawQueue.createdAt)) !== null && _a !== void 0 ? _a : new Date(0),
            },
            jobs,
            slot,
            fetchedAt: new Date(),
        };
    });
}
function subscribeToQueueEvents(cluster, queueAddress, onEvent) {
    return __awaiter(this, void 0, void 0, function* () {
        const queuePublicKey = new web3_js_1.PublicKey(queueAddress);
        const { program } = getProgram(cluster);
        const eventNames = [
            "jobEnqueued",
            "jobClaimed",
            "jobCompleted",
            "jobFailed",
            "jobRetrying",
            "jobCancelled",
            "queuePauseChanged",
        ];
        const listenerIds = yield Promise.all(eventNames.map((eventName) => program.addEventListener(eventName, (event) => {
            var _a, _b;
            const eventQueue = (_b = (_a = event.queue) === null || _a === void 0 ? void 0 : _a.toBase58) === null || _b === void 0 ? void 0 : _b.call(_a);
            if (eventQueue && eventQueue !== queuePublicKey.toBase58()) {
                return;
            }
            onEvent({
                id: `${eventName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                text: formatEvent(eventName, event),
                timestamp: new Date(),
                kind: "event",
            });
        })));
        return () => __awaiter(this, void 0, void 0, function* () {
            yield Promise.all(listenerIds.map((listenerId) => program.removeEventListener(listenerId)));
        });
    });
}
