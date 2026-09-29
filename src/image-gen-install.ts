import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface InstallResult {
  installed: boolean;
  paths: string[];
}

export interface UninstallResult {
  uninstalled: boolean;
  paths: string[];
}

export function defaultRepoRoot(): string {
  return resolve(dirname(import.meta.dir));
}

export function defaultBinDir(): string {
  return join(homedir(), ".local", "bin");
}

export function installImageGenCliWrappers(
  targetDir: string = defaultBinDir(),
  repoRoot: string = defaultRepoRoot(),
): InstallResult {
  mkdirSync(targetDir, { recursive: true });

  const binDir = join(repoRoot, "bin");
  const mainExecutable = join(binDir, "image_gen");
  const wrappers = ["image_gen", "genaiimg"];
  const installedPaths: string[] = [];

  for (const name of wrappers) {
    const source = existsSync(join(binDir, name)) ? join(binDir, name) : mainExecutable;
    const target = join(targetDir, name);

    try {
      if (existsSync(target) || lstatSync(target).isSymbolicLink()) {
        rmSync(target, { force: true });
      }
    } catch {
      // Ignored if target doesn't exist
    }

    symlinkSync(source, target);
    installedPaths.push(target);
  }

  return { installed: true, paths: installedPaths };
}

export function uninstallImageGenCliWrappers(
  targetDir: string = defaultBinDir(),
  repoRoot: string = defaultRepoRoot(),
): UninstallResult {
  if (!existsSync(targetDir)) {
    return { uninstalled: false, paths: [] };
  }

  const wrappers = ["image_gen", "genaiimg"];
  const removed: string[] = [];

  for (const name of wrappers) {
    const target = join(targetDir, name);
    try {
      if (existsSync(target) || lstatSync(target).isSymbolicLink()) {
        const link = readlinkSync(target);
        if (link.startsWith(repoRoot)) {
          rmSync(target, { force: true });
          removed.push(target);
        }
      }
    } catch {
      // Ignore
    }
  }

  return { uninstalled: removed.length > 0, paths: removed };
}
