import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface CachedFile {
  resolvedPath: string;
  mtimeMs: number;
  size: number;
  text: string;
  lines: string[];
  totalLines: number;
  isBinary: boolean;
  byteSize: number;
  lastAccessed: number;
}

export interface FastPathCacheStats {
  entryCount: number;
  totalBytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  prewarmedCount: number;
  hitRatio: number;
}

export class FastPathWorkspaceCache {
  private readonly maxMemoryBytes: number;
  private currentMemoryBytes = 0;
  private readonly entries = new Map<string, CachedFile>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private prewarmedCount = 0;

  constructor(maxMemoryBytes: number = 32 * 1024 * 1024) {
    this.maxMemoryBytes = Math.max(1024 * 1024, maxMemoryBytes);
  }

  get(resolvedPath: string, stat: Pick<Stats, "mtimeMs" | "size">): CachedFile | null {
    const existing = this.entries.get(resolvedPath);
    if (!existing) {
      this.misses += 1;
      return null;
    }

    // Check if mtime or size changed on disk
    if (existing.mtimeMs !== stat.mtimeMs || existing.size !== stat.size) {
      this.entries.delete(resolvedPath);
      this.currentMemoryBytes -= existing.byteSize;
      this.misses += 1;
      return null;
    }

    // Refresh LRU order
    this.entries.delete(resolvedPath);
    existing.lastAccessed = Date.now();
    this.entries.set(resolvedPath, existing);
    this.hits += 1;
    return existing;
  }

  set(
    resolvedPath: string,
    stat: Pick<Stats, "mtimeMs" | "size">,
    data: { text: string; lines: string[]; isBinary: boolean },
  ): void {
    const byteSize = Math.max(
      64,
      stat.size + (data.isBinary ? 0 : data.lines.length * 8 + 64),
    );

    // Skip items larger than cache ceiling
    if (byteSize > this.maxMemoryBytes) {
      return;
    }

    const existing = this.entries.get(resolvedPath);
    if (existing) {
      this.entries.delete(resolvedPath);
      this.currentMemoryBytes -= existing.byteSize;
    }

    while (
      this.entries.size > 0 &&
      this.currentMemoryBytes + byteSize > this.maxMemoryBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      const evicted = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (evicted) {
        this.currentMemoryBytes -= evicted.byteSize;
      }
      this.evictions += 1;
    }

    const entry: CachedFile = {
      resolvedPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      text: data.text,
      lines: data.lines,
      totalLines: data.lines.length,
      isBinary: data.isBinary,
      byteSize,
      lastAccessed: Date.now(),
    };

    this.entries.set(resolvedPath, entry);
    this.currentMemoryBytes += byteSize;
  }

  invalidate(resolvedPath: string): boolean {
    const existing = this.entries.get(resolvedPath);
    if (!existing) return false;
    this.entries.delete(resolvedPath);
    this.currentMemoryBytes -= existing.byteSize;
    return true;
  }

  invalidatePrefix(dirOrPrefixPath: string): number {
    const prefix = dirOrPrefixPath.endsWith("/")
      ? dirOrPrefixPath
      : `${dirOrPrefixPath}/`;
    let invalidated = 0;
    for (const [key, entry] of this.entries) {
      if (key === dirOrPrefixPath || key.startsWith(prefix)) {
        this.entries.delete(key);
        this.currentMemoryBytes -= entry.byteSize;
        invalidated += 1;
      }
    }
    return invalidated;
  }

  clear(): void {
    this.entries.clear();
    this.currentMemoryBytes = 0;
  }

  prewarmLocalImports(filePath: string, content: string, roots?: string[]): string[] {
    if (!content || content.length > 500_000) return [];
    const baseDir = dirname(filePath);
    const candidateSpecifiers: string[] = [];

    // Match JS/TS/JSON imports & requires
    const importRegex = /(?:import|export)\s+(?:(?:[\w*\s{},]*)\s+from\s+)?['"](\.[^'"]+)['"]|require\(['"](\.[^'"]+)['"]\)|import\(['"](\.[^'"]+)['"]\)/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier && specifier.startsWith(".")) {
        candidateSpecifiers.push(specifier);
      }
    }

    // Match Python relative imports: from .foo import bar
    const pyRegex = /from\s+(\.+[a-zA-Z0-9_.]*)\s+import/g;
    while ((match = pyRegex.exec(content)) !== null) {
      const dotsAndModule = match[1];
      if (dotsAndModule) {
        const dotCount = dotsAndModule.match(/^\.+/)?.[0].length ?? 1;
        const modName = dotsAndModule.slice(dotCount).replace(/\./g, "/");
        const relPrefix = dotCount === 1 ? "./" : "../".repeat(dotCount - 1);
        candidateSpecifiers.push(`${relPrefix}${modName}`);
      }
    }

    if (candidateSpecifiers.length === 0) return [];

    const prewarmed: string[] = [];
    const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".json", "/index.ts", "/index.js", ".py"];

    for (const specifier of candidateSpecifiers.slice(0, 10)) {
      const resolvedBase = resolve(baseDir, specifier);

      if (roots && roots.length > 0) {
        const isAllowed = roots.some(root => {
          const absRoot = resolve(root);
          return resolvedBase === absRoot || resolvedBase.startsWith(absRoot.endsWith("/") ? absRoot : `${absRoot}/`);
        });
        if (!isAllowed) continue;
      }

      for (const ext of extensions) {
        const candidate = `${resolvedBase}${ext}`;
        if (this.entries.has(candidate)) break;
        if (existsSync(candidate)) {
          try {
            const st = statSync(candidate);
            if (!st.isFile() || st.size > 1024 * 1024) break;
            const buffer = readFileSync(candidate);
            let isBinary = false;
            const checkBytes = Math.min(buffer.length, 512);
            for (let i = 0; i < checkBytes; i++) {
              if (buffer[i] === 0) { isBinary = true; break; }
            }
            if (isBinary) {
              this.set(candidate, st, { text: "", lines: [], isBinary: true });
            } else {
              const text = buffer.toString("utf8");
              const lines = text.split(/\r?\n/);
              this.set(candidate, st, { text, lines, isBinary: false });
            }
            this.prewarmedCount += 1;
            prewarmed.push(candidate);
            break;
          } catch {
            // ignore unreadable
          }
        }
      }
    }

    return prewarmed;
  }

  getStats(): FastPathCacheStats {
    const totalRequests = this.hits + this.misses;
    return {
      entryCount: this.entries.size,
      totalBytes: this.currentMemoryBytes,
      maxBytes: this.maxMemoryBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      prewarmedCount: this.prewarmedCount,
      hitRatio: totalRequests > 0 ? Number((this.hits / totalRequests).toFixed(4)) : 0,
    };
  }
}

export const workspaceFileCache = new FastPathWorkspaceCache();
