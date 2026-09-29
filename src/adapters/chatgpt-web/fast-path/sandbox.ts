import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

interface RealpathDeps {
  /** Injectable for tests; production uses node:fs.realpathSync. */
  realpath?: (path: string) => string;
}

function isInsideRoot(base: string, root: string): boolean {
  const rel = relative(root, base);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Deepest ancestor of `path` (including `path` itself) that currently exists on disk. */
function deepestExistingAncestor(path: string): string {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Symlink-containment verification shared by every handler that resolves a workspace path
 * (Sprint C1). Two cases must hold before any filesystem mutation:
 *  - If the leaf exists, its full realpath must land inside the realpath-ed roots (pre-existing
 *    leaf check; realpath transitively covers every ancestor of an existing leaf).
 *  - If the leaf does not exist, the deepest EXISTING ancestor is the only on-disk component that
 *    mkdirSync/writeFileSync would traverse, so its realpath must land inside the realpath-ed
 *    roots. A dangling leaf symlink (lstat succeeds, realpath fails) fails closed exactly like
 *    any other unverifiable path; otherwise writeFileSync would follow it and create the target
 *    outside the sandbox.
 * The purely lexical root check in resolveSafeWorkspacePath stays as defense in depth.
 */
export function assertSymlinkSafePath(
  resolved: string,
  roots: string[],
  requestedPath: string,
  deps: RealpathDeps = {},
): void {
  const realpath = deps.realpath ?? realpathSync;
  const outsideError = () => new Error(`Resolved symlink targets outside allowed sandbox roots: ${requestedPath}`);
  const run = (): void => {
    const realRoots = roots.map((root) => (existsSync(root) ? realpath(resolve(root)) : resolve(root)));
    if (existsSync(resolved)) {
      const real = realpath(resolved);
      if (!realRoots.some((realRoot) => isInsideRoot(real, realRoot))) throw outsideError();
      return;
    }
    let danglingLeaf = false;
    try {
      lstatSync(resolved);
      danglingLeaf = true;
    } catch {
      // Truly absent leaf: fall through to the ancestor check.
    }
    if (danglingLeaf) {
      // Dangling symlink: realpath must fail and trigger the fail-closed branch below.
      const real = realpath(resolved);
      if (!realRoots.some((realRoot) => isInsideRoot(real, realRoot))) throw outsideError();
      return;
    }
    const realAncestor = realpath(deepestExistingAncestor(resolved));
    if (!realRoots.some((realRoot) => isInsideRoot(realAncestor, realRoot))) throw outsideError();
  };
  try {
    run();
  } catch (realErr) {
    if (realErr instanceof Error && realErr.message.includes("Resolved symlink")) throw realErr;
    // Fail closed: an unverifiable path (EACCES, ELOOP, EPERM, ...) must never be accepted as
    // symlink-safe, otherwise a hostile link could escape the sandbox unnoticed.
    const code =
      realErr !== null &&
      typeof realErr === "object" &&
      "code" in realErr &&
      typeof (realErr as { code: unknown }).code === "string"
        ? (realErr as { code: string }).code
        : "UNKNOWN";
    throw new Error(`Cannot verify symlink safety for ${requestedPath}: ${code}`);
  }
}

export function resolveSafeWorkspacePath(
  requestedPath: string,
  cwd: string,
  roots: string[],
  deps: RealpathDeps = {},
): string {
  const resolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
  const isAllowed = roots.some((root) => {
    const rel = relative(resolve(root), resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!isAllowed) {
    throw new Error(`Path is outside allowed sandbox roots: ${requestedPath}`);
  }
  assertSymlinkSafePath(resolved, roots, requestedPath, deps);
  return resolved;
}

/**
 * Sprint C2: when the turn environment declares writableRoots, mutations must be contained there
 * instead of the broader read-only roots. Callers must reject an empty writableRoots list before
 * reaching this helper (read-only workspaces reject every mutation outright).
 */
export function assertWritableRootContainment(
  resolved: string,
  requestedPath: string,
  writableRoots: string[],
  deps: RealpathDeps = {},
): void {
  const lexicalAllowed = writableRoots.some((root) => isInsideRoot(resolved, resolve(root)));
  if (!lexicalAllowed) {
    throw new Error(`Path is outside allowed writable roots: ${requestedPath}`);
  }
  assertSymlinkSafePath(resolved, writableRoots, requestedPath, deps);
}
