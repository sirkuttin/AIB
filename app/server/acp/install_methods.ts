/**
 * Puts the methods of a class that live in their own modules onto its prototype, the way a class body would have: writable,
 * configurable, not enumerable. Used by Connection (acp/connection.ts) and Aib (host/aib.ts), whose method groups are split
 * into files; each file exports an object of `this`-typed methods and the class merges their types with an interface.
 */
// deno-lint-ignore no-explicit-any
export function installMethods(target: { prototype: any }, ...groups: Record<string, unknown>[]): void {
  for (const group of groups) {
    for (const name of Object.keys(group)) {
      // A class-body method, or a method of an earlier group, with this name would be overwritten without a trace.
      if (Object.hasOwn(target.prototype, name)) throw new Error(`installMethods: '${name}' already exists on the prototype (a class method or an earlier group)`);
      Object.defineProperty(target.prototype, name, { value: group[name], writable: true, configurable: true, enumerable: false });
    }
  }
}
