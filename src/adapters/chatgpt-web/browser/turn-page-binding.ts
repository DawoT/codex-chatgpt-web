import type { Page, Response } from "playwright-core";
import type { ChatGptTurnEventBus } from "./turn-events";

/** Owns subscriptions for the current document while the event bus retains turn identity. */
export class ChatGptTurnPageBinding {
  private page?: Page;

  constructor(private readonly events: ChatGptTurnEventBus) {}

  private readonly response = (response: Response): void => {
    try {
      if (response.url().includes("/backend-api/")) {
        this.events.publish({ type: "network_submission_observed", source: "network", status: response.status() });
      }
    } catch {
      // Network observations wake the FSM; they never establish completion.
    }
  };

  bind(page: Page): void {
    if (page === this.page) return;
    const rebound = this.page !== undefined;
    this.page?.off("response", this.response);
    this.page = page;
    page.on("response", this.response);
    if (rebound) this.events.publish({ type: "page_rebound", source: "host" });
  }

  dispose(): void {
    this.page?.off("response", this.response);
    this.page = undefined;
  }
}
