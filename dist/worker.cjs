"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// client/worker.ts
var import_web34 = require("@solana/web3.js");

// client/index.ts
var anchor = __toESM(require("@coral-xyz/anchor"));
var import_anchor2 = require("@coral-xyz/anchor");
var import_web32 = require("@solana/web3.js");
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var import_stateless = require("@lightprotocol/stateless.js");

// shared/decqueue-core.ts
var import_anchor = require("@coral-xyz/anchor");
var import_web3 = require("@solana/web3.js");
var PROGRAM_ID = new import_web3.PublicKey("GQdb3Gabjd28jXVnNZguU9cTwYsxw7Emrn2voQoyJA4a");
var MAX_JOB_PAYLOAD_BYTES = 512;
var MAX_JOB_TYPE_LENGTH = 32;
function endpointForCluster(cluster) {
  const endpoints = {
    devnet: "https://api.devnet.solana.com",
    localnet: "http://127.0.0.1:8899",
    "mainnet-beta": "https://api.mainnet-beta.solana.com"
  };
  return endpoints[cluster];
}
function toNumber(value) {
  return typeof value === "number" ? value : value.toNumber();
}
function deriveQueuePda(programId, authority, queueName) {
  return import_web3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("queue"), authority.toBytes(), new TextEncoder().encode(queueName)],
    programId
  );
}
function deriveJobPda(programId, queuePubkey, jobId) {
  const idBytes = new Uint8Array(8);
  const view = new DataView(idBytes.buffer);
  view.setBigUint64(0, BigInt(jobId), true);
  return import_web3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("job"), queuePubkey.toBytes(), idBytes],
    programId
  );
}
function deriveIndexPda(programId, queuePubkey, indexType) {
  return import_web3.PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("index"),
      queuePubkey.toBytes(),
      new TextEncoder().encode(indexType)
    ],
    programId
  );
}
function serializeJobPayload(payload) {
  const encoded = JSON.stringify(payload);
  if (encoded == null) {
    throw new Error("Payload must be valid JSON.");
  }
  return Buffer.from(encoded, "utf8");
}
function buildExecuteAfter(delay = 0) {
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error("Delay must be zero or greater.");
  }
  if (delay === 0) {
    return new import_anchor.BN(0);
  }
  return new import_anchor.BN(Math.floor(Date.now() / 1e3) + Math.floor(delay / 1e3));
}
async function enqueueJobWithProgram({
  program,
  payer,
  queuePda,
  jobType,
  payload,
  options = {}
}) {
  const normalizedJobType = jobType.trim();
  const { priority = 1, delay = 0 } = options;
  if (!normalizedJobType) {
    throw new Error("Job type is required.");
  }
  if (normalizedJobType.length > MAX_JOB_TYPE_LENGTH) {
    throw new Error(`Job type must be ${MAX_JOB_TYPE_LENGTH} characters or fewer.`);
  }
  if (!Number.isInteger(priority) || priority < 0 || priority > 2) {
    throw new Error("Priority must be 0 (low), 1 (normal), or 2 (high).");
  }
  const payloadBytes = serializeJobPayload(payload);
  if (payloadBytes.byteLength > MAX_JOB_PAYLOAD_BYTES) {
    throw new Error(
      `Payload is ${payloadBytes.byteLength} bytes. The on-chain limit is ${MAX_JOB_PAYLOAD_BYTES} bytes.`
    );
  }
  const queueData = await program.account.queue.fetch(queuePda);
  const jobId = toNumber(queueData.jobCount);
  const [jobPda] = deriveJobPda(program.programId, queuePda, jobId);
  const executeAfter = buildExecuteAfter(delay);
  const [pendingIndex] = deriveIndexPda(program.programId, queuePda, "pending");
  const signature = await program.methods.enqueueJob(payloadBytes, normalizedJobType, priority, executeAfter).accounts({
    queue: queuePda,
    job: jobPda,
    pendingIndex,
    payer,
    systemProgram: import_web3.SystemProgram.programId
  }).rpc();
  return { jobPda, jobId, signature, payloadBytes: payloadBytes.byteLength };
}

