import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { generateImage, type ImageGenerationResult } from "../../../image-generation";
import { resolveSafeWorkspacePath } from "../fast-path-handlers";
import { assertWritableRootContainment } from "../fast-path/sandbox";
import { result } from "../fast-path-handlers";
import { asMcpResult } from "./results";

export interface ImageToolOptions {
  token?: string;
  baseUrl?: string;
  codexHome?: string;
  fetchImpl?: typeof fetch;
  scopeFor?: (requested?: string) => { cwd: string; roots: string[]; writableRoots?: string[] };
}

export function registerImageTools(server: McpServer, options: ImageToolOptions = {}): void {
  server.registerTool(
    "codex_image_generate",
    {
      title: "Generate an image using ChatGPT Plus / Codex",
      description: "Generate an image from a text prompt and save it directly to disk (PNG). Uses the connected ChatGPT Plus / Codex account. Returns the saved file path.",
      inputSchema: {
        prompt: z.string().min(1).max(4_000).describe("Description of the image to generate."),
        out_path: z.string().max(16_384).optional().describe("Optional destination path for the saved PNG file (relative to workspace or absolute). If omitted, saved to $CODEX_HOME/generated_images/."),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024").describe("Image dimensions (default: 1024x1024)."),
        quality: z.enum(["low", "medium", "high", "auto"]).default("auto").describe("Generation quality (default: auto)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; used to resolve relative out_path."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      let resolvedOutPath = input.out_path;
      if (resolvedOutPath && options.scopeFor) {
        const scope = options.scopeFor(input.workspace);
        resolvedOutPath = resolveSafeWorkspacePath(resolvedOutPath, scope.cwd, scope.roots);
        if (scope.writableRoots !== undefined) {
          assertWritableRootContainment(resolvedOutPath, input.out_path!, scope.writableRoots);
        }
      }

      try {
        const res: ImageGenerationResult = await generateImage(
          {
            prompt: input.prompt,
            size: input.size,
            quality: input.quality,
            outPath: resolvedOutPath,
            token: options.token,
            baseUrl: options.baseUrl,
            codexHome: options.codexHome,
          },
          options.fetchImpl,
        );

        return asMcpResult(
          result({
            tool: "codex_image_generate",
            success: true,
            path: res.path,
            bytes: res.bytes,
            prompt: res.prompt,
            size: res.size,
          }),
          { toolName: "codex_image_generate", offload: false },
        );
      } catch (err: any) {
        return asMcpResult(
          result({
            tool: "codex_image_generate",
            error: err?.message || String(err),
          }, true),
          { toolName: "codex_image_generate", offload: false },
        );
      }
    },
  );
}
