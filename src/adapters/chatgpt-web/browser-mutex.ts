/**
 * Interactive Browser Turn Mutex.
 *
 * Electron and Chromium share a single active window viewport and keyboard focus.
 * When multiple browser turns execute concurrently (e.g. across multiple workspaces
 * or subagents), simultaneous CDP input events (keystrokes, cursor focus, dropdown selection)
 * cause focus blur, missed mention triggers, and race conditions.
 *
 * This mutex serializes only the DOM-interactive phases of a turn:
 *   1. Temporary chat preparation / navigation
 *   2. Model & effort slider selection
 *   3. Connector mention trigger & selection
 *   4. Prompt text injection & attachment verification
 *   5. Submission / Click Send until accepted by ChatGPT
 *
 * Once the prompt is accepted (checkpoint `send-accepted` or `mcp_tool_call`), the interactive
 * lock is released so waiting turns can attach and send their prompts.
 * Passive observation, response streaming, and MCP tool loops run fully in parallel across tabs.
 */

export interface InteractiveBrowserTurnLock {
  readonly traceId: string;
  readonly acquiredAt: number;
  release(): void;
}

interface MutexWaiter {
  readonly traceId: string;
  readonly resolve: (lock: InteractiveBrowserTurnLock) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  cleanup?: () => void;
}

export class InteractiveBrowserTurnMutex {
  private readonly queue: MutexWaiter[] = [];
  private currentOwner?: string;
  private currentAcquiredAt = 0;
  private locked = false;

  /**
   * Acquire exclusive access to the browser's interactive DOM viewport.
   * Resolves with a lock object whose `release()` must be called once the
   * interactive stage (through `send-accepted`) is complete.
   */
  async acquire(traceId: string, signal?: AbortSignal): Promise<InteractiveBrowserTurnLock> {
    if (signal?.aborted) {
      throw new DOMException("Interactive browser turn acquire aborted", "AbortError");
    }

    if (!this.locked) {
      this.locked = true;
      this.currentOwner = traceId;
      this.currentAcquiredAt = Date.now();
      return this.createLock(traceId, this.currentAcquiredAt);
    }

    return new Promise<InteractiveBrowserTurnLock>((resolve, reject) => {
      const waiter: MutexWaiter = {
        traceId,
        resolve,
        reject,
        signal,
      };

      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          reject(new DOMException("Interactive browser turn acquire aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.queue.push(waiter);
    });
  }

  private createLock(traceId: string, acquiredAt: number): InteractiveBrowserTurnLock {
    let released = false;
    return {
      traceId,
      acquiredAt,
      release: () => {
        if (released) return;
        released = true;
        this.releaseOwner(traceId);
      },
    };
  }

  private releaseOwner(traceId: string): void {
    if (this.currentOwner !== traceId) {
      return;
    }

    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.cleanup?.();

      if (next.signal?.aborted) {
        continue;
      }

      this.currentOwner = next.traceId;
      this.currentAcquiredAt = Date.now();
      const lock = this.createLock(next.traceId, this.currentAcquiredAt);
      next.resolve(lock);
      return;
    }

    this.locked = false;
    this.currentOwner = undefined;
    this.currentAcquiredAt = 0;
  }

  isLocked(): boolean {
    return this.locked;
  }

  currentTraceId(): string | undefined {
    return this.currentOwner;
  }

  waitingCount(): number {
    return this.queue.length;
  }
}

export const interactiveBrowserTurnMutex = new InteractiveBrowserTurnMutex();
