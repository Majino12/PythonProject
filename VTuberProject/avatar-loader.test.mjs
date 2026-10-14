import test from "node:test";
import assert from "node:assert/strict";
import { createAvatar3D } from "./avatar-loader.js";

const avatar = () => ({ disposed: false, dispose() { this.disposed = true; } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("studio is the default and its model path and abort signal are passed through", async () => {
  const expected = avatar();
  const result = await createAvatar3D({}, {}, {
    studio: async () => ({ StudioAvatar3D: { create: async (_, options) => {
      assert.equal(options.url, "./assets/pixiv-vrm1-sample.vrm");
      assert.equal(options.signal.aborted, false);
      return expected;
    } } }),
    light() { assert.fail("should not load fallback"); },
  });
  assert.equal(result, expected);
  assert.equal(result.modelStyle, "studio");
  assert.equal(result.fallbackUsed, false);
});

test("failed studio falls back to light while explicit light skips VRM", async () => {
  let attempts = 0;
  const loaders = {
    studio: async () => { attempts++; throw new Error("Offline"); },
    light: async () => ({ Avatar3D: class { dispose() {} } }),
  };
  assert.equal((await createAvatar3D({}, {}, loaders)).fallbackUsed, true);
  assert.equal((await createAvatar3D({}, { modelStyle: "light" }, loaders)).fallbackUsed, false);
  assert.equal(attempts, 1);
});

test("cancelling a build never loads fallback and disposes a late successful result", async () => {
  const gate = deferred(), entered = deferred(), controller = new AbortController(), instance = avatar();
  const pending = createAvatar3D({}, { signal: controller.signal }, {
    studio: async () => ({ StudioAvatar3D: { create: () => { entered.resolve(); return gate.promise; } } }),
    light() { assert.fail("cancel must not trigger fallback"); },
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  gate.resolve(instance);
  await new Promise((r) => setImmediate(r));
  assert.equal(instance.disposed, true);
});

test("timeout falls back and a late module cannot create a second renderer", async () => {
  const gate = deferred();
  const result = await createAvatar3D({}, { timeoutMs: 10 }, {
    studio: () => gate.promise,
    light: async () => ({ Avatar3D: class { dispose() {} } }),
  });
  assert.equal(result.modelStyle, "light");
  gate.resolve({ StudioAvatar3D: { create() { assert.fail("late constructor"); } } });
  await new Promise((r) => setImmediate(r));
});

test("a failed fallback rejects and a pre-cancelled request does no work", async () => {
  await assert.rejects(createAvatar3D({}, {}, {
    studio: async () => { throw new Error("studio"); },
    light: async () => { throw new Error("light"); },
  }), /light/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createAvatar3D({}, { signal: controller.signal }, {
    studio() { assert.fail("pre-cancelled request"); },
  }), { name: "AbortError" });
});
