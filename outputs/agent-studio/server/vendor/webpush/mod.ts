// @ts-nocheck -- vendored third-party code written for an older TypeScript (see mod.ts); not type-checked here
// Vendored: jsr:@negrel/webpush@0.5.0 and jsr:@negrel/http-ece@0.7.0 (./ece/), MIT, (c) Alexandre Negrel (LICENSE).
// Copied into AIB so nothing is downloaded at run time (deno.json has no jsr imports). AIB's changes, each marked "AIB:":
//   deps.ts and ece/deps.ts replace jsr:@std/encoding and jsr:@std/bytes with small local functions;
//   subscriber.ts sets the record size to 4096 and takes an AbortSignal and a fetch function;
//   every file starts with @ts-nocheck (written for an older TypeScript).
// AIB makes a new ApplicationServer (a new ECDH key) for every message, as RFC 8291 section 3.1 asks (server/remote/push.ts).
export * from "./vapid.ts";
export * from "./subscriber.ts";
export * from "./application_server.ts";
