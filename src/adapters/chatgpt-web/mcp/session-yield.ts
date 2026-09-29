/** Only native session waits are shortened; shell execution deadlines are not yields.
 * This pure function is also embedded in the native JavaScript gateway.
 */
export function boundedSessionArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== "exec_command" && name !== "write_stdin") {
    return args;
  }
  const wait = args.yield_time_ms;
  if (wait !== undefined && (typeof wait !== "number" || !Number.isSafeInteger(wait) || wait < 250)) {
    throw new Error("Native command yield_time_ms must be an integer of at least 250 milliseconds");
  }
  return { ...args, yield_time_ms: wait === undefined ? 1_000 : Math.min(wait as number, 30_000) };
}
