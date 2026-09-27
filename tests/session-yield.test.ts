import { expect, test } from "bun:test";
import { execGatewayProgram, transportBoundRawExecProgram } from "../src/adapters/chatgpt-web/mcp/gateway-programs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

for (const tool of ["exec_command", "write_stdin"]) {
  for (const wait of [undefined, 5_000, 300_000]) {
    test(`raw ${tool} returns a native session with bounded wait ${wait}`, async () => {
      const original = { session_id: 42, cmd: "long-task", yield_time_ms: wait };
      let received: unknown;
      const source = { [tool]: async (args: unknown) => {
        received = args;
        return { session_id: 42 };
      } };
      let result: unknown;
      await new AsyncFunction("tools", "ALL_TOOLS", "text", transportBoundRawExecProgram(
        `text(await tools.${tool}(${JSON.stringify(original)}));`, "exec",
      ))(source, [{ name: tool }], (value: unknown) => { result = value; });
      expect(received).toEqual({ ...JSON.parse(JSON.stringify(original)), yield_time_ms: wait === undefined ? 1_000 : Math.min(wait, 30_000) });
      expect(result).toEqual({ session_id: 42 });
    });
  }
}

test("structured gateway bounds session polls without changing shell execution deadlines", async () => {
  for (const [name, args, expected] of [
    ["write_stdin", { session_id: 7, yield_time_ms: 300_000 }, { session_id: 7, yield_time_ms: 30_000 }],
    ["shell_command", { command: "long-task", timeout_ms: 300_000 }, { command: "long-task", timeout_ms: 300_000 }],
  ] as const) {
    let received: unknown;
    await new AsyncFunction("tools", "ALL_TOOLS", "text", execGatewayProgram(name, false, { arguments: args }, []))(
      { [name]: async (value: unknown) => { received = value; return "ok"; } },
      [{ name }],
      () => {},
    );
    expect(received).toEqual(expected);
  }
});
