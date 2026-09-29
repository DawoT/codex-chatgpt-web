const test = require("node:test");
const assert = require("node:assert/strict");
const { SurfaceAdmission } = require("../electron/surface-admission.cjs");

test("four ordinary surfaces leave the fifth for compaction and release wakes queued work", async () => {
  const occupants = new Map();
  const admission = new SurfaceAdmission(() => [...occupants.values()]);
  for (let index = 0; index < 4; index += 1) {
    const ticket = await admission.acquire("ordinary");
    occupants.set(`ordinary-${index}`, "ordinary");
    ticket.commit();
  }

  const nextOrdinary = admission.acquire("ordinary");
  assert.equal(admission.queuedCount, 1);
  const reserved = await admission.acquire("reserved");
  occupants.set("compaction", "reserved");
  reserved.commit();
  assert.equal(admission.queuedCount, 1);
  assert.equal(occupants.size, 5);

  const nextReserved = admission.acquire("reserved");
  assert.equal(admission.queuedCount, 2);
  occupants.delete("ordinary-0");
  admission.surfaceReleased();
  const ordinaryTicket = await nextOrdinary;
  occupants.set("ordinary-4", "ordinary");
  ordinaryTicket.commit();
  assert.equal(admission.queuedCount, 1);

  occupants.delete("compaction");
  admission.surfaceReleased();
  const reservedTicket = await nextReserved;
  occupants.set("recovery", "reserved");
  reservedTicket.commit();
  assert.equal(admission.queuedCount, 0);
  assert.equal(occupants.size, 5);
});

test("aborting a queued admission does not consume the next released surface", async () => {
  const occupants = new Map(Array.from({ length: 4 }, (_, index) => [
    `ordinary-${index}`,
    "ordinary",
  ]));
  const admission = new SurfaceAdmission(() => [...occupants.values()]);
  const controller = new AbortController();
  const cancelled = admission.acquire("ordinary", controller.signal);
  const next = admission.acquire("ordinary");
  assert.equal(admission.queuedCount, 2);

  const reason = new Error("client disconnected");
  controller.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  assert.equal(admission.queuedCount, 1);
  occupants.delete("ordinary-0");
  admission.surfaceReleased();
  const ticket = await next;
  ticket.release();
  assert.equal(admission.queuedCount, 0);
});

test("an uncommitted grant holds capacity until released", async () => {
  const occupants = new Map(Array.from({ length: 3 }, (_, index) => [
    `ordinary-${index}`,
    "ordinary",
  ]));
  const admission = new SurfaceAdmission(() => [...occupants.values()]);
  const grant = await admission.acquire("ordinary");
  const waiting = admission.acquire("ordinary");
  assert.equal(admission.queuedCount, 1);
  grant.release();
  const second = await waiting;
  second.release();
  assert.equal(admission.queuedCount, 0);
});

test("synchronous manual admission cannot bypass queued ordinary work or use the reserved slot", async () => {
  const occupants = new Map(Array.from({ length: 3 }, (_, index) => [
    `ordinary-${index}`,
    "ordinary",
  ]));
  const admission = new SurfaceAdmission(() => [...occupants.values()]);
  const grant = await admission.acquire("ordinary");
  const queued = admission.acquire("ordinary");
  assert.equal(admission.tryAcquire("ordinary"), null);
  grant.release();
  const next = await queued;
  occupants.set("ordinary-3", "ordinary");
  next.commit();
  assert.equal(admission.tryAcquire("ordinary"), null);
  const recovery = admission.tryAcquire("reserved");
  assert.ok(recovery);
  occupants.set("recovery", "reserved");
  recovery.commit();
  assert.equal(admission.tryAcquire("reserved"), null);
});

test("only one recovery or compaction owns the reserved surface at a time", async () => {
  const occupants = new Map();
  const admission = new SurfaceAdmission(() => [...occupants.values()]);
  const first = await admission.acquire("reserved");
  occupants.set("compaction", "reserved");
  first.commit();

  const second = admission.acquire("reserved");
  assert.equal(admission.queuedCount, 1);
  const ordinary = await admission.acquire("ordinary");
  occupants.set("ordinary", "ordinary");
  ordinary.commit();
  assert.equal(admission.queuedCount, 1);

  occupants.delete("compaction");
  admission.surfaceReleased();
  const recovery = await second;
  recovery.release();
  assert.equal(admission.queuedCount, 0);
});
