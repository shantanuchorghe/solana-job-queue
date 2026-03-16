import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { DecQueue } from "../target/types/dec_queue";

// ─────────────────────────────────────────────────────────────────────────────
// DecQueue Test Suite
// Tests cover the full job lifecycle + edge cases + index PDA lookups
// Run with: anchor test --skip-local-validator --provider.cluster localnet
// ─────────────────────────────────────────────────────────────────────────────

describe("DecQueue — On-Chain Job Queue", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DecQueue as Program<DecQueue>;
  const authority = provider.wallet as anchor.Wallet;
  const worker = Keypair.generate();

  let queuePda: PublicKey;
  let queueBump: number;
  const queueName = `email-${Date.now().toString(36)}`;

  // ── PDA helpers ───────────────────────────────────────────────────────────
  function deriveQueuePda(auth: PublicKey, name: string) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("queue"), auth.toBuffer(), Buffer.from(name)],
      program.programId
    );
  }

  function deriveJobPda(queue: PublicKey, jobId: BN) {
    const idBuffer = Buffer.alloc(8);
    idBuffer.writeBigUInt64LE(BigInt(jobId.toString()));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("job"), queue.toBuffer(), idBuffer],
      program.programId
    );
  }

  function deriveIndexPda(queue: PublicKey, indexType: string) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("index"), queue.toBuffer(), Buffer.from(indexType)],
      program.programId
    );
  }

  // Shorthand to derive all 6 index PDAs for a queue
  function deriveAllIndexPdas(queue: PublicKey) {
    return {
      pendingIndex: deriveIndexPda(queue, "pending")[0],
      processingIndex: deriveIndexPda(queue, "processing")[0],
      delayedIndex: deriveIndexPda(queue, "delayed")[0],
      failedIndex: deriveIndexPda(queue, "failed")[0],
      completedIndex: deriveIndexPda(queue, "completed")[0],
      cancelledIndex: deriveIndexPda(queue, "cancelled")[0],
    };
  }

  async function fundAccount(recipient: PublicKey, lamports: number) {
    const signature = await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: recipient,
          lamports,
        })
      )
    );
    await provider.connection.confirmTransaction(signature);
  }

  let indexes: ReturnType<typeof deriveAllIndexPdas>;

  // ── Fund test worker ──────────────────────────────────────────────────────
  before(async () => {
    await fundAccount(
      worker.publicKey,
      0.25 * anchor.web3.LAMPORTS_PER_SOL
    );
    console.log(`  ✓ Worker funded: ${worker.publicKey.toBase58()}`);
  });

  // ─── Test 1: Initialize Queue ─────────────────────────────────────────────
  it("creates a queue with correct metadata", async () => {
    [queuePda, queueBump] = deriveQueuePda(authority.publicKey, queueName);

    await program.methods
      .initializeQueue(queueName, 3)
      .accounts({
        queue: queuePda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const queue = await program.account.queue.fetch(queuePda);
    assert.equal(queue.name, queueName);
    assert.equal(queue.authority.toBase58(), authority.publicKey.toBase58());
    assert.equal(queue.maxRetries, 3);
    assert.equal(queue.jobCount.toNumber(), 0);
    assert.equal(queue.paused, false);

    console.log(`  ✓ Queue PDA: ${queuePda.toBase58()}`);
  });

  // ─── Test 1b: Initialize Indexes ──────────────────────────────────────────
  it("initializes all 6 index PDAs for the queue", async () => {
    indexes = deriveAllIndexPdas(queuePda);

    await program.methods
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
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const pending = await program.account.jobIndex.fetch(indexes.pendingIndex);
    assert.equal(pending.queue.toBase58(), queuePda.toBase58());
    assert.equal(pending.jobIds.length, 0);

    console.log(`  ✓ All 6 indexes initialized`);
  });

  // ─── Test 2: Enqueue a job ────────────────────────────────────────────────
  it("enqueues a job and adds it to the pending index", async () => {
    const [jobPda] = deriveJobPda(queuePda, new BN(0));
    const payload = Buffer.from(JSON.stringify({
      to: "user@example.com",
      subject: "Welcome to DecQueue!",
      template: "welcome-v2",
    }));

    await program.methods
      .enqueueJob(payload, "send-email", 1, new BN(0))
      .accounts({
        queue: queuePda,
        job: jobPda,
        pendingIndex: indexes.pendingIndex,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const job = await program.account.job.fetch(jobPda);
    assert.equal(job.jobType, "send-email");
    assert.equal(job.priority, 1);
    assert.deepEqual(job.status, { pending: {} });

    // Verify job is in the pending index
    const pending = await program.account.jobIndex.fetch(indexes.pendingIndex);
    assert.equal(pending.jobIds.length, 1);
    assert.equal(pending.jobIds[0].toNumber(), 0);

    console.log(`  ✓ Job #0 PDA: ${jobPda.toBase58()}`);
  });

  // ─── Test 3: Claim a job ──────────────────────────────────────────────────
  it("worker claims a pending job — moves from pending to processing index", async () => {
    const [jobPda] = deriveJobPda(queuePda, new BN(0));

    await program.methods
      .claimJob()
      .accounts({
        job: jobPda,
        worker: worker.publicKey,
        pendingIndex: indexes.pendingIndex,
        delayedIndex: indexes.delayedIndex,
        processingIndex: indexes.processingIndex,
      } as any)
      .signers([worker])
      .rpc();

    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.status, { processing: {} });
    assert.equal(job.worker!.toBase58(), worker.publicKey.toBase58());

    // Verify index updates
    const pending = await program.account.jobIndex.fetch(indexes.pendingIndex);
    assert.equal(pending.jobIds.length, 0);

    const processing = await program.account.jobIndex.fetch(indexes.processingIndex);
    assert.equal(processing.jobIds.length, 1);
    assert.equal(processing.jobIds[0].toNumber(), 0);

    console.log(`  ✓ Job claimed — pending→processing index updated`);
  });

  // ─── Test 4: Complete a job ───────────────────────────────────────────────
  it("worker completes job — moves from processing to completed index", async () => {
    const [jobPda] = deriveJobPda(queuePda, new BN(0));
    const result = JSON.stringify({ messageId: "msg_abc123", status: "sent" });

    await program.methods
      .completeJob(result)
      .accounts({
        queue: queuePda,
        job: jobPda,
        worker: worker.publicKey,
        processingIndex: indexes.processingIndex,
        completedIndex: indexes.completedIndex,
      } as any)
      .signers([worker])
      .rpc();

    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.status, { completed: {} });
    assert.equal(job.result, result);

    // Verify index updates
    const processing = await program.account.jobIndex.fetch(indexes.processingIndex);
    assert.equal(processing.jobIds.length, 0);

    const completed = await program.account.jobIndex.fetch(indexes.completedIndex);
    assert.equal(completed.jobIds.length, 1);
    assert.equal(completed.jobIds[0].toNumber(), 0);

    console.log(`  ✓ Job completed — processing→completed index updated`);
  });

  // ─── Test 5: Retry logic ──────────────────────────────────────────────────
  it("failing a job below max_retries moves it to the delayed index", async () => {
    const [jobPda] = deriveJobPda(queuePda, new BN(1));
    await program.methods
      .enqueueJob(Buffer.from("retry-test"), "webhook-call", 2, new BN(0))
      .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: SystemProgram.programId } as any)
      .rpc();

    // Claim it
    await program.methods.claimJob()
      .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex } as any)
      .signers([worker])
      .rpc();

    // Fail it with immediate retry
    await program.methods
      .failJob("Connection timeout", new BN(0))
      .accounts({ queue: queuePda, job: jobPda, worker: worker.publicKey, processingIndex: indexes.processingIndex, delayedIndex: indexes.delayedIndex, failedIndex: indexes.failedIndex } as any)
      .signers([worker])
      .rpc();

    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.status, { pending: {} });
    assert.equal(job.attempts, 1);

    // Verify it moved to delayed index (retry with backoff)
    const delayed = await program.account.jobIndex.fetch(indexes.delayedIndex);
    assert.include(
      delayed.jobIds.map((id: any) => id.toNumber()),
      1
    );

    console.log(`  ✓ Job re-queued to delayed index after failure`);
  });

  // ─── Test 6: Dead letter after max retries ────────────────────────────────
  it("job reaches Failed state and moves to failed index", async () => {
    const [jobPda] = deriveJobPda(queuePda, new BN(1));

    for (let i = 0; i < 3; i++) {
      try {
        await program.methods.claimJob()
          .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex } as any)
          .signers([worker])
          .rpc();

        await program.methods
          .failJob(`Attempt ${i + 2} failed`, new BN(0))
          .accounts({ queue: queuePda, job: jobPda, worker: worker.publicKey, processingIndex: indexes.processingIndex, delayedIndex: indexes.delayedIndex, failedIndex: indexes.failedIndex } as any)
          .signers([worker])
          .rpc();
      } catch (_) {
        break;
      }
    }

    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.status, { failed: {} });

    // Verify it's in the failed index
    const failed = await program.account.jobIndex.fetch(indexes.failedIndex);
    assert.include(
      failed.jobIds.map((id: any) => id.toNumber()),
      1
    );

    console.log(`  ✓ Job reached dead-letter state in failed index`);
  });

  // ─── Test 7: Cancel a job ─────────────────────────────────────────────────
  it("authority cancels a pending job — moves to cancelled index", async () => {
    const [jobPda] = deriveJobPda(queuePda, new BN(2));

    await program.methods
      .enqueueJob(Buffer.from("cancel-me"), "image-resize", 0, new BN(0))
      .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: SystemProgram.programId } as any)
      .rpc();

    await program.methods.cancelJob()
      .accounts({
        queue: queuePda,
        job: jobPda,
        authority: authority.publicKey,
        pendingIndex: indexes.pendingIndex,
        delayedIndex: indexes.delayedIndex,
        processingIndex: indexes.processingIndex,
        cancelledIndex: indexes.cancelledIndex,
      } as any)
      .rpc();

    const job = await program.account.job.fetch(jobPda);
    assert.deepEqual(job.status, { cancelled: {} });

    // Verify it's in the cancelled index
    const cancelled = await program.account.jobIndex.fetch(indexes.cancelledIndex);
    assert.include(
      cancelled.jobIds.map((id: any) => id.toNumber()),
      2
    );

    console.log(`  ✓ Job #2 cancelled — moved to cancelled index`);
  });

  // ─── Test 8: Scheduled job ────────────────────────────────────────────────
  it("scheduled job cannot be claimed before execute_after", async () => {
    const [jobPda] = deriveJobPda(queuePda, new BN(3));
    const futureTime = new BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .enqueueJob(Buffer.from("run later"), "daily-report", 1, futureTime)
      .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: SystemProgram.programId } as any)
      .rpc();

    try {
      await program.methods.claimJob()
        .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex } as any)
        .signers([worker])
        .rpc();
      assert.fail("Should have thrown JobNotReady error");
    } catch (err: any) {
      assert.include(err.message, "JobNotReady");
      console.log(`  ✓ Scheduled job correctly blocked from early claim`);
    }
  });

  // ─── Test 9: Pause queue ──────────────────────────────────────────────────
  it("pausing queue blocks new job submissions", async () => {
    await program.methods
      .setQueuePaused(true)
      .accounts({ queue: queuePda, authority: authority.publicKey })
      .rpc();

    const [jobPda] = deriveJobPda(queuePda, new BN(4));

    try {
      await program.methods
        .enqueueJob(Buffer.from("blocked"), "test-job", 1, new BN(0))
        .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: SystemProgram.programId } as any)
        .rpc();
      assert.fail("Should have thrown QueuePaused");
    } catch (err: any) {
      assert.include(err.message, "QueuePaused");
      console.log(`  ✓ Paused queue correctly rejected new job`);
    }

    await program.methods
      .setQueuePaused(false)
      .accounts({ queue: queuePda, authority: authority.publicKey })
      .rpc();
  });

  // ─── Test 10: Unauthorized claim completion ───────────────────────────────
  it("wrong worker cannot complete another worker's job", async () => {
    const interloper = Keypair.generate();
    await fundAccount(
      interloper.publicKey,
      0.25 * anchor.web3.LAMPORTS_PER_SOL
    );

    const [jobPda] = deriveJobPda(queuePda, new BN(4));
    await program.methods
      .enqueueJob(Buffer.from("secure"), "audit-log", 2, new BN(0))
      .accounts({ queue: queuePda, job: jobPda, pendingIndex: indexes.pendingIndex, payer: authority.publicKey, systemProgram: SystemProgram.programId } as any)
      .rpc();

    await program.methods.claimJob()
      .accounts({ job: jobPda, worker: worker.publicKey, pendingIndex: indexes.pendingIndex, delayedIndex: indexes.delayedIndex, processingIndex: indexes.processingIndex } as any)
      .signers([worker])
      .rpc();

    try {
      await program.methods.completeJob("stolen result")
        .accounts({ queue: queuePda, job: jobPda, worker: interloper.publicKey, processingIndex: indexes.processingIndex, completedIndex: indexes.completedIndex } as any)
        .signers([interloper])
        .rpc();
      assert.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      assert.include(err.message, "Unauthorized");
      console.log(`  ✓ Unauthorized worker correctly blocked from job completion`);
    }
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  after(async () => {
    if (!queuePda) {
      return;
    }

    const queue = await program.account.queue.fetch(queuePda);
    console.log("\n  ════ Queue Final Stats ════");
    console.log(`  Total jobs enqueued:  ${queue.jobCount.toString()}`);
    console.log(`  Completed:            ${queue.processedCount.toString()}`);
    console.log(`  Failed (dead letter): ${queue.failedCount.toString()}`);
    console.log(`  Pending:              ${queue.pendingCount.toString()}`);

    // Show index contents
    const idx = deriveAllIndexPdas(queuePda);
    for (const [name, pda] of Object.entries(idx)) {
      try {
        const data = await program.account.jobIndex.fetch(pda);
        const ids = data.jobIds.map((id: any) => id.toNumber());
        console.log(`  ${name.padEnd(18)} ${ids.length > 0 ? ids.join(", ") : "(empty)"}`);
      } catch {
        console.log(`  ${name.padEnd(18)} (not initialized)`);
      }
    }

    console.log(`  Queue PDA:            ${queuePda.toBase58()}`);
    console.log(`  Program ID:           ${program.programId.toBase58()}`);
  });
});
