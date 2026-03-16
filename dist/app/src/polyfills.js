"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const buffer_1 = require("buffer");
// Anchor/web3 expect Node-style globals in the browser.
if (!globalThis.Buffer) {
    globalThis.Buffer = buffer_1.Buffer;
}
if (!globalThis.global) {
    globalThis.global = globalThis;
}