// target/idl/dec_queue.json
var dec_queue_default = {
  address: "GQdb3Gabjd28jXVnNZguU9cTwYsxw7Emrn2voQoyJA4a",
  metadata: {
    name: "dec_queue",
    version: "0.1.0",
    spec: "0.1.0",
    description: "On-Chain Job Queue \u2014 rebuild of Bull/Redis/SQS as a Solana Anchor program"
  },
  instructions: [
    {
      name: "advance_head",
      discriminator: [
        100,
        7,
        98,
        197,
        138,
        87,
        255,
        23
      ],
      accounts: [
        {
          name: "queue_head",
          docs: [
            "The linked-list head \xE2\u20AC\u201D head_index_seq will be incremented."
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  113,
                  117,
                  101,
                  117,
                  101,
                  95,
                  104,
                  101,
                  97,
                  100
                ]
              },
              {
                kind: "account",
                path: "head_page.queue",
                account: "JobIndex"
              }
            ]
          }
        },
        {
          name: "head_page",
          docs: [
            "The current (empty) head page."
          ],
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  105,
                  110,
                  100,
                  101,
                  120
                ]
              },
              {
                kind: "account",
                path: "head_page.queue",
                account: "JobIndex"
              },
              {
                kind: "account",
                path: "queue_head.head_index_seq",
                account: "QueueHead"
              }
            ]
          }
        }
      ],
      args: []
    },
    {
      name: "cancel_job",
      discriminator: [
        126,
        241,
        155,
        241,
        50,
        236,
        83,
        118
      ],
      accounts: [
        {
          name: "queue",
          writable: true,
          relations: [
            "job"
          ]
        },
        {
          name: "job",
          writable: true
        },
        {
          name: "authority",
          signer: true
        },
        {
          name: "source_index_page",
          docs: [
            "The index page currently holding this job_id."
          ],
          writable: true
        }
      ],
      args: []
    },
    {
      name: "claim_job",
      discriminator: [
        9,
        160,
        5,
        231,
        116,
        123,
        198,
        14
      ],
      accounts: [
        {
          name: "job",
          writable: true
        },
        {
          name: "worker",
          signer: true
        },
        {
          name: "source_index_page",
          docs: [
            "The index page that currently contains this job_id.",
            'Verified by seed \xE2\u20AC\u201D callers compute [b"index", job.queue, page_seq.to_le_bytes()].'
          ],
          writable: true
        }
      ],
      args: []
    },
    {
      name: "complete_job",
      discriminator: [
        221,
        216,
        225,
        72,
        101,
        250,
        3,
        11
      ],
      accounts: [
        {
          name: "queue",
          writable: true,
          relations: [
            "job"
          ]
        },
        {
          name: "job",
          writable: true
        },
        {
          name: "worker",
          signer: true
        }
      ],
      args: [
        {
          name: "result",
          type: {
            option: "string"
          }
        }
      ]
    },
    {
      name: "enqueue_job",
      discriminator: [
        15,
        126,
        169,
        237,
        239,
        18,
        69,
        7
      ],
      accounts: [
        {
          name: "queue",
          writable: true
        },
        {
          name: "job",
          docs: [
            "Job PDA keyed by (queue, job_count) \xE2\u20AC\u201D job_count is captured before increment."
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  106,
                  111,
                  98
                ]
              },
              {
                kind: "account",
                path: "queue"
              },
              {
                kind: "account",
                path: "queue.job_count",
                account: "Queue"
              }
            ]
          }
        },
        {
          name: "queue_head",
          docs: [
            "QueueHead \xE2\u20AC\u201D needed to increment total_jobs."
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  113,
                  117,
                  101,
                  117,
                  101,
                  95,
                  104,
                  101,
                  97,
                  100
                ]
              },
              {
                kind: "account",
                path: "queue"
              }
            ]
          }
        },
        {
          name: "tail_index_page",
          docs: [
            "The current tail index page \xE2\u20AC\u201D job_id is appended here.",
            "The caller derives: seq = queue_head.tail_index_seq"
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  105,
                  110,
                  100,
                  101,
                  120
                ]
              },
              {
                kind: "account",
                path: "queue"
              },
              {
                kind: "account",
                path: "queue_head.tail_index_seq",
                account: "QueueHead"
              }
            ]
          }
        },
        {
          name: "payer",
          writable: true,
          signer: true
        },
        {
          name: "system_program",
          address: "11111111111111111111111111111111"
        }
      ],
      args: [
        {
          name: "payload",
          type: "bytes"
        },
        {
          name: "job_type",
          type: "string"
        },
        {
          name: "priority",
          type: "u8"
        },
        {
          name: "execute_after",
          type: "i64"
        }
      ]
    },
    {
      name: "fail_job",
      discriminator: [
        211,
        222,
        65,
        39,
        115,
        107,
        125,
        43
      ],
      accounts: [
        {
          name: "queue",
          writable: true,
          relations: [
            "job"
          ]
        },
        {
          name: "job",
          writable: true
        },
        {
          name: "worker",
          signer: true
        },
        {
          name: "retry_index_page",
          docs: [
            "The index page to push the retried job_id into (tail page of a retry queue,",
            "or any page with remaining capacity that the caller designates)."
          ],
          writable: true
        }
      ],
      args: [
        {
          name: "error_message",
          type: "string"
        },
        {
          name: "retry_after_secs",
          type: "i64"
        }
      ]
    },
    {
      name: "grow_index",
      discriminator: [
        222,
        32,
        78,
        153,
        148,
        86,
        108,
        168
      ],
      accounts: [
        {
          name: "queue"
        },
        {
          name: "queue_head",
          docs: [
            "The linked-list head PDA \xE2\u20AC\u201D tail_index_seq will be incremented here."
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  113,
                  117,
                  101,
                  117,
                  101,
                  95,
                  104,
                  101,
                  97,
                  100
                ]
              },
              {
                kind: "account",
                path: "queue"
              }
            ]
          }
        },
        {
          name: "current_tail_page",
          docs: [
            "The current (full) tail page.",
            "Seeds use queue_head.tail_index_seq before increment."
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  105,
                  110,
                  100,
                  101,
                  120
                ]
              },
              {
                kind: "account",
                path: "queue"
              },
              {
                kind: "account",
                path: "queue_head.tail_index_seq",
                account: "QueueHead"
              }
            ]
          }
        },
        {
          name: "new_tail_page",
          docs: [
            "The new tail page. Seeds use the new_seq instruction argument."
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  105,
                  110,
                  100,
                  101,
                  120
                ]
              },
              {
                kind: "account",
                path: "queue"
              },
              {
                kind: "arg",
                path: "new_seq"
              }
            ]
          }
        },
        {
          name: "authority",
          writable: true,
          signer: true
        },
        {
          name: "system_program",
          address: "11111111111111111111111111111111"
        }
      ],
      args: [
        {
          name: "new_seq",
          type: "u64"
        }
      ]
    },
    {
      name: "initialize_queue",
      discriminator: [
        174,
        102,
        132,
        232,
        90,
        202,
        27,
        20
      ],
      accounts: [
        {
          name: "queue",
          docs: [
            "The core queue metadata account.",
            'Seeds: [b"queue", authority, name]'
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              },
              {
                kind: "account",
                path: "authority"
              },
              {
                kind: "arg",
                path: "queue_name"
              }
            ]
          }
        },
        {
          name: "queue_head",
          docs: [
            "Linked-list head: tracks head_seq, tail_seq, total_jobs.",
            'Seeds: [b"queue_head", queue]'
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  113,
                  117,
                  101,
                  117,
                  101,
                  95,
                  104,
                  101,
                  97,
                  100
                ]
              },
              {
                kind: "account",
                path: "queue"
              }
            ]
          }
        },
        {
          name: "first_index_page",
          docs: [
            "The very first index page (seq = 0).",
            'Seeds: [b"index", queue, 0u64.to_le_bytes()]'
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: "const",
                value: [
                  105,
                  110,
                  100,
                  101,
                  120
                ]
              },
              {
                kind: "account",
                path: "queue"
              },
              {
                kind: "const",
                value: [
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0
                ]
              }
            ]
          }
        },
        {
          name: "authority",
          writable: true,
          signer: true
        },
        {
          name: "system_program",
          address: "11111111111111111111111111111111"
        }
      ],
      args: [
        {
          name: "queue_name",
          type: "string"
        },
        {
          name: "max_retries",
          type: "u8"
        }
      ]
    },
    {
      name: "set_queue_paused",
      discriminator: [
        75,
        37,
        8,
        150,
        81,
        113,
        10,
        209
      ],
      accounts: [
        {
          name: "queue",
          writable: true
        },
        {
          name: "authority",
          signer: true
        }
      ],
      args: [
        {
          name: "paused",
          type: "bool"
        }
      ]
    }
  ],
  accounts: [
    {
      name: "Job",
      discriminator: [
        75,
        124,
        80,
        203,
        161,
        180,
        202,
        80
      ]
    },
    {
      name: "JobIndex",
      discriminator: [
        100,
        14,
        60,
        78,
        100,
        211,
        119,
        193
      ]
    },
    {
      name: "Queue",
      discriminator: [
        204,
        167,
        6,
        247,
        20,
        33,
        2,
        188
      ]
    },
    {
      name: "QueueHead",
      discriminator: [
        252,
        245,
        9,
        149,
        18,
        35,
        210,
        142
      ]
    }
  ],
  events: [
    {
      name: "JobCancelled",
      discriminator: [
        203,
        84,
        143,
        130,
        48,
        134,
        74,
        191
      ]
    },
    {
      name: "JobClaimed",
      discriminator: [
        176,
        110,
        104,
        38,
        27,
        220,
        61,
        191
      ]
    },
    {
      name: "JobCompleted",
      discriminator: [
        176,
        207,
        246,
        115,
        95,
        179,
        9,
        132
      ]
    },
    {
      name: "JobEnqueued",
      discriminator: [
        253,
        145,
        52,
        57,
        172,
        39,
        112,
        100
      ]
    },
    {
      name: "JobFailed",
      discriminator: [
        239,
        142,
        192,
        215,
        175,
        72,
        19,
        44
      ]
    },
    {
      name: "JobRetrying",
      discriminator: [
        243,
        247,
        60,
        225,
        130,
        6,
        255,
        250
      ]
    },
    {
      name: "QueueCreated",
      discriminator: [
        18,
        135,
        244,
        181,
        162,
        83,
        90,
        175
      ]
    },
    {
      name: "QueuePauseChanged",
      discriminator: [
        119,
        113,
        147,
        17,
        142,
        38,
        83,
        126
      ]
    }
  ],
  errors: [
    {
      code: 6e3,
      name: "NameTooLong",
      msg: "Queue name must be between 1 and 32 characters"
    },
    {
      code: 6001,
      name: "InvalidRetries",
      msg: "max_retries cannot exceed 10"
    },
    {
      code: 6002,
      name: "InvalidPriority",
      msg: "Priority must be 0 (low), 1 (normal), or 2 (high)"
    },
    {
      code: 6003,
      name: "PayloadTooLarge",
      msg: "Payload exceeds 512 byte limit"
    },
    {
      code: 6004,
      name: "ResultTooLarge",
      msg: "Result or error message exceeds 128 character limit"
    },
    {
      code: 6005,
      name: "JobNotPending",
      msg: "Job must be in Pending status to be claimed"
    },
    {
      code: 6006,
      name: "JobNotProcessing",
      msg: "Job must be in Processing status to complete or fail"
    },
    {
      code: 6007,
      name: "JobNotReady",
      msg: "Job execute_after time has not been reached yet"
    },
    {
      code: 6008,
      name: "Unauthorized",
      msg: "Signer is not authorized for this operation"
    },
    {
      code: 6009,
      name: "CannotCancel",
      msg: "Job is in a terminal state and cannot be cancelled"
    },
    {
      code: 6010,
      name: "QueuePaused",
      msg: "Queue is paused \u2014 no new jobs can be enqueued"
    },
    {
      code: 6011,
      name: "QueueFull",
      msg: "Queue job_count overflow \u2014 this queue has processed u64::MAX jobs"
    },
    {
      code: 6012,
      name: "Overflow",
      msg: "Counter overflow"
    },
    {
      code: 6013,
      name: "IndexFull",
      msg: "Index is full \u2014 maximum number of entries reached"
    },
    {
      code: 6014,
      name: "JobNotInIndex",
      msg: "Job ID was not found in the specified index"
    },
    {
      code: 6015,
      name: "IndexNotFull",
      msg: "grow_index called but the tail page is not yet full"
    },
    {
      code: 6016,
      name: "HeadPageNotEmpty",
      msg: "advance_head called but the head page still contains jobs"
    },
    {
      code: 6017,
      name: "NoSuccessorPage",
      msg: "No successor page exists \u2014 head and tail are the same page"
    },
    {
      code: 6018,
      name: "QueueMismatch",
      msg: "Index page belongs to a different queue than the job"
    },
    {
      code: 6019,
      name: "InvalidCompressedJobData",
      msg: "Failed to deserialize compressed job_data bytes"
    },
    {
      code: 6020,
      name: "CompressedCpiFailed",
      msg: "Light System Program CPI failed \u2014 proof invalid or account mismatch"
    }
  ],
  types: [
    {
      name: "Job",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            docs: [
              "The queue this job belongs to"
            ],
            type: "pubkey"
          },
          {
            name: "job_id",
            docs: [
              "Monotonic ID within the queue (used as PDA seed)"
            ],
            type: "u64"
          },
          {
            name: "job_type",
            docs: [
              "Job type identifier \u2014 workers use this to route to handler functions",
              'e.g. "send-email", "resize-image", "send-webhook"'
            ],
            type: "string"
          },
          {
            name: "payload",
            docs: [
              "Arbitrary serialized payload \u2014 typically JSON or borsh bytes",
              "Workers deserialize this to get job arguments"
            ],
            type: "bytes"
          },
          {
            name: "status",
            docs: [
              "Current lifecycle state"
            ],
            type: {
              defined: {
                name: "JobStatus"
              }
            }
          },
          {
            name: "priority",
            docs: [
              "0=low, 1=normal, 2=high"
            ],
            type: "u8"
          },
          {
            name: "created_at",
            docs: [
              "When this job was enqueued"
            ],
            type: "i64"
          },
          {
            name: "execute_after",
            docs: [
              "Earliest time this job can be claimed (enables delayed/scheduled jobs)"
            ],
            type: "i64"
          },
          {
            name: "attempts",
            docs: [
              "Number of times this job has been attempted (incremented on claim)"
            ],
            type: "u8"
          },
          {
            name: "max_retries",
            docs: [
              "Maximum attempts before permanent failure"
            ],
            type: "u8"
          },
          {
            name: "worker",
            docs: [
              "The worker that currently holds / last processed this job"
            ],
            type: {
              option: "pubkey"
            }
          },
          {
            name: "started_at",
            docs: [
              "When the current/last processing attempt began"
            ],
            type: {
              option: "i64"
            }
          },
          {
            name: "completed_at",
            docs: [
              "When the job reached a terminal state (Completed/Failed/Cancelled)"
            ],
            type: {
              option: "i64"
            }
          },
          {
            name: "result",
            docs: [
              "Result data written by the worker on success"
            ],
            type: {
              option: "string"
            }
          },
          {
            name: "error_message",
            docs: [
              "Error message on failure"
            ],
            type: {
              option: "string"
            }
          },
          {
            name: "bump",
            docs: [
              "PDA bump seed"
            ],
            type: "u8"
          }
        ]
      }
    },
    {
      name: "JobCancelled",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            type: "pubkey"
          },
          {
            name: "job_id",
            type: "u64"
          },
          {
            name: "cancelled_by",
            type: "pubkey"
          },
          {
            name: "cancelled_at",
            type: "i64"
          }
        ]
      }
    },
    {
      name: "JobClaimed",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            type: "pubkey"
          },
          {
            name: "job_id",
            type: "u64"
          },
          {
            name: "worker",
            type: "pubkey"
          },
          {
            name: "attempt",
            type: "u8"
          },
          {
            name: "claimed_at",
            type: "i64"
          }
        ]
      }
    },
    {
      name: "JobCompleted",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            type: "pubkey"
          },
          {
            name: "job_id",
            type: "u64"
          },
          {
            name: "worker",
            type: "pubkey"
          },
          {
            name: "result",
            type: {
              option: "string"
            }
          },
          {
            name: "completed_at",
            type: "i64"
          }
        ]
      }
    },
    {
      name: "JobEnqueued",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            type: "pubkey"
          },
          {
            name: "job_id",
            type: "u64"
          },
          {
            name: "job_type",
            type: "string"
          },
          {
            name: "priority",
            type: "u8"
          },
          {
            name: "execute_after",
            type: "i64"
          },
          {
            name: "enqueued_at",
            type: "i64"
          }
        ]
      }
    },
    {
      name: "JobFailed",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            type: "pubkey"
          },
          {
            name: "job_id",
            type: "u64"
          },
          {
            name: "attempts",
            type: "u8"
          },
          {
            name: "error",
            type: "string"
          },
          {
            name: "failed_at",
            type: "i64"
          }
        ]
      }
    },
    {
      name: "JobIndex",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            docs: [
              "The queue this page belongs to (safety back-reference)"
            ],
            type: "pubkey"
          },
          {
            name: "seq",
            docs: [
              "Sequence number of this page within the linked list.",
              "Also encodes into the PDA seed so every page has a unique address."
            ],
            type: "u64"
          },
          {
            name: "next_seq",
            docs: [
              `Next page's sequence number (0 means "no next page yet").`,
              "Set when the producer creates a successor page via grow_index."
            ],
            type: "u64"
          },
          {
            name: "job_ids",
            docs: [
              "Job IDs stored in this page. Unordered; removal is O(1) swap_remove."
            ],
            type: {
              vec: "u64"
            }
          },
          {
            name: "bump",
            docs: [
              "PDA bump seed"
            ],
            type: "u8"
          }
        ]
      }
    },
    {
      name: "JobRetrying",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            type: "pubkey"
          },
          {
            name: "job_id",
            type: "u64"
          },
          {
            name: "attempt",
            type: "u8"
          },
          {
            name: "retry_at",
            type: "i64"
          },
          {
            name: "error",
            type: "string"
          }
        ]
      }
    },
    {
      name: "JobStatus",
      type: {
        kind: "enum",
        variants: [
          {
            name: "Pending"
          },
          {
            name: "Processing"
          },
          {
            name: "Completed"
          },
          {
            name: "Failed"
          },
          {
            name: "Cancelled"
          }
        ]
      }
    },
    {
      name: "Queue",
      type: {
        kind: "struct",
        fields: [
          {
            name: "authority",
            docs: [
              "The wallet/program that created and controls this queue"
            ],
            type: "pubkey"
          },
          {
            name: "name",
            docs: [
              'Human-readable queue name (e.g. "email-notifications")'
            ],
            type: "string"
          },
          {
            name: "job_count",
            docs: [
              "Monotonically increasing counter \u2014 used as job PDA seed.",
              "Never decrements, so job PDAs are always derivable from (queue, id)."
            ],
            type: "u64"
          },
          {
            name: "pending_count",
            docs: [
              "Live count of Pending + Processing jobs"
            ],
            type: "u64"
          },
          {
            name: "processed_count",
            docs: [
              "Total successfully completed jobs"
            ],
            type: "u64"
          },
          {
            name: "failed_count",
            docs: [
              "Total permanently failed jobs (dead letter count)"
            ],
            type: "u64"
          },
          {
            name: "max_retries",
            docs: [
              "Default max retry attempts for jobs created in this queue"
            ],
            type: "u8"
          },
          {
            name: "paused",
            docs: [
              "When true, new jobs cannot be enqueued"
            ],
            type: "bool"
          },
          {
            name: "created_at",
            docs: [
              "Unix timestamp of queue creation"
            ],
            type: "i64"
          },
          {
            name: "bump",
            docs: [
              "PDA bump seed"
            ],
            type: "u8"
          }
        ]
      }
    },
    {
      name: "QueueCreated",
      type: {
        kind: "struct",
        fields: [
          {
            name: "authority",
            type: "pubkey"
          },
          {
            name: "name",
            type: "string"
          },
          {
            name: "timestamp",
            type: "i64"
          }
        ]
      }
    },
    {
      name: "QueueHead",
      type: {
        kind: "struct",
        fields: [
          {
            name: "authority",
            docs: [
              "The queue this head belongs to (back-reference for safety checks)"
            ],
            type: "pubkey"
          },
          {
            name: "head_index_seq",
            docs: [
              "Sequence number of the oldest (head) JobIndex page.",
              "Workers always read this page first."
            ],
            type: "u64"
          },
          {
            name: "tail_index_seq",
            docs: [
              "Sequence number of the newest (tail) JobIndex page.",
              "Producers append to this page; when it fills, a new page is allocated."
            ],
            type: "u64"
          },
          {
            name: "total_jobs",
            docs: [
              "Total number of job IDs tracked across ALL pages in this linked list.",
              "Does not decrement when jobs are removed; use it for analytics only."
            ],
            type: "u64"
          },
          {
            name: "bump",
            docs: [
              "PDA bump seed"
            ],
            type: "u8"
          }
        ]
      }
    },
    {
      name: "QueuePauseChanged",
      type: {
        kind: "struct",
        fields: [
          {
            name: "queue",
            type: "pubkey"
          },
          {
            name: "paused",
            type: "bool"
          },
          {
            name: "changed_by",
            type: "pubkey"
          }
        ]
      }
    }
  ]
};

