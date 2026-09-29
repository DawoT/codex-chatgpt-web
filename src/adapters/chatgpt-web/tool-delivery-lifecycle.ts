export type ToolDeliveryPhase = "browser_observed" | "codex_emitted" | "host_started" | "result_received";

const ORDER: readonly ToolDeliveryPhase[] = ["browser_observed", "codex_emitted", "host_started", "result_received"];

export class ToolDeliveryLifecycle {
  private readonly observed: ToolDeliveryPhase[] = [];

  mark(phase: ToolDeliveryPhase): boolean {
    if (this.observed.includes(phase)) return false;
    const expected = ORDER[this.observed.length];
    if (phase !== expected) {
      throw new Error(`Tool delivery lifecycle expected ${expected ?? "no further phase"} before ${phase}`);
    }
    this.observed.push(phase);
    return true;
  }

  current(): ToolDeliveryPhase | undefined {
    return this.observed.at(-1);
  }

  phases(): readonly ToolDeliveryPhase[] {
    return [...this.observed];
  }
}
