// Child of module_load_order_test.ts: imports the one module named by argv[0] (a file URL), on its own, in a fresh process.
await import(Deno.args[0]);