// client/index.ts
var LIGHT_RPC_ENDPOINT = {
  devnet: "https://zk-testnet.helius.dev:8899",
  "mainnet-beta": "https://mainnet.helius-rpc.com",
  localnet: "http://localhost:8899"
  // local validator with light-system-program
};
function lightRpcForCluster(cluster) {
  return LIGHT_RPC_ENDPOINT[cluster] ?? LIGHT_RPC_ENDPOINT.devnet;
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
  } else {
    keypairData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  }
  return import_web32.Keypair.fromSecretKey(Uint8Array.from(keypairData));
}
function loadWalletFromFile(walletPath = defaultWalletPath()) {
  return new anchor.Wallet(loadKeypairFromFile(walletPath));
}
var DecQueueClient = class _DecQueueClient {
  constructor(program, provider) {
    this.program = program;
    this.provider = provider;
  }
  static async connect(wallet, cluster = "localnet") {
    const connection = new import_web32.Connection(endpointForCluster(cluster), "confirmed");
    const provider = new import_anchor2.AnchorProvider(connection, wallet, {
      commitment: "confirmed"
    });
    anchor.setProvider(provider);
    const program = new import_anchor2.Program(dec_queue_default, provider);
    return new _DecQueueClient(program, provider);
  }
  deriveQueuePda(authority, queueName) {
    return deriveQueuePda(this.program.programId, authority, queueName);
  }
  deriveJobPda(queuePubkey, jobId) {
    return deriveJobPda(this.program.programId, queuePubkey, jobId);
  }
  deriveIndexPda(queuePubkey, indexType) {
    return deriveIndexPda(this.program.programId, queuePubkey, indexType);
  }
  async createQueue(name, options = {}) {
    const { maxRetries = 3 } = options;
    const authority = this.provider.wallet.publicKey;
    const [queuePda] = this.deriveQueuePda(authority, name);
    const signature = await this.program.methods.initializeQueue(name, maxRetries).accounts({
      queue: queuePda,
      authority,
      systemProgram: import_web32.SystemProgram.programId
    }).rpc();
    return { queuePda, signature };
  }
  async initializeIndexes(queuePda) {
    const authority = this.provider.wallet.publicKey;
    const [pendingIndex] = this.deriveIndexPda(queuePda, "pending");
    const [processingIndex] = this.deriveIndexPda(queuePda, "processing");
    const [delayedIndex] = this.deriveIndexPda(queuePda, "delayed");
    const [failedIndex] = this.deriveIndexPda(queuePda, "failed");
    const [completedIndex] = this.deriveIndexPda(queuePda, "completed");
    const [cancelledIndex] = this.deriveIndexPda(queuePda, "cancelled");
    return this.program.methods.initializeIndexes().accounts({
      queue: queuePda,
      pendingIndex,
      processingIndex,
      delayedIndex,
      failedIndex,
      completedIndex,
      cancelledIndex,
      authority,
      systemProgram: import_web32.SystemProgram.programId
    }).rpc();
  }
  async getIndexJobIds(queuePda, indexType) {
    const [indexPda] = this.deriveIndexPda(queuePda, indexType);
    try {
      const data = await this.program.account.jobIndex.fetch(indexPda);
      return data.jobIds.map((id) => typeof id === "number" ? id : id.toNumber());
    } catch {
      return [];
    }
  }
  async getReadyJobIds(queuePda) {
    const [pendingIds, delayedIds] = await Promise.all([
      this.getIndexJobIds(queuePda, "pending"),
      this.getIndexJobIds(queuePda, "delayed")
    ]);
    return [...pendingIds, ...delayedIds];
  }
  async getQueueStats(queuePda) {
    const data = await this.program.account.queue.fetch(queuePda);
    return {
      name: data.name,
      authority: data.authority.toBase58(),
      totalJobs: data.jobCount.toNumber(),
      pendingJobs: data.pendingCount.toNumber(),
      completedJobs: data.processedCount.toNumber(),
      failedJobs: data.failedCount.toNumber(),
      paused: data.paused,
      createdAt: new Date(data.createdAt.toNumber() * 1e3)
    };
  }
  async addJob(queuePda, jobType, data, options = {}) {
    const result = await enqueueJobWithProgram({
      program: this.program,
      payer: this.provider.wallet.publicKey,
      queuePda,
      jobType,
      payload: data,
      options
    });
    return {
      jobPda: result.jobPda,
      jobId: result.jobId,
      signature: result.signature
    };
  }
  async getJob(jobPda) {
    const data = await this.program.account.job.fetch(jobPda);
    const statusKey = Object.keys(data.status)[0];
    return {
      publicKey: jobPda,
      jobId: data.jobId.toNumber(),
      jobType: data.jobType,
      payload: JSON.parse(Buffer.from(data.payload).toString()),
      status: statusKey,
      priority: data.priority,
      createdAt: new Date(data.createdAt.toNumber() * 1e3),
      executeAfter: new Date(data.executeAfter.toNumber() * 1e3),
      attempts: data.attempts,
      maxRetries: data.maxRetries,
      worker: data.worker?.toBase58(),
      startedAt: data.startedAt ? new Date(data.startedAt.toNumber() * 1e3) : void 0,
      completedAt: data.completedAt ? new Date(data.completedAt.toNumber() * 1e3) : void 0,
      result: data.result ?? void 0,
      errorMessage: data.errorMessage ?? void 0
    };
  }
  async getAllJobs(queuePda) {
    const queueData = await this.program.account.queue.fetch(queuePda);
    const totalJobs = queueData.jobCount.toNumber();
    const jobs = [];
    for (let id = 0; id < totalJobs; id += 1) {
      const [jobPda] = this.deriveJobPda(queuePda, id);
      try {
        jobs.push(await this.getJob(jobPda));
      } catch {
      }
    }
    return jobs;
  }
  // ── claimJob ─────────────────────────────────────────────────────────────
  // Standard path: mutates the on-chain Job PDA directly.
  // Compressed path: fetches a ValidityProof from the Light indexer and sends
  //   a claimCompressedJob instruction that atomically:
  //     1. Verifies proof (proves job is in PENDING state in Merkle tree)
  //     2. Removes job_id from source_index_page
  //     3. Updates compressed job hash to PROCESSING state
  async claimJob(jobPda, queuePda, workerKeypair, options = {}) {
    const { useCompressed = false, cluster = "devnet", indexPageSeq = 0 } = options;
    if (useCompressed) {
      return this._claimCompressed(jobPda, queuePda, workerKeypair, cluster, indexPageSeq);
    }
    const [sourceIndexPage] = this._deriveIndexPagePda(queuePda, indexPageSeq);
    return this.program.methods.claimJob().accounts({
      job: jobPda,
      worker: workerKeypair.publicKey,
      sourceIndexPage
    }).signers([workerKeypair]).rpc();
  }
  async _claimCompressed(jobPda, queuePda, workerKeypair, cluster, indexPageSeq) {
    const lightRpc = (0, import_stateless.createRpc)(lightRpcForCluster(cluster));
    const { proof, meta, jobDataBytes } = await this._fetchProofAndMeta(lightRpc, jobPda);
    const [sourceIndexPage] = this._deriveIndexPagePda(queuePda, indexPageSeq);
    return this.program.methods.claimCompressedJob(proof, meta, Array.from(jobDataBytes)).accounts({
      worker: workerKeypair.publicKey,
      payer: workerKeypair.publicKey,
      sourceIndexPage
    }).remainingAccounts(await this._buildLightRemainingAccounts(lightRpc, meta)).signers([workerKeypair]).rpc();
  }
  // ── completeJob ────────────────────────────────────────────────────────────
  async completeJob(queuePda, jobPda, workerKeypair, result, options = {}) {
    const { useCompressed = false, cluster = "devnet" } = options;
    if (useCompressed) {
      return this._completeCompressed(queuePda, jobPda, workerKeypair, result, cluster);
    }
    return this.program.methods.completeJob(result ?? null).accounts({
      queue: queuePda,
      job: jobPda,
      worker: workerKeypair.publicKey
    }).signers([workerKeypair]).rpc();
  }
  async _completeCompressed(queuePda, jobPda, workerKeypair, result, cluster) {
    const lightRpc = (0, import_stateless.createRpc)(lightRpcForCluster(cluster));
    const { proof, meta, jobDataBytes } = await this._fetchProofAndMeta(lightRpc, jobPda);
    return this.program.methods.completeCompressedJob(proof, meta, Array.from(jobDataBytes), result ?? null).accounts({
      queue: queuePda,
      worker: workerKeypair.publicKey,
      payer: workerKeypair.publicKey
    }).remainingAccounts(await this._buildLightRemainingAccounts(lightRpc, meta)).signers([workerKeypair]).rpc();
  }
  // ── failJob ────────────────────────────────────────────────────────────────
  async failJob(queuePda, jobPda, workerKeypair, errorMessage, retryAfterSecs = 30, options = {}) {
    const { useCompressed = false, cluster = "devnet", retryIndexPageSeq = 0 } = options;
    if (useCompressed) {
      return this._failCompressed(
        queuePda,
        jobPda,
        workerKeypair,
        errorMessage,
        retryAfterSecs,
        cluster,
        retryIndexPageSeq
      );
    }
    const [retryIndexPage] = this._deriveIndexPagePda(queuePda, retryIndexPageSeq);
    return this.program.methods.failJob(errorMessage, new import_anchor2.BN(retryAfterSecs)).accounts({
      queue: queuePda,
      job: jobPda,
      worker: workerKeypair.publicKey,
      retryIndexPage
    }).signers([workerKeypair]).rpc();
  }
  async _failCompressed(queuePda, jobPda, workerKeypair, errorMessage, retryAfterSecs, cluster, retryIndexPageSeq) {
    const lightRpc = (0, import_stateless.createRpc)(lightRpcForCluster(cluster));
    const { proof, meta, jobDataBytes } = await this._fetchProofAndMeta(lightRpc, jobPda);
    const [retryIndexPage] = this._deriveIndexPagePda(queuePda, retryIndexPageSeq);
    return this.program.methods.failCompressedJob(proof, meta, Array.from(jobDataBytes), errorMessage, new import_anchor2.BN(retryAfterSecs)).accounts({
      queue: queuePda,
      worker: workerKeypair.publicKey,
      payer: workerKeypair.publicKey,
      retryIndexPage
    }).remainingAccounts(await this._buildLightRemainingAccounts(lightRpc, meta)).signers([workerKeypair]).rpc();
  }
  // ─────────────────────────────────────────────────────────────────────────
  // Private Light Protocol helpers
  // ─────────────────────────────────────────────────────────────────────────
  // Derive a JobIndex page PDA by sequence number.
  // Seeds: ["index", queuePubkey, seq.to_le_bytes()]
  _deriveIndexPagePda(queuePda, seq) {
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(BigInt(seq));
    return import_web32.PublicKey.findProgramAddressSync(
      [Buffer.from("index"), queuePda.toBuffer(), seqBuf],
      this.program.programId
    );
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
  async _fetchProofAndMeta(lightRpc, jobPda) {
    const compressedAccount = await lightRpc.getCompressedAccount(
      void 0,
      jobPda
      // address — same deterministic key used during enqueue
    );
    if (!compressedAccount) {
      throw new Error(
        `Compressed job account not found for address ${jobPda.toBase58()}. Ensure the job was created with enqueue_compressed_job, not the standard enqueue_job.`
      );
    }
    const jobDataBytes = compressedAccount.data?.data ? Buffer.from(compressedAccount.data.data) : Buffer.alloc(0);
    const proofResult = await lightRpc.getValidityProof(
      [{ hash: compressedAccount.hash, tree: compressedAccount.tree }],
      []
      // no new addresses needed for updates
    );
    const meta = {
      hash: compressedAccount.hash,
      address: compressedAccount.address,
      treeInfo: proofResult.treeInfo,
      outputStateMerkleTreeIndex: proofResult.treeInfo?.treeIndex ?? 0
    };
    return { proof: proofResult.proof, meta, jobDataBytes };
  }
  // Build the remaining_accounts list required by the Light System Program.
  // These accounts are the State Merkle Tree + Nullifier Queue on-chain PDAs.
  // Their indices are packed into the instruction data by PackedAccounts.
  async _buildLightRemainingAccounts(lightRpc, meta) {
    const LIGHT_STATE_TREE_DEVNET = new import_web32.PublicKey(
      "smt1NamzXdq4AMqS2fS2F1i5KTYPZRhoHgWx38d8WsT"
    );
    const LIGHT_NULLIFIER_QUEUE_DEVNET = new import_web32.PublicKey(
      "nfq1NvQDJ2GEgnS8zt9prAe8rjjpAW1zFkrvZoBR148"
    );
    const LIGHT_SYSTEM_PROGRAM = new import_web32.PublicKey(
      "H5sFv8VwWmjxHYS2GB4fTDsK7uTtnRT4WiixtHrET3bN"
    );
    return [
      { pubkey: LIGHT_SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: LIGHT_STATE_TREE_DEVNET, isSigner: false, isWritable: true },
      { pubkey: LIGHT_NULLIFIER_QUEUE_DEVNET, isSigner: false, isWritable: true }
    ];
  }
  async setQueuePaused(queuePda, paused) {
    return this.program.methods.setQueuePaused(paused).accounts({ queue: queuePda, authority: this.provider.wallet.publicKey }).rpc();
  }
  onJobCompleted(callback) {
    return this.program.addEventListener("jobCompleted", (event) => {
      callback({ jobId: event.jobId.toNumber(), result: event.result ?? void 0 });
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
};
async function main() {
  const walletPath = process.env.WALLET_PATH ?? defaultWalletPath();
  const cluster = process.env.DECQUEUE_CLUSTER ?? "localnet";
  const queueName = process.env.DECQUEUE_QUEUE_NAME ?? `email-${Date.now().toString(36)}`;
  const payer = loadKeypairFromFile(walletPath);
  const wallet = new anchor.Wallet(payer);
  console.log(`Connecting to ${cluster}...`);
  const client = await DecQueueClient.connect(wallet, cluster);
  console.log(`   Wallet: ${payer.publicKey.toBase58()}
`);
  console.log(`Creating queue: ${queueName}`);
  const { queuePda, signature: createSig } = await client.createQueue(queueName, {
    maxRetries: 3
  });
  console.log(`   Queue PDA: ${queuePda.toBase58()}`);
  console.log(`   Tx: ${formatTxLocation(createSig, cluster)}`);
  console.log(`Initializing indexes...`);
  const indexSig = await client.initializeIndexes(queuePda);
  console.log(`   Tx: ${formatTxLocation(indexSig, cluster)}
`);
  console.log("Enqueuing jobs...");
  const jobs = [
    { type: "send-email", data: { to: "alice@example.com", subject: "Welcome" }, priority: 2 },
    { type: "send-email", data: { to: "bob@example.com", subject: "Invoice" }, priority: 1 },
    {
      type: "webhook-call",
      data: { url: "https://api.example.com/hook", event: "signup" },
      priority: 1
    },
    { type: "daily-report", data: { reportId: "Q1-2025" }, priority: 0, delay: 6e4 }
  ];
  for (const jobDef of jobs) {
    const { jobPda, jobId, signature } = await client.addJob(queuePda, jobDef.type, jobDef.data, {
      priority: jobDef.priority,
      delay: jobDef.delay
    });
    console.log(`   Job #${jobId} (${jobDef.type}) -> ${jobPda.toBase58().slice(0, 20)}...`);
    console.log(`   Tx: ${formatTxLocation(signature, cluster)}`);
  }
  console.log("\nQueue Stats:");
  const stats = await client.getQueueStats(queuePda);
  console.log(`   Pending:   ${stats.pendingJobs}`);
  console.log(`   Total:     ${stats.totalJobs}`);
  console.log(`   Completed: ${stats.completedJobs}`);
  console.log(`   Failed:    ${stats.failedJobs}`);
  console.log(`   Paused:    ${stats.paused}`);
  console.log("\nAll Jobs:");
  const allJobs = await client.getAllJobs(queuePda);
  for (const job of allJobs) {
    const since = Math.round((Date.now() - job.createdAt.getTime()) / 1e3);
    console.log(`   #${job.jobId} [${job.status.padEnd(10)}] ${job.jobType.padEnd(15)} ${since}s ago`);
  }
  if (cluster === "localnet") {
    console.log("\nDone. Queue address:");
  } else {
    console.log("\nDone. Queue location:");
  }
  console.log(`   ${formatAddressLocation(queuePda.toBase58(), cluster)}`);
}
if (require.main === module) {
  main().catch(console.error);
}

// client/fee-strategy.ts
var import_web33 = require("@solana/web3.js");
var JITO_TIP_ACCOUNTS = [
  new import_web33.PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
  new import_web33.PublicKey("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
  new import_web33.PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
  new import_web33.PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13mb5xPJ"),
  new import_web33.PublicKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
  new import_web33.PublicKey("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
  new import_web33.PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
  new import_web33.PublicKey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT")
];
function randomJitoTipAccount() {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}
function defaultHybridFeeConfig(overrides = {}) {
  return {
    mode: "auto",
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL ?? "https://ny.mainnet.block-engine.jito.wtf",
    jitoTipLamports: Number(process.env.JITO_TIP_LAMPORTS ?? 25e3),
    skipJitoTipOnLowPriorityRetry: true,
    computeUnitLimit: 8e4,
    priorityFeePercentile: 75,
    minPriorityFeeMicroLamports: 1e3,
    // 1 micro-lamport/CU floor
    maxPriorityFeeMicroLamports: 5e6,
    // 5 lamports/CU hard cap
    retry: {
      maxAttempts: 4,
      baseDelayMs: 800,
      jitterFactor: 0.2,
      backoffMultiplier: 2
    },
    ...overrides
  };
}
async function getDynamicPriorityFee(connection, writableAccounts, config) {
  let fees = [];
  try {
    const recentFees = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: writableAccounts
    });
    fees = recentFees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
  } catch (err) {
    console.warn(`[FeeStrategy] getRecentPrioritizationFees failed: ${err.message}`);
  }
  if (fees.length === 0) {
    return config.minPriorityFeeMicroLamports;
  }
  const idx = Math.floor(config.priorityFeePercentile / 100 * (fees.length - 1));
  const percentileFee = fees[idx];
  return Math.max(
    config.minPriorityFeeMicroLamports,
    Math.min(config.maxPriorityFeeMicroLamports, percentileFee)
  );
}
function buildComputeBudgetInstructions(computeUnitLimit, microLamportsPerCu) {
  return [
    import_web33.ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    import_web33.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu })
  ];
}
async function sendWithJito(connection, payer, instructions, tipLamports, blockEngineUrl) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tipIx = import_web33.SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: randomJitoTipAccount(),
    lamports: tipLamports
  });
  const tipTx = new import_web33.Transaction().add(tipIx);
  tipTx.recentBlockhash = blockhash;
  tipTx.feePayer = payer.publicKey;
  tipTx.sign(payer);
  const programTx = new import_web33.Transaction().add(...instructions);
  programTx.recentBlockhash = blockhash;
  programTx.feePayer = payer.publicKey;
  programTx.sign(payer);
  const encodedTipTx = tipTx.serialize().toString("base64");
  const encodedProgramTx = programTx.serialize().toString("base64");
  const response = await fetch(`${blockEngineUrl}/api/v1/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [
        [encodedTipTx, encodedProgramTx],
        // tip MUST be tx[0]
        { encoding: "base64" }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(
      `Jito sendBundle HTTP ${response.status}: ${await response.text()}`
    );
  }
  const body = await response.json();
  if (body.error) {
    throw new Error(`Jito sendBundle RPC error: ${body.error.message}`);
  }
  const bundleId = body.result;
  await confirmJitoBundle(blockEngineUrl, bundleId, lastValidBlockHeight);
  return programTx.signatures[0]?.signature?.toString("base64") ?? bundleId;
}
async function confirmJitoBundle(blockEngineUrl, bundleId, lastValidBlockHeight, pollIntervalMs = 1500, maxPollMs = 3e4) {
  const deadline = Date.now() + maxPollMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const resp = await fetch(`${blockEngineUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]]
      })
    });
    if (!resp.ok) continue;
    const body = await resp.json();
    const status = body.result?.value?.[0];
    if (!status) continue;
    if (status.err) {
      throw new Error(`Jito bundle failed on-chain: ${JSON.stringify(status.err)}`);
    }
    const confirmed = status.confirmation_status === "confirmed" || status.confirmation_status === "finalized";
    if (confirmed) return;
  }
  throw new Error(
    `Jito bundle ${bundleId} not confirmed within ${maxPollMs}ms \u2014 it may have been dropped (no Jito leader in window). Will retry with standard.`
  );
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoffDelayMs(attempt, config) {
  const base = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const jitter = base * config.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
var HybridFeeStrategy = class {
  constructor(connection, payer, config) {
    this.connection = connection;
    this.payer = payer;
    this.config = config;
  }
  /**
   * Send a set of instructions with automatic fee calculation and retry.
   *
   * @param instructions  The program instructions to send (WITHOUT ComputeBudget
   *                      prefixes — this method adds them).
   * @param writableAccounts  Accounts that will be write-locked by the tx.
   *                          Used for targeted fee estimation.
   * @param jobPriority   0, 1, or 2. Controls whether Jito tips are skipped
   *                      on retries for non-high-priority jobs.
   */
  async send(instructions, writableAccounts, jobPriority = 1) {
    const { retry, mode, skipJitoTipOnLowPriorityRetry } = this.config;
    let lastError = null;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      const microLamportsPerCu = await getDynamicPriorityFee(
        this.connection,
        writableAccounts,
        this.config
      );
      const isHighPriority = jobPriority >= 2;
      const isJitoAttempt = mode === "jito" || mode === "auto" && attempt === 1;
      const skipJitoForPriority = skipJitoTipOnLowPriorityRetry && !isHighPriority && attempt > 1;
      const useJito = isJitoAttempt && !skipJitoForPriority;
      const modeUsed = useJito ? "jito" : "standard";
      const budgetIxs = buildComputeBudgetInstructions(
        this.config.computeUnitLimit,
        microLamportsPerCu
      );
      const fullInstructions = [...budgetIxs, ...instructions];
      try {
        let signature;
        if (useJito) {
          console.log(
            `[FeeStrategy] Attempt ${attempt}/${retry.maxAttempts} \u2014 Jito bundle | tip=${this.config.jitoTipLamports}L | fee=${microLamportsPerCu}\xB5L/CU`
          );
          signature = await sendWithJito(
            this.connection,
            this.payer,
            fullInstructions,
            this.config.jitoTipLamports,
            this.config.jitoBlockEngineUrl
          );
        } else {
          console.log(
            `[FeeStrategy] Attempt ${attempt}/${retry.maxAttempts} \u2014 Standard | fee=${microLamportsPerCu}\xB5L/CU | priority=${jobPriority}`
          );
          const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
          const tx = new import_web33.Transaction().add(...fullInstructions);
          tx.recentBlockhash = blockhash;
          tx.feePayer = this.payer.publicKey;
          signature = await (0, import_web33.sendAndConfirmTransaction)(
            this.connection,
            tx,
            [this.payer],
            { commitment: "confirmed", skipPreflight: false }
          );
        }
        console.log(
          `[FeeStrategy] \u2713 Confirmed on attempt ${attempt} | sig=${signature.slice(0, 16)}... | mode=${modeUsed} | fee=${microLamportsPerCu}\xB5L/CU | jitoTip=${useJito}`
        );
        return {
          signature,
          attempt,
          modeUsed,
          priorityFeeMicroLamports: microLamportsPerCu,
          jitoTipPaid: useJito
        };
      } catch (err) {
        lastError = err;
        const delay = backoffDelayMs(attempt, retry);
        console.warn(
          `[FeeStrategy] \u2717 Attempt ${attempt} failed (${lastError.message.slice(0, 80)}). ` + (attempt < retry.maxAttempts ? `Retrying in ${delay}ms...` : "All attempts exhausted.")
        );
        if (attempt < retry.maxAttempts) {
          await sleep(delay);
        }
      }
    }
    throw new Error(
      `All ${retry.maxAttempts} send attempts failed. Last error: ${lastError?.message}`
    );
  }
};

