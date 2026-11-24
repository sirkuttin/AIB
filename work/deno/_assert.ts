/**
 * The few assertions the Deno tests need, local so tests run offline with no remote std import.
 * assertEquals compares structurally (like std/assert): plain objects by keys, arrays by items.
 */
import './_no_console.ts'; // no console windows for the programs tests start
import { digestOf, FrozenDigest } from './_digest.ts';

export class AssertionError extends Error {}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // a stored fingerprint (_frozen.ts), at any depth, stands for the value it was made from
  if (a instanceof FrozenDigest || b instanceof FrozenDigest) {
    return digestOf(a instanceof FrozenDigest ? b : a) === (a instanceof FrozenDigest ? a : (b as FrozenDigest)).hash ||
      (a instanceof FrozenDigest && b instanceof FrozenDigest && a.hash === b.hash);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => equal(v, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function assertEquals(actual: unknown, expected: unknown, message = ''): void {
  // A stored fingerprint (_frozen.ts) stands for an answer too big to keep: the other side must give the same fingerprint.
  if (expected instanceof FrozenDigest || actual instanceof FrozenDigest) {
    const digest = (expected instanceof FrozenDigest ? expected : actual) as FrozenDigest;
    const other = expected instanceof FrozenDigest ? actual : expected;
    const got = other instanceof FrozenDigest ? other.hash : digestOf(other);
    if (got !== digest.hash) {
      throw new AssertionError(
        `${message ? message + ': ' : ''}\ndiffers from the stored answer (fingerprint ${digest.hash}, got ${got}); value: ${
          JSON.stringify(other)?.slice(0, 600)
        }`,
      );
    }
    return;
  }
  if (!equal(actual, expected)) {
    throw new AssertionError(
      `${message ? message + ': ' : ''}\nactual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
    );
  }
}

export function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export async function assertRejects(fn: () => Promise<unknown>, type?: new (...args: never[]) => Error): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    if (type && !(error instanceof type)) {
      throw new AssertionError(`expected ${type.name}, got ${(error as Error)?.constructor?.name}: ${error}`);
    }
    return error as Error;
  }
  throw new AssertionError('expected a rejection');
}

export function assertThrows(fn: () => unknown, type?: new (...args: never[]) => Error): Error {
  try {
    fn();
  } catch (error) {
    if (type && !(error instanceof type)) {
      throw new AssertionError(`expected ${type.name}, got ${(error as Error)?.constructor?.name}: ${error}`);
    }
    return error as Error;
  }
  throw new AssertionError('expected an exception');
}
