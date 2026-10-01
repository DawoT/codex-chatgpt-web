import type { ChatGptTurnRuntime } from "../turn-execution";
import { withAbort } from "./cancellation";

/** Keeps ownership until physical cleanup, even if observation or checkpoint validation fails. */
export class CompactionBrowserRunner {
  constructor(
    private readonly retainOwnershipUntil: (settlement: Promise<void>) => void,
    private readonly signal: AbortSignal,
  ) {}

  async run<T>(runtime: ChatGptTurnRuntime, consume: (answer: string) => T | Promise<T>): Promise<T> {
    this.retainOwnershipUntil(runtime.physicalSettlement);
    try {
      const answer = await withAbort(runtime.browser, this.signal);
      await withAbort(runtime.physicalSettlement, this.signal);
      return await consume(answer);
    } catch (error) {
      runtime.cancel(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
