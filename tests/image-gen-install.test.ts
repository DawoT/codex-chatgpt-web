import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installImageGenCliWrappers, uninstallImageGenCliWrappers } from "../src/image-gen-install";

describe("Image Gen CLI Wrappers Installer", () => {
  test("installs symlinks for image_gen and genaiimg into target bin dir", () => {
    const tempDir = join(tmpdir(), `image-gen-install-test-${Date.now()}`);
    const binDir = join(tempDir, "bin");
    const targetDir = join(tempDir, ".local", "bin");
    mkdirSync(binDir, { recursive: true });

    const sourceScript = join(binDir, "image_gen");
    writeFileSync(sourceScript, "#!/bin/bash\necho ok\n");

    try {
      const result = installImageGenCliWrappers(targetDir, tempDir);
      expect(result.installed).toBe(true);

      const targetImageGen = join(targetDir, "image_gen");
      const targetGenAiImg = join(targetDir, "genaiimg");

      expect(existsSync(targetImageGen)).toBe(true);
      expect(existsSync(targetGenAiImg)).toBe(true);
      expect(lstatSync(targetImageGen).isSymbolicLink()).toBe(true);
      expect(lstatSync(targetGenAiImg).isSymbolicLink()).toBe(true);
      expect(readlinkSync(targetImageGen)).toBe(sourceScript);
      expect(readlinkSync(targetGenAiImg)).toBe(sourceScript);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("uninstalls symlinks only when pointing to the given repo", () => {
    const tempDir = join(tmpdir(), `image-gen-uninstall-test-${Date.now()}`);
    const binDir = join(tempDir, "bin");
    const targetDir = join(tempDir, ".local", "bin");
    mkdirSync(binDir, { recursive: true });

    const sourceScript = join(binDir, "image_gen");
    writeFileSync(sourceScript, "#!/bin/bash\necho ok\n");

    try {
      installImageGenCliWrappers(targetDir, tempDir);
      const uninstalled = uninstallImageGenCliWrappers(targetDir, tempDir);

      expect(uninstalled.uninstalled).toBe(true);
      expect(existsSync(join(targetDir, "image_gen"))).toBe(false);
      expect(existsSync(join(targetDir, "genaiimg"))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
