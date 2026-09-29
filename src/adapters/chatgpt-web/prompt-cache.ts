import { createHash } from "node:crypto";

export interface PromptContractFingerprintInput {
  modelId: string;
  modeLabel: string;
  modeEffort: string;
  localTools: boolean;
  isSubagent: boolean;
  verbosity?: string;
  outputFormatSchema?: string;
  outputFormatName?: string;
  outputFormatStrict?: boolean;
  captureLunaCheckpoint?: boolean;
  manualControl?: boolean;
  multipartEnabled?: boolean;
  isCompaction?: boolean;
  isContinuation?: boolean;
  executionMode?: "host-only";
}

export interface PromptCacheStats {
  hits: number;
  misses: number;
  size: number;
  capacity: number;
  hitRatio: number;
  avgCompilationTimeMs: number;
  totalCompilations: number;
}

/**
 * LRU cache and fingerprinting engine for static ChatGPT Web prompt contracts.
 * Reuses immutable static contract segments across successive turns within the same session
 * to avoid rebuilding static instruction segments on cache hits.
 */
export class PromptContractCache {
  private readonly cache = new Map<string, readonly string[]>();
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private totalCompilationTimeMs = 0;
  private totalCompilations = 0;

  constructor(maxEntries = 16) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("Prompt cache capacity must be a positive safe integer");
    }
    this.maxEntries = maxEntries;
  }

  /**
   * Computes a deterministic 16-character hexadecimal fingerprint of all static contract variables.
   */
  computeFingerprint(input: PromptContractFingerprintInput): string {
    const raw = JSON.stringify([
      input.modelId,
      input.modeLabel,
      input.modeEffort,
      input.localTools,
      input.isSubagent,
      input.verbosity ?? "",
      input.outputFormatSchema ?? "",
      input.outputFormatName ?? "",
      input.outputFormatStrict ?? false,
      Boolean(input.captureLunaCheckpoint),
      Boolean(input.manualControl),
      Boolean(input.multipartEnabled),
      Boolean(input.isCompaction),
      Boolean(input.isContinuation),
      input.executionMode ?? "legacy",
    ]);
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  /**
   * Retrieves cached static contracts if present, refreshing LRU position.
   */
  get(fingerprint: string): readonly string[] | undefined {
    const hit = this.cache.get(fingerprint);
    if (hit) {
      this.hits++;
      // LRU refresh: re-insert at end of Map
      this.cache.delete(fingerprint);
      this.cache.set(fingerprint, hit);
      return hit;
    }
    this.misses++;
    return undefined;
  }

  /**
   * Stores static contracts in cache with LRU eviction.
   */
  set(fingerprint: string, contracts: readonly string[]): void {
    this.cache.delete(fingerprint);
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(fingerprint, Object.freeze([...contracts]));
  }

  /**
   * Records elapsed time for prompt compilation.
   */
  recordCompilation(durationMs: number): void {
    this.totalCompilations++;
    this.totalCompilationTimeMs += durationMs;
  }

  /**
   * Returns point-in-time statistics suitable for /healthz diagnostics.
   */
  getStats(): PromptCacheStats {
    const totalRequests = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      capacity: this.maxEntries,
      hitRatio: totalRequests > 0 ? Number((this.hits / totalRequests).toFixed(3)) : 0,
      avgCompilationTimeMs:
        this.totalCompilations > 0 ? Number((this.totalCompilationTimeMs / this.totalCompilations).toFixed(2)) : 0,
      totalCompilations: this.totalCompilations,
    };
  }

  /**
   * Clears all cache entries and resets metrics (used in testing and graceful restarts).
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.totalCompilationTimeMs = 0;
    this.totalCompilations = 0;
  }
}

export const defaultPromptContractCache = new PromptContractCache(16);
