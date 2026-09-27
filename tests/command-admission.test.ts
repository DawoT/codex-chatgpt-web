import { expect, test } from "bun:test";
import { CommandAdmission } from "../src/adapters/chatgpt-web/command-admission";

test("bounded admission preserves FIFO order and rejects excess work", async () => {
  const admission = new CommandAdmission(1, 2);
  const release = await admission.acquire();
  const order: number[] = [];
  const first = admission.acquire().then(lease => {
    order.push(1);
    return lease;
  });
  const second = admission.acquire().then(lease => {
    order.push(2);
    return lease;
  });
  await expect(admission.acquire()).rejects.toThrow("capacity exhausted");
  release();
  const releaseFirst = await first;
  expect(order).toEqual([1]);
  release();
  await Promise.resolve();
  expect(order).toEqual([1]);
  releaseFirst();
  const releaseSecond = await second;
  expect(order).toEqual([1, 2]);
  releaseSecond();
});

test("cancelled queued work cannot consume a later execution slot", async () => {
  const admission = new CommandAdmission(1, 1);
  const release = await admission.acquire();
  const controller = new AbortController();
  const pending = admission.acquire(controller.signal);
  controller.abort(new Error("cancel queued"));
  await expect(pending).rejects.toThrow("cancel queued");
  const next = admission.acquire();
  release();
  const releaseNext = await next;
  releaseNext();
  const final = await admission.acquire(undefined, false);
  final();
});

test("admission wait expires without leaking a slot or queue entry", async () => {
  const admission = new CommandAdmission(1, 1, 10);
  const release = await admission.acquire();
  await expect(admission.acquire()).rejects.toThrow("no command was started");
  release();
  const next = await admission.acquire(undefined, false);
  next();
});

test("pre-aborted admission consumes neither capacity nor a queue position", async () => {
  const admission = new CommandAdmission(1);
  await expect(admission.acquire(AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
  const release = await admission.acquire(undefined, false);
  release();
});
