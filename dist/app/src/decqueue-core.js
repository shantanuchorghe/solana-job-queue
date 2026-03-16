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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_JOB_TYPE_LENGTH = exports.MAX_JOB_PAYLOAD_BYTES = exports.PROGRAM_ID = void 0;
exports.endpointForCluster = endpointForCluster;
exports.toNumber = toNumber;
exports.deriveJobPda = deriveJobPda;
exports.deriveIndexPagePda = deriveIndexPagePda;
exports.serializeJobPayload = serializeJobPayload;
exports.payloadByteLength = payloadByteLength;
exports.buildExecuteAfter = buildExecuteAfter;
exports.enqueueJobWithProgram = enqueueJobWithProgram;
exports.cancelJobWithProgram = cancelJobWithProgram;
const anchor_1 = require("@coral-xyz/anchor");
const buffer_1 = require("buffer");
const web3_js_1 = require("@solana/web3.js");
exports.PROGRAM_ID = new web3_js_1.PublicKey("GQdb3Gabjd28jXVnNZguU9cTwYsxw7Emrn2voQoyJA4a");
exports.MAX_JOB_PAYLOAD_BYTES = 512;
exports.MAX_JOB_TYPE_LENGTH = 32;
function endpointForCluster(cluster) {
    return cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899";
}
function toNumber(value) {
    return typeof value === "number" ? value : value.toNumber();
}
function deriveJobPda(programId, queuePubkey, jobId) {
    const idBytes = new Uint8Array(8);
    const view = new DataView(idBytes.buffer);
    view.setBigUint64(0, BigInt(jobId), true);
    return web3_js_1.PublicKey.findProgramAddressSync([new TextEncoder().encode("job"), queuePubkey.toBytes(), idBytes], programId);
}
function deriveIndexPagePda(programId, queuePubkey, seq) {
    const seqBytes = new Uint8Array(8);
    const view = new DataView(seqBytes.buffer);
    view.setBigUint64(0, BigInt(seq), true);
    return web3_js_1.PublicKey.findProgramAddressSync([new TextEncoder().encode("index"), queuePubkey.toBytes(), seqBytes], programId);
}
function serializeJobPayload(payload) {
    const encoded = JSON.stringify(payload);
    if (encoded == null) {
        throw new Error("Payload must be valid JSON.");
    }
    return buffer_1.Buffer.from(encoded, "utf8");
}
function payloadByteLength(payload) {
    return serializeJobPayload(payload).byteLength;
}
function buildExecuteAfter(delay = 0) {
    if (!Number.isFinite(delay) || delay < 0) {
        throw new Error("Delay must be zero or greater.");
    }
    if (delay === 0) {
        return new anchor_1.BN(0);
    }
    return new anchor_1.BN(Math.floor(Date.now() / 1000) + Math.floor(delay / 1000));
}
function enqueueJobWithProgram(_a) {
    return __awaiter(this, arguments, void 0, function* ({ program, payer, queuePda, jobType, payload, options = {}, }) {
        const normalizedJobType = jobType.trim();
        const { priority = 1, delay = 0 } = options;
        if (!normalizedJobType) {
            throw new Error("Job type is required.");
        }
        if (normalizedJobType.length > exports.MAX_JOB_TYPE_LENGTH) {
            throw new Error(`Job type must be ${exports.MAX_JOB_TYPE_LENGTH} characters or fewer.`);
        }
        if (!Number.isInteger(priority) || priority < 0 || priority > 2) {
            throw new Error("Priority must be 0 (low), 1 (normal), or 2 (high).");
        }
        const payloadBytes = serializeJobPayload(payload);
        if (payloadBytes.byteLength > exports.MAX_JOB_PAYLOAD_BYTES) {
            throw new Error(`Payload is ${payloadBytes.byteLength} bytes. The on-chain limit is ${exports.MAX_JOB_PAYLOAD_BYTES} bytes.`);
        }
        const queueData = yield program.account.queue.fetch(queuePda);
        const jobId = toNumber(queueData.jobCount);
        const [jobPda] = deriveJobPda(program.programId, queuePda, jobId);
        const executeAfter = buildExecuteAfter(delay);
        const signature = yield program.methods
            .enqueueJob(payloadBytes, normalizedJobType, priority, executeAfter)
            .accounts({
            queue: queuePda,
            job: jobPda,
            payer,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .rpc();
        return { jobPda, jobId, signature, payloadBytes: payloadBytes.byteLength };
    });
}
function cancelJobWithProgram(_a) {
    return __awaiter(this, arguments, void 0, function* ({ program, authority, queuePda, jobPda, indexPageSeq = 0, }) {
        const [sourceIndexPage] = deriveIndexPagePda(program.programId, queuePda, indexPageSeq);
        return program.methods
            .cancelJob()
            .accounts({
            queue: queuePda,
            job: jobPda,
            authority,
            sourceIndexPage,
        })
            .rpc();
    });
}
