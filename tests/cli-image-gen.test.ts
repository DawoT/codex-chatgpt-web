import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(30_000);

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("CLI image-gen command", () => {
  const samplePngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const samplePngBuffer = Buffer.from(samplePngBase64, "base64");

  test("shows help for image-gen command", async () => {
    const result = await runCli(["image-gen", "--help"], process.env as Record<string, string>);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("image-gen generate <PROMPT>");
  });

  test("fails with error when prompt is missing", async () => {
    const result = await runCli(["image-gen", "generate"], process.env as Record<string, string>);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Prompt is required");
  });

  test("generates image via mock server and saves to specified path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cli-image-test-"));
    const outPath = join(tempDir, "cli-out.png");

    // Setup mock server
    let receivedAuth = "";
    let receivedBody: any = null;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        receivedAuth = req.headers.authorization || "";
        let bodyStr = "";
        req.on("data", (chunk) => {
          bodyStr += chunk;
        });
        req.on("end", () => {
          receivedBody = JSON.parse(bodyStr);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              created: 1727500000,
              data: [{ b64_json: samplePngBase64 }],
            }),
          );
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const env = {
        ...process.env,
        CODEX_AUTH_TOKEN: "mock-token-from-env",
      };

      const result = await runCli(
        [
          "image-gen",
          "generate",
          "A photo of a solar eclipse",
          "--out",
          outPath,
          "--base-url",
          baseUrl,
          "--size",
          "1024x1024",
        ],
        env,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(outPath);
      expect(receivedAuth).toBe("Bearer mock-token-from-env");
      expect(receivedBody).toEqual({
        prompt: "A photo of a solar eclipse",
        size: "1024x1024",
        quality: "auto",
      });
      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath)).toEqual(samplePngBuffer);
    } finally {
      server.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
