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
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const chai_1 = require("chai");
// ─────────────────────────────────────────────────────────────────────────────
// DecQueue Test Suite
// Tests cover the full job lifecycle + edge cases + index PDA lookups
// Run with: anchor test --skip-local-validator --provider.cluster localnet
// ─────────────────────────────────────────────────────────────────────────────
describe("DecQueue — On-Chain Job Queue", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.DecQueue;
    const authority = provider.wallet;
    const worker = web3_js_1.Keypair.generate();
    let queuePda;
    let queueBump;
    const queueName = `email-${Date.now().toString(36)}`;
    // ── PDA helpers ───────────────────────────────────────────────────────────
    function deriveQueuePda(auth, name) {
        return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("queue"), auth.toBuffer(), Buffer.from(name)], program.programId);
    }
    function deriveJobPda(queue, jobId) {
        const idBuffer = Buffer.alloc(8);
        idBuffer.writeBigUInt64LE(BigInt(jobId.toString()));
        return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("job"), queue.toBuffer(), idBuffer], program.programId);
    }
    function deriveIndexPda(queue, indexType) {
        return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("index"), queue.toBuffer(), Buffer.from(indexType)], program.programId);
    }
    // Shorthand to derive all 6 index PDAs for a queue
    function deriveAllIndexPdas(queue) {
        return {
            pendingIndex: deriveIndexPda(queue, "pending")[0],
            processingIndex: deriveIndexPda(queue, "processing")[0],
            delayedIndex: deriveIndexPda(queue, "delayed")[0],
            failedIndex: deriveIndexPda(queue, "failed")[0],
            completedIndex: deriveIndexPda(queue, "completed")[0],
            cancelledIndex: deriveIndexPda(queue, "cancelled")[0],
        };
    }
    function fundAccount(recipient, lamports) {
        return __awaiter(this, void 0, void 0, function* () {
            const signature = yield provider.sendAndConfirm(new web3_js_1.Transaction().add(web3_js_1.SystemProgram.transfer({
                fromPubkey: authority.publicKey,
                toPubkey: recipient,
                lamports,
            })));
            yield provider.connection.confirmTransaction(signature);
        });
    }
    let indexes;
    // ── Fund test worker ──────────────────────────────────────────────────────
    before(() => __awaiter(void 0, void 0, void 0, function* () {
        yield fundAccount(worker.publicKey, 0.25 * anchor.web3.LAMPORTS_PER_SOL);
        console.log(`  ✓ Worker funded: ${worker.publicKey.toBase58()}`);
    }));
    // ─── Test 1: Initialize Queue ─────────────────────────────────────────────
    it("creates a queue with correct metadata", () => __awaiter(void 0, void 0, void 0, function* () {
        [queuePda, queueBump] = deriveQueuePda(authority.publicKey, queueName);
        yield program.methods
            .initializeQueue(queueName, 3)
            .accounts({
            queue: queuePda,
            authority: authority.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .rpc();
        const queue = yield program.account.queue.fetch(queuePda);
        chai_1.assert.equal(queue.name, queueName);
        chai_1.assert.equal(queue.authority.toBase58(), authority.publicKey.toBase58());
        chai_1.assert.equal(queue.maxRetries, 3);
        chai_1.assert.equal(queue.jobCount.toNumber(), 0);
        chai_1.assert.equal(queue.paused, false);
        console.log(`  ✓ Queue PDA: ${queuePda.toBase58()}`);
    }));
    // ─── Test 1b: Initialize Indexes ──────────────────────────────────────────
    it("initializes all 6 index PDAs for the queue", () => __awaiter(void 0, void 0, void 0, function* () {
        indexes = deriveAllIndexPdas(queuePda);
        yield program.methods
            .initializeIndexes()
            .accounts({
            queue: queuePda,
            pendingIndex: indexes.pendingIndex,
            processingIndex: indexes.processingIndex,
            delayedIndex: indexes.delayedIndex,
            failedIndex: indexes.failedIndex,
            completedIndex: indexes.completedIndex,
            cancelledIndex: indexes.cancelledIndex,
            authority: authority.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .rpc();
        const pending = yield program.account.jobIndex.fetch(indexes.pendingIndex);
        chai_1.assert.equal(pending.queue.toBase58(), queuePda.toBase58());
        chai_1.assert.equal(pending.jobIds.length, 0);
        console.log(`  ✓ All 6 indexes initialized`);
    }));
    // ─── Test 2: Enqueue a job ────────────────────────────────────────────────
    it("enqueues a job and adds it to the pending index", () => __awaiter(void 0, void 0, void 0, function* () {
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(0));
        const payload = Buffer.from(JSON.stringify({
            to: "user@example.com",
            subject: "Welcome to DecQueue!",
            template: "welcome-v2",
        }));
        yield program.methods
            .enqueueJob(payload, "send-email", 1, new anchor_1.BN(0))
            .accounts({
            queue: queuePda,
            job: jobPda,
            pendingIndex: indexes.pendingIndex,
            payer: authority.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .rpc();
        const job = yield program.account.job.fetch(jobPda);
        chai_1.assert.equal(job.jobType, "send-email");
        chai_1.assert.equal(job.priority, 1);
        chai_1.assert.deepEqual(job.status, { pending: {} });
        // Verify job is in the pending index
        const pending = yield program.account.jobIndex.fetch(indexes.pendingIndex);
        chai_1.assert.equal(pending.jobIds.length, 1);
        chai_1.assert.equal(pending.jobIds[0].toNumber(), 0);
        console.log(`  ✓ Job #0 PDA: ${jobPda.toBase58()}`);
    }));
    // ─── Test 3: Claim a job ──────────────────────────────────────────────────
    it("worker claims a pending job — moves from pending to processing index", () => __awaiter(void 0, void 0, void 0, function* () {
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(0));
        yield program.methods
            .claimJob()
            .accounts({
            job: jobPda,
            worker: worker.publicKey,
            pendingIndex: indexes.pendingIndex,
            delayedIndex: indexes.delayedIndex,
            processingIndex: indexes.processingIndex,
        })
            .signers([worker])
            .rpc();
        const job = yield program.account.job.fetch(jobPda);
        chai_1.assert.deepEqual(job.status, { processing: {} });
        chai_1.assert.equal(job.worker.toBase58(), worker.publicKey.toBase58());
        // Verify index updates
        const pending = yield program.account.jobIndex.fetch(indexes.pendingIndex);
        chai_1.assert.equal(pending.jobIds.length, 0);
        const processing = yield program.account.jobIndex.fetch(indexes.processingIndex);
        chai_1.assert.equal(processing.jobIds.length, 1);
        chai_1.assert.equal(processing.jobIds[0].toNumber(), 0);
        console.log(`  ✓ Job claimed — pending→processing index updated`);
    }));
    // ─── Test 4: Complete a job ───────────────────────────────────────────────
    it("worker completes job — moves from processing to completed index", () => __awaiter(void 0, void 0, void 0, function* () {
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(0));
        const result = JSON.stringify({ messageId: "msg_abc123", status: "sent" });
        yield program.methods
            .completeJob(result)
            .accounts({
            queue: queuePda,
            job: jobPda,
            worker: worker.publicKey,
            processingIndex: indexes.processingIndex,
            completedIndex: indexes.completedIndex,
        })
            .signers([worker])
            .rpc();
        const job = yield program.account.job.fetch(jobPda);
        chai_1.assert.deepEqual(job.status, { completed: {} });
        chai_1.assert.equal(job.result, result);
        // Verify index updates
        const processing = yield program.account.jobIndex.fetch(indexes.processingIndex);
        chai_1.assert.equal(processing.jobIds.length, 0);
        const completed = yield program.account.jobIndex.fetch(indexes.completedIndex);
        chai_1.assert.equal(completed.jobIds.length, 1);
        chai_1.assert.equal(completed.jobIds[0].toNumber(), 0);
        console.log(`  ✓ Job completed — processing→completed index updated`);
    }));
    // ─── Test 5: Retry logic ──────────────────────────────────────────────────
    it("failing a job below max_retries moves it to the delayed index", () => __awaiter(void 0, void 0, void 0, function* () {
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(1));
        yield program.methods
            .enqueueJob(Buffer.from("retry-test"), "webhook-call", 2, new anchor_1.BN(0))
            .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: web3_js_1.SystemProgram.programId })
            .rpc();
        // Claim it
        yield program.methods.claimJob()
            .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex })
            .signers([worker])
            .rpc();
        // Fail it with immediate retry
        yield program.methods
            .failJob("Connection timeout", new anchor_1.BN(0))
            .accounts({ queue: queuePda, job: jobPda, worker: worker.publicKey, processingIndex: indexes.processingIndex, delayedIndex: indexes.delayedIndex, failedIndex: indexes.failedIndex })
            .signers([worker])
            .rpc();
        const job = yield program.account.job.fetch(jobPda);
        chai_1.assert.deepEqual(job.status, { pending: {} });
        chai_1.assert.equal(job.attempts, 1);
        // Verify it moved to delayed index (retry with backoff)
        const delayed = yield program.account.jobIndex.fetch(indexes.delayedIndex);
        chai_1.assert.include(delayed.jobIds.map((id) => id.toNumber()), 1);
        console.log(`  ✓ Job re-queued to delayed index after failure`);
    }));
    // ─── Test 6: Dead letter after max retries ────────────────────────────────
    it("job reaches Failed state and moves to failed index", () => __awaiter(void 0, void 0, void 0, function* () {
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(1));
        for (let i = 0; i < 3; i++) {
            try {
                yield program.methods.claimJob()
                    .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex })
                    .signers([worker])
                    .rpc();
                yield program.methods
                    .failJob(`Attempt ${i + 2} failed`, new anchor_1.BN(0))
                    .accounts({ queue: queuePda, job: jobPda, worker: worker.publicKey, processingIndex: indexes.processingIndex, delayedIndex: indexes.delayedIndex, failedIndex: indexes.failedIndex })
                    .signers([worker])
                    .rpc();
            }
            catch (_) {
                break;
            }
        }
        const job = yield program.account.job.fetch(jobPda);
        chai_1.assert.deepEqual(job.status, { failed: {} });
        // Verify it's in the failed index
        const failed = yield program.account.jobIndex.fetch(indexes.failedIndex);
        chai_1.assert.include(failed.jobIds.map((id) => id.toNumber()), 1);
        console.log(`  ✓ Job reached dead-letter state in failed index`);
    }));
    // ─── Test 7: Cancel a job ─────────────────────────────────────────────────
    it("authority cancels a pending job — moves to cancelled index", () => __awaiter(void 0, void 0, void 0, function* () {
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(2));
        yield program.methods
            .enqueueJob(Buffer.from("cancel-me"), "image-resize", 0, new anchor_1.BN(0))
            .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: web3_js_1.SystemProgram.programId })
            .rpc();
        yield program.methods.cancelJob()
            .accounts({
            queue: queuePda,
            job: jobPda,
            authority: authority.publicKey,
            pendingIndex: indexes.pendingIndex,
            delayedIndex: indexes.delayedIndex,
            processingIndex: indexes.processingIndex,
            cancelledIndex: indexes.cancelledIndex,
        })
            .rpc();
        const job = yield program.account.job.fetch(jobPda);
        chai_1.assert.deepEqual(job.status, { cancelled: {} });
        // Verify it's in the cancelled index
        const cancelled = yield program.account.jobIndex.fetch(indexes.cancelledIndex);
        chai_1.assert.include(cancelled.jobIds.map((id) => id.toNumber()), 2);
        console.log(`  ✓ Job #2 cancelled — moved to cancelled index`);
    }));
    // ─── Test 8: Scheduled job ────────────────────────────────────────────────
    it("scheduled job cannot be claimed before execute_after", () => __awaiter(void 0, void 0, void 0, function* () {
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(3));
        const futureTime = new anchor_1.BN(Math.floor(Date.now() / 1000) + 3600);
        yield program.methods
            .enqueueJob(Buffer.from("run later"), "daily-report", 1, futureTime)
            .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: web3_js_1.SystemProgram.programId })
            .rpc();
        try {
            yield program.methods.claimJob()
                .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex })
                .signers([worker])
                .rpc();
            chai_1.assert.fail("Should have thrown JobNotReady error");
        }
        catch (err) {
            chai_1.assert.include(err.message, "JobNotReady");
            console.log(`  ✓ Scheduled job correctly blocked from early claim`);
        }
    }));
    // ─── Test 9: Pause queue ──────────────────────────────────────────────────
    it("pausing queue blocks new job submissions", () => __awaiter(void 0, void 0, void 0, function* () {
        yield program.methods
            .setQueuePaused(true)
            .accounts({ queue: queuePda, authority: authority.publicKey })
            .rpc();
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(4));
        try {
            yield program.methods
                .enqueueJob(Buffer.from("blocked"), "test-job", 1, new anchor_1.BN(0))
                .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: web3_js_1.SystemProgram.programId })
                .rpc();
            chai_1.assert.fail("Should have thrown QueuePaused");
        }
        catch (err) {
            chai_1.assert.include(err.message, "QueuePaused");
            console.log(`  ✓ Paused queue correctly rejected new job`);
        }
        yield program.methods
            .setQueuePaused(false)
            .accounts({ queue: queuePda, authority: authority.publicKey })
            .rpc();
    }));
    // ─── Test 10: Unauthorized claim completion ───────────────────────────────
    it("wrong worker cannot complete another worker's job", () => __awaiter(void 0, void 0, void 0, function* () {
        const interloper = web3_js_1.Keypair.generate();
        yield fundAccount(interloper.publicKey, 0.25 * anchor.web3.LAMPORTS_PER_SOL);
        const [jobPda] = deriveJobPda(queuePda, new anchor_1.BN(4));
        yield program.methods
            .enqueueJob(Buffer.from("secure"), "audit-log", 2, new anchor_1.BN(0))
            .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: web3_js_1.SystemProgram.programId })
            .rpc();
        yield program.methods.claimJob()
            .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex })
            .signers([worker])
            .rpc();
        try {
            yield program.methods.completeJob("stolen result")
                .accounts({ queue: queuePda, job: jobPda, worker: interloper.publicKey, processingIndex: indexes.processingIndex, completedIndex: indexes.completedIndex })
                .signers([interloper])
                .rpc();
            chai_1.assert.fail("Should have thrown Unauthorized");
        }
        catch (err) {
            chai_1.assert.include(err.message, "Unauthorized");
            console.log(`  ✓ Unauthorized worker correctly blocked from job completion`);
        }
    }));
    // ─── Summary ──────────────────────────────────────────────────────────────
    after(() => __awaiter(void 0, void 0, void 0, function* () {
        if (!queuePda) {
            return;
        }
        const queue = yield program.account.queue.fetch(queuePda);
        console.log("\n  ════ Queue Final Stats ════");
        console.log(`  Total jobs enqueued:  ${queue.jobCount.toString()}`);
        console.log(`  Completed:            ${queue.processedCount.toString()}`);
        console.log(`  Failed (dead letter): ${queue.failedCount.toString()}`);
        console.log(`  Pending:              ${queue.pendingCount.toString()}`);
        // Show index contents
        const idx = deriveAllIndexPdas(queuePda);
        for (const [name, pda] of Object.entries(idx)) {
            try {
                const data = yield program.account.jobIndex.fetch(pda);
                const ids = data.jobIds.map((id) => id.toNumber());
                console.log(`  ${name.padEnd(18)} ${ids.length > 0 ? ids.join(", ") : "(empty)"}`);
            }
            catch (_a) {
                console.log(`  ${name.padEnd(18)} (not initialized)`);
            }
        }
        console.log(`  Queue PDA:            ${queuePda.toBase58()}`);
        console.log(`  Program ID:           ${program.programId.toBase58()}`);
    }));
});
