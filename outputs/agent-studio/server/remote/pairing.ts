/**
 * Pairing a phone. The PC opens a pairing (Add a phone): a one-time 6-byte secret, shown as a QR (the remote address with the secret
 * after '#', so it never reaches a server log) and as six words; it lives 5 minutes and works once. The phone claims it with its name
 * and a random nonce: the first right claim uses the code up; a second claim is refused and the PC shows "Another device tried this
 * code"; three wrong codes kill it. A global limit caps claims from anywhere (all Serve traffic comes from 127.0.0.1, so there is no
 * address to limit by). Both sides show two check words made from the secret and both nonces; the owner clicks Approve on the PC,
 * and only then does the phone get its device token (once, through the claim's own secret).
 */
import { checkWords, hex, parseCode, randomToken, sameBytes, SECRET_BYTES, secretWords, sha256Hex } from './words.ts';
import type { PhoneScope } from './devices.ts';

export const CODE_SECONDS = 5 * 60;
export const MAX_WRONG = 3;
const CLAIM_SECONDS = 10 * 60;
/** Global claim limits: per minute and per hour (code-server's numbers, a little wider for typing mistakes). */
const PER_MINUTE = 6;
const PER_HOUR = 30;

export interface PairingCode {
  secret: Uint8Array;
  words: string[];
  startedAt: number;
  expiresAt: number;
  wrong: number;
  claimed: boolean;
  /** A device tried the code after it was used (the PC says so). */
  anotherTried: boolean;
}

export interface Claim {
  id: string;
  name: string;
  login: string;
  phoneNonce: string;
  pcNonce: string;
  checkWords: [string, string];
  secretHash: string;
  state: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  /** Set on approval and handed to the phone once. */
  handover?: { token: string; cookie: string; device: { id: string; name: string; scopes: PhoneScope[] } };
}

export class PairingError extends Error {
  override name = 'PairingError';
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export class Pairing {
  code: PairingCode | null = null;
  claims = new Map<string, Claim>();
  #attempts: number[] = [];

  constructor(readonly clock: () => number = () => Date.now() / 1000) {}

  /** Open a new pairing (replaces one that is open). */
  start(): PairingCode {
    const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
    const at = this.clock();
    this.code = {
      secret,
      words: secretWords(secret),
      startedAt: at,
      expiresAt: at + CODE_SECONDS,
      wrong: 0,
      claimed: false,
      anotherTried: false,
    };
    return this.code;
  }

  cancel(): void {
    this.code = null;
    for (const [id, c] of this.claims) if (c.state === 'pending') this.claims.delete(id);
  }

  /** The code while it can still be claimed (open, not expired, not used, not killed by wrong tries). */
  open(): PairingCode | null {
    const c = this.code;
    if (!c || this.clock() >= c.expiresAt || c.wrong >= MAX_WRONG) return null;
    return c;
  }

  #limit(): void {
    const at = this.clock();
    this.#attempts = this.#attempts.filter((t) => at - t < 3600);
    const lastMinute = this.#attempts.filter((t) => at - t < 60).length;
    if (lastMinute >= PER_MINUTE || this.#attempts.length >= PER_HOUR) {
      throw new PairingError(429, 'too_many', 'Too many pairing tries. Wait a minute, then try again.');
    }
    this.#attempts.push(at);
  }

  /** A phone claims the code. Returns the claim and the claim secret the phone polls with. */
  claim(input: { code: unknown; name: string; login: string; phoneNonce: unknown }): { claim: Claim; claimSecret: string } {
    this.#limit();
    const c = this.code;
    if (!c || this.clock() >= c.expiresAt) {
      throw new PairingError(410, 'expired', 'This code has expired. On your PC, click Add a phone again.');
    }
    if (c.wrong >= MAX_WRONG) {
      throw new PairingError(410, 'expired', 'This code no longer works after three wrong tries. On your PC, click Add a phone again.');
    }
    const given = parseCode(input.code);
    if (!given || !sameBytes(given, c.secret)) {
      c.wrong++;
      throw new PairingError(
        403,
        'wrong_code',
        c.wrong >= MAX_WRONG
          ? 'Wrong code three times, so it no longer works. On your PC, click Add a phone again.'
          : 'That code is not right. Check the six words on your PC.',
      );
    }
    if (c.claimed) {
      c.anotherTried = true;
      throw new PairingError(409, 'already_used', 'This code was already used by another device. On your PC, click Add a phone again.');
    }
    const phoneNonce = typeof input.phoneNonce === 'string' && /^[0-9a-f]{32,64}$/.test(input.phoneNonce) ? input.phoneNonce : '';
    if (!phoneNonce) throw new PairingError(400, 'bad_request', 'The phone page sent an incomplete request. Reload it and try again.');
    c.claimed = true;
    const pcNonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const claimSecret = randomToken();
    const claim: Claim = {
      id: randomToken(9),
      name: input.name,
      login: input.login,
      phoneNonce,
      pcNonce,
      checkWords: checkWords(c.secret, phoneNonce, pcNonce),
      secretHash: sha256Hex(claimSecret),
      state: 'pending',
      createdAt: this.clock(),
    };
    this.claims.set(claim.id, claim);
    return { claim, claimSecret };
  }

  #prune(): void {
    for (const [id, c] of this.claims) if (this.clock() - c.createdAt > CLAIM_SECONDS) this.claims.delete(id);
  }

  pending(): Claim[] {
    this.#prune();
    return [...this.claims.values()].filter((c) => c.state === 'pending');
  }

  get(id: unknown): Claim | null {
    this.#prune();
    return typeof id === 'string' ? this.claims.get(id) ?? null : null;
  }

  /** The phone asks how its claim went. An approved claim hands over the device token once, then is gone. */
  status(id: unknown, claimSecret: unknown): Claim | null {
    const c = this.get(id);
    if (!c || typeof claimSecret !== 'string' || sha256Hex(claimSecret) !== c.secretHash) return null;
    if (c.state !== 'pending') this.claims.delete(c.id);
    return c;
  }

  approve(id: unknown, handover: NonNullable<Claim['handover']>): Claim {
    const c = this.get(id);
    if (!c || c.state !== 'pending') {
      throw new PairingError(404, 'no_claim', 'That phone is no longer waiting. Ask it to scan the code again.');
    }
    c.state = 'approved';
    c.handover = handover;
    this.code = null; // used: the PC stops showing it
    return c;
  }

  reject(id: unknown): Claim | null {
    const c = this.get(id);
    if (!c || c.state !== 'pending') return null;
    c.state = 'rejected';
    this.code = null;
    return c;
  }
}
