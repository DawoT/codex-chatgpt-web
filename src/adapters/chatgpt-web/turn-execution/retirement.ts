import type { ChatGptTurnSession } from "./session";

/** Owns physical retirement gates independently of the client-visible response outcome. */
export class TurnRetirementCoordinator {
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly ownerRetirements = new Map<string, Promise<void>>();
  private readonly conversationRetirements = new Map<string, Promise<void>>();

  pending(key: string): Promise<void> | undefined {
    return this.retirements.get(key);
  }

  pendingOwner(ownerKey: string): Promise<void> | undefined {
    return this.ownerRetirements.get(ownerKey);
  }

  pendingConversation(conversationKey: string): Promise<void> | undefined {
    return this.conversationRetirements.get(conversationKey);
  }

  async trackConversation(conversationKey: string, retirement: Promise<void>): Promise<void> {
    this.conversationRetirements.set(conversationKey, retirement);
    try {
      await retirement;
    } finally {
      if (this.conversationRetirements.get(conversationKey) === retirement) {
        this.conversationRetirements.delete(conversationKey);
      }
    }
  }

  begin(key: string, session: ChatGptTurnSession, reason?: Error): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return existing;
    const conversationKey = session.conversationKey();
    session.cancel(reason);
    const retirement = session.physicalSettlement;
    this.retirements.set(key, retirement);
    const forgetRetirement = () => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    };
    void retirement.then(forgetRetirement, forgetRetirement);
    if (session.ownerKey) this.trackScope(this.ownerRetirements, session.ownerKey, retirement);
    if (conversationKey) this.trackScope(this.conversationRetirements, conversationKey, retirement);
    return retirement;
  }

  private trackScope(gates: Map<string, Promise<void>>, key: string, retirement: Promise<void>): void {
    const previous = gates.get(key);
    const combined = previous
      ? Promise.allSettled([previous, retirement]).then(() => undefined)
      : retirement.then(
          () => undefined,
          () => undefined,
        );
    gates.set(key, combined);
    const forget = () => {
      if (gates.get(key) === combined) gates.delete(key);
    };
    void combined.then(forget, forget);
  }
}
