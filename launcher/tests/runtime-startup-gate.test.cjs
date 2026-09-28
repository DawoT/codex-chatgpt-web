const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeStartupGate } = require("../electron/runtime-startup-gate.cjs");

test("runtime mutation waits for startup, while unrelated reads need no gate", async () => {
  const gate = createRuntimeStartupGate();
  let ran = false;
  const pending = gate.run(async () => { ran = true; return "updated"; });
  await Promise.resolve();
  assert.equal(ran, false);
  gate.settle();
  assert.equal(await pending, "updated");
  assert.equal(ran, true);
});

test("startup failure rejects pending and later mutations without executing them", async () => {
  const gate = createRuntimeStartupGate();
  let calls = 0;
  const mutate = () => gate.run(() => { calls += 1; });
  const pending = mutate();
  gate.settle(new Error("runtime startup failed"));
  await assert.rejects(pending, /runtime startup failed/);
  await assert.rejects(mutate(), /runtime startup failed/);
  assert.equal(calls, 0);
});

test("startup gate settles once and ignores late outcomes", async () => {
  const gate = createRuntimeStartupGate();
  gate.settle();
  gate.settle(new Error("late error"));
  assert.equal(await gate.run(() => "ready"), "ready");
});

test("IPC guard delays runtime setup but serves snapshot before startup", async () => {
  const gate = createRuntimeStartupGate();
  const calls = [];
  const setup = gate.guard("launcher:setup-core", () => { calls.push("setup"); return "ready"; });
  const snapshot = gate.guard("launcher:snapshot", () => { calls.push("snapshot"); return "state"; });
  assert.equal(snapshot(), "state");
  const pending = setup();
  assert.deepEqual(calls, ["snapshot"]);
  gate.settle();
  assert.equal(await pending, "ready");
  assert.deepEqual(calls, ["snapshot", "setup"]);
});

test("launcher shutdown revokes pending and future runtime mutations", async () => {
  const gate = createRuntimeStartupGate();
  let calls = 0;
  const pending = gate.run(() => { calls += 1; });
  gate.revoke(new Error("launcher shutting down"));
  gate.settle();
  await assert.rejects(pending, /launcher shutting down/);
  await assert.rejects(gate.run(() => { calls += 1; }), /launcher shutting down/);
  assert.equal(calls, 0);
});