// client/worker.ts
var VALID_CLUSTERS = /* @__PURE__ */ new Set(["localnet", "devnet", "mainnet-beta"]);
function parseCluster(value) {
  if (!value) return null;
  return VALID_CLUSTERS.has(value) ? value : null;
}
function parseArgs() {
  const args = process.argv.slice(2);
  const positional = [];
  let cluster = parseCluster(process.env.DECQUEUE_CLUSTER) ?? "localnet";
  for (const arg of args) {
    const parsedCluster = parseCluster(arg);
    if (parsedCluster) {
      cluster = parsedCluster;
      continue;
    }
    positional.push(arg);
  }
  return { cluster, queueArg: positional[0] ?? process.env.DECQUEUE_QUEUE };
}
function buildFeeConfig() {
  const modeEnv = process.env.DECQUEUE_FEE_MODE;
  const validModes = ["standard", "jito", "auto"];
  const mode = validModes.includes(modeEnv) ? modeEnv : "auto";
  return defaultHybridFeeConfig({
    mode,
    priorityFeePercentile: Number(process.env.DECQUEUE_PRIORITY_FEE_PERCENTILE ?? 75),
    retry: {
      maxAttempts: Number(process.env.DECQUEUE_MAX_SEND_ATTEMPTS ?? 4),
      baseDelayMs: 800,
      jitterFactor: 0.2,
      backoffMultiplier: 2
    }
  });
}
function jobSummary(job) {
  const priorityLabel = ["low", "normal", "high"][job.priority] ?? job.priority;
  return `#${job.jobId} ${job.jobType} [${job.status}] (${priorityLabel})`;
}
function compactJson(value) {
  return JSON.stringify(value).slice(0, 120);
}
function renderResult(job) {
  const payload = job.payload;
  switch (job.jobType) {
    case "send-email":
      return compactJson({ ok: true, to: payload.to ?? "unknown", ref: `msg_${job.jobId.toString(36)}` });
    case "webhook-call":
      return compactJson({ ok: true, target: payload.url ?? "unknown", code: 202 });
    case "image-resize":
      return compactJson({ ok: true, asset: payload.imageId ?? `img_${job.jobId}`, variant: "thumbnail" });
    case "daily-report":
      return compactJson({ ok: true, report: payload.reportId ?? `report_${job.jobId}` });
    case "audit-log":
      return compactJson({ ok: true, entry: `audit_${job.jobId}` });
    default:
      return compactJson({ ok: true, handledBy: "decqueue-worker", type: job.jobType });
  }
}
async function executeJob(job) {
  const payload = job.payload;
  if (payload.fail === true || payload.shouldFail === true || payload.simulateFailure === true) {
    throw new Error("Job payload requested a simulated failure");
  }
  if (typeof payload.throwMessage === "string" && payload.throwMessage.trim().length > 0) {
    throw new Error(payload.throwMessage.trim());
  }
  return renderResult(job);
}
function sortReadyJobs(jobs) {
  return jobs.filter((job) => job.status === "pending" && job.executeAfter.getTime() <= Date.now()).sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.executeAfter.getTime() !== b.executeAfter.getTime())
      return a.executeAfter.getTime() - b.executeAfter.getTime();
    return a.jobId - b.jobId;
  });
}
async function fetchJobsByIds(client, queuePda, jobIds) {
  const jobs = [];
  for (const id of jobIds) {
    const [jobPda] = client.deriveJobPda(queuePda, id);
    try {
      jobs.push(await client.getJob(jobPda));
    } catch {
    }
  }
  return jobs;
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function claimWithStrategy(client, strategy, job, queuePda, worker, cluster, indexPageSeq, useCompressed) {
  const jobPriority = job.priority;
  const [sourceIndexPage] = client._deriveIndexPagePda(queuePda, indexPageSeq);
  const writableAccounts = [job.publicKey, sourceIndexPage];
  let claimIxs;
  if (useCompressed) {
    return strategy.send(
      [],
      // empty — we delegate the actual send to the client method below
      writableAccounts,
      jobPriority
    ).then(
      () => client.claimJob(job.publicKey, queuePda, worker, { useCompressed, cluster, indexPageSeq })
    );
  }
  claimIxs = [
    await client.program.methods.claimJob().accounts({
      job: job.publicKey,
      worker: worker.publicKey,
      sourceIndexPage
    }).instruction()
  ];
  return strategy.send(claimIxs, writableAccounts, jobPriority).then((result) => result.signature);
}
async function completeWithStrategy(client, strategy, job, queuePda, worker, result, cluster, useCompressed) {
  const jobPriority = job.priority;
  const writableAccounts = [job.publicKey, queuePda];
  if (useCompressed) {
    return client.completeJob(queuePda, job.publicKey, worker, result, { useCompressed, cluster });
  }
  const completeIx = await client.program.methods.completeJob(result).accounts({ queue: queuePda, job: job.publicKey, worker: worker.publicKey }).instruction();
  return strategy.send([completeIx], writableAccounts, jobPriority).then((r) => r.signature);
}
async function failWithStrategy(client, strategy, job, queuePda, worker, errorMessage, retryAfterSecs, cluster, indexPageSeq, useCompressed) {
  const jobPriority = job.priority;
  const [retryIndexPage] = client._deriveIndexPagePda(queuePda, indexPageSeq);
  const writableAccounts = [job.publicKey, queuePda, retryIndexPage];
  if (useCompressed) {
    return client.failJob(queuePda, job.publicKey, worker, errorMessage, retryAfterSecs, {
      useCompressed,
      cluster,
      retryIndexPageSeq: indexPageSeq
    });
  }
  const failIx = await client.program.methods.failJob(errorMessage.slice(0, 128), new (await import("@coral-xyz/anchor")).BN(retryAfterSecs)).accounts({ queue: queuePda, job: job.publicKey, worker: worker.publicKey, retryIndexPage }).instruction();
  return strategy.send([failIx], writableAccounts, jobPriority).then((r) => r.signature);
}
async function processReadyJobs(client, queuePda, worker, cluster, strategy) {
  const useCompressed = process.env.DECQUEUE_COMPRESSED === "1";
  const readyIds = await client.getReadyJobIds(queuePda);
  if (readyIds.length === 0) return 0;
  const candidateJobs = await fetchJobsByIds(client, queuePda, readyIds);
  const jobs = sortReadyJobs(candidateJobs);
  let processed = 0;
  for (const job of jobs) {
    const indexPageSeq = 0;
    let claimSig;
    try {
      claimSig = await claimWithStrategy(
        client,
        strategy,
        job,
        queuePda,
        worker,
        cluster,
        indexPageSeq,
        useCompressed
      );
      console.log(`\u2713 Claimed  ${jobSummary(job)} \u2192 ${formatTxLocation(claimSig, cluster)}`);
    } catch (err) {
      console.warn(`\u2717 Skipped  ${jobSummary(job)} \u2014 claim failed: ${err.message}`);
      continue;
    }
    let jobResult;
    let jobFailed = false;
    let failMessage = "";
    try {
      jobResult = await executeJob(job);
    } catch (err) {
      jobFailed = true;
      failMessage = err.message.slice(0, 128);
      jobResult = "";
    }
    if (!jobFailed) {
      try {
        const completeSig = await completeWithStrategy(
          client,
          strategy,
          job,
          queuePda,
          worker,
          jobResult,
          cluster,
          useCompressed
        );
        console.log(`\u2713 Complete ${jobSummary(job)} \u2192 ${formatTxLocation(completeSig, cluster)}`);
        processed += 1;
      } catch (err) {
        console.error(`\u2717 complete_job tx failed after retries: ${err.message}`);
      }
    } else {
      try {
        const retryAfterSecs = Number(process.env.DECQUEUE_RETRY_AFTER_SECS ?? 30);
        const failSig = await failWithStrategy(
          client,
          strategy,
          job,
          queuePda,
          worker,
          failMessage,
          retryAfterSecs,
          cluster,
          indexPageSeq,
          useCompressed
        );
        console.log(`\u2717 Failed   ${jobSummary(job)} \u2192 ${formatTxLocation(failSig, cluster)} (${failMessage})`);
        processed += 1;
      } catch (err) {
        console.error(`\u2717 fail_job tx failed after retries: ${err.message}`);
      }
    }
  }
  return processed;
}
async function main2() {
  const { cluster, queueArg } = parseArgs();
  if (!queueArg) {
    throw new Error(
      "Provide a queue PDA via `npm run worker -- <cluster> <queue-pda>` or DECQUEUE_QUEUE."
    );
  }
  const walletPath = process.env.WALLET_PATH ?? defaultWalletPath();
  const pollMs = Number(process.env.DECQUEUE_POLL_MS ?? 5e3);
  const once = process.env.DECQUEUE_WORKER_ONCE === "1";
  const queuePda = new import_web34.PublicKey(queueArg);
  const wallet = loadWalletFromFile(walletPath);
  const workerKeypair = loadKeypairFromFile(walletPath);
  const client = await DecQueueClient.connect(wallet, cluster);
  const feeConfig = buildFeeConfig();
  const strategy = new HybridFeeStrategy(
    client.provider.connection,
    workerKeypair,
    feeConfig
  );
  const stats = await client.getQueueStats(queuePda);
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557`);
  console.log(`\u2551          DecQueue Worker (HybridFeeStrategy)         \u2551`);
  console.log(`\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563`);
  console.log(`\u2551  Cluster:    ${cluster.padEnd(38)}\u2551`);
  console.log(`\u2551  Queue:      ${stats.name.slice(0, 38).padEnd(38)}\u2551`);
  console.log(`\u2551  PDA:        ${queuePda.toBase58().slice(0, 38).padEnd(38)}\u2551`);
  console.log(`\u2551  Wallet:     ${wallet.publicKey.toBase58().slice(0, 38).padEnd(38)}\u2551`);
  console.log(`\u2551  Fee mode:   ${feeConfig.mode.padEnd(38)}\u2551`);
  console.log(`\u2551  Fee pcntile:${String(feeConfig.priorityFeePercentile + "th percentile").padEnd(38)}\u2551`);
  console.log(`\u2551  Jito tip:   ${String(feeConfig.jitoTipLamports + " lamports").padEnd(38)}\u2551`);
  console.log(`\u2551  Retries:    ${String(feeConfig.retry.maxAttempts + " attempts (exp backoff)").padEnd(38)}\u2551`);
  console.log(`\u2551  Mode:       ${(once ? "single pass" : `poll every ${pollMs}ms`).padEnd(38)}\u2551`);
  console.log(`\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D
`);
  try {
    const currentFee = await getDynamicPriorityFee(
      client.provider.connection,
      [queuePda],
      feeConfig
    );
    console.log(`[FeeStrategy] Current estimated priority fee: ${currentFee} \xB5L/CU (${feeConfig.priorityFeePercentile}th percentile)`);
  } catch {
    console.log(`[FeeStrategy] Fee pre-flight skipped (RPC doesn't support getRecentPrioritizationFees)`);
  }
  const completedListener = await client.onJobCompleted(({ jobId, result }) => {
    console.log(`Event: job #${jobId} completed${result ? ` \u2192 ${result}` : ""}`);
  });
  const failedListener = await client.onJobFailed(({ jobId, error, attempts }) => {
    console.log(`Event: job #${jobId} failed on attempt ${attempts}: ${error}`);
  });
  try {
    do {
      const processed = await processReadyJobs(client, queuePda, workerKeypair, cluster, strategy);
      if (once) {
        console.log(`
Processed ${processed} ready job(s).`);
        break;
      }
      if (processed === 0) {
        process.stdout.write(".");
      } else {
        console.log(`
Processed ${processed} job(s) this pass.`);
      }
      await sleep2(pollMs);
    } while (true);
  } finally {
    await Promise.all([
      client.removeListener(completedListener),
      client.removeListener(failedListener)
    ]);
  }
}
main2().catch((error) => {
  console.error(error);
  process.exit(1);
});
