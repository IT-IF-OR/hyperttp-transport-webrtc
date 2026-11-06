import { expect, it } from "vitest";

it("runs in the explicitly requested runtime", () => {
  const globals = globalThis as typeof globalThis & { Bun?: unknown; Deno?: unknown };
  const runtime = globals.Bun ? "bun" : globals.Deno ? "deno" : "node";
  const expected = process.env.RAGU_TEST_RUNTIME;
  if (expected) expect(runtime).toBe(expected);
  console.info(`Test runtime: ${runtime}`);
});
