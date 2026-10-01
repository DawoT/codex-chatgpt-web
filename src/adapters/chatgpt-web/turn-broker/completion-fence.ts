import { TurnBrokerProtocolError, TurnBrokerTokenError } from "./errors";
import type { TurnChannel } from "./types";

interface BrokerCompletionFenceDependencies {
  prune: () => void;
  getChannel: (token: string) => TurnChannel | undefined;
}

/** Commits against the same causal revision used by MCP activity and tool delivery. */
export class BrokerCompletionFence {
  constructor(private readonly deps: BrokerCompletionFenceDependencies) {}

  beginCompletionFence(token: string): number | undefined {
    this.deps.prune();
    const channel = this.deps.getChannel(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision;
    if (channel.activities.size > 0 || channel.invocations.size > 0) return undefined;
    return channel.activityRevision;
  }

  commitCompletionFence(token: string, revision: number): boolean {
    this.deps.prune();
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TurnBrokerProtocolError("turn completion fence revision is invalid");
    }
    const channel = this.deps.getChannel(token);
    if (!channel) throw new TurnBrokerTokenError("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision === revision;
    if (channel.activityRevision !== revision || channel.activities.size > 0 || channel.invocations.size > 0)
      return false;
    channel.completionCommitted = true;
    channel.completionRevision = revision;
    console.info(`[chatgpt-web] broker trace=${channel.traceId} committed browser completion revision=${revision}`);
    return true;
  }
}
