import { Buffer } from "buffer";

// Anchor/web3 expect Node-style globals in the browser.
if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

if (!(globalThis as { global?: typeof globalThis }).global) {
  (globalThis as { global?: typeof globalThis }).global = globalThis;
}
