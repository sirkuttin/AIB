// @ts-nocheck -- vendored third-party code written for an older TypeScript (see mod.ts); not type-checked here
// AIB: the jsr:@std/encoding and jsr:@std/bytes helpers this library used, as small local functions (no download at run time),
// and the vendored @negrel/http-ece next to it (./ece/).
export { bytes, decodeBase64Url, encodeBase64Url } from "./ece/deps.ts";
export * as ece from "./ece/mod.ts";
