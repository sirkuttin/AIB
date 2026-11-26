import { assert, assertEquals, assertThrows } from './_assert.ts';
import { installMethods } from '../../app/server/acp/install_methods.ts';

Deno.test('installMethods puts group methods on the prototype, not enumerable', () => {
  class T {}
  installMethods(T, { a() { return 1; } }, { b() { return 2; } });
  const t = new T() as unknown as { a(): number; b(): number };
  assertEquals([t.a(), t.b()], [1, 2]);
  assertEquals(Object.keys(t), []);
  assertEquals(Object.getOwnPropertyDescriptor(T.prototype, 'a')?.enumerable, false);
});

Deno.test('installMethods throws, naming the method, when a class method has the name', () => {
  class T { foo() {} }
  const e = assertThrows(() => installMethods(T, { foo() {} }), Error);
  assert(e.message.includes("'foo'"), e.message);
});

Deno.test('installMethods throws, naming the method, when an earlier group has the name', () => {
  class T {}
  const e = assertThrows(() => installMethods(T, { bar() {} }, { bar() {} }), Error);
  assert(e.message.includes("'bar'"), e.message);
});
