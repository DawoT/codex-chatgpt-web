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
      title: "Generate or edit an image using ChatGPT Plus / Codex",
      description:
        "Generate an image from a text prompt and save it directly to disk (PNG). "
        + "Optionally provide an existing image via `input_image_path` (absolute or workspace-relative path) "
        + "or `input_image_base64` (raw base64 bytes) to use as the base for editing / inpainting / variation. "
        + "When an input image is provided the request is routed to the image-edits endpoint. "
        + "Returns the saved file path.",
      inputSchema: {
        prompt: z.string().min(1).max(4_000).describe("Description of the image to generate or the edit instructions."),
        out_path: z.string().max(16_384).optional().describe("Optional destination path for the saved PNG file (relative to workspace or absolute). If omitted, saved to $CODEX_HOME/generated_images/."),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024").describe("Image dimensions (default: 1024x1024)."),
        quality: z.enum(["low", "medium", "high", "auto"]).default("auto").describe("Generation quality (default: auto)."),
        workspace: z.string().max(1_024).optional().describe("Optional configured workspace; used to resolve relative out_path and input_image_path."),
        input_image_path: z.string().max(16_384).optional().describe(
          "Path to an existing PNG/JPEG/WebP image to use as input for editing. "
          + "May be absolute or relative to the workspace root. "
          + "When provided, the request is sent to the image-edits endpoint instead of image-generations.",
        ),
        input_image_base64: z.string().optional().describe(
          "Raw base64-encoded bytes of an existing image (PNG/JPEG/WebP) to use as input for editing. "
          + "Use together with `input_image_mime` to specify the format. "
          + "Mutually exclusive with `input_image_path`.",
        ),
        input_image_mime: z.enum(["image/png", "image/jpeg", "image/webp"]).optional().describe(
          "MIME type of the base64 image provided via `input_image_base64` (default: image/png).",
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      let resolvedOutPath = input.out_path;
      let resolvedInputImagePath = input.input_image_path;

      if (options.scopeFor) {
        const scope = options.scopeFor(input.workspace);
        if (resolvedOutPath) {
          resolvedOutPath = resolveSafeWorkspacePath(resolvedOutPath, scope.cwd, scope.roots);
          if (scope.writableRoots !== undefined) {
            assertWritableRootContainment(resolvedOutPath, input.out_path!, scope.writableRoots);
          }
        }
        if (resolvedInputImagePath) {
          resolvedInputImagePath = resolveSafeWorkspacePath(resolvedInputImagePath, scope.cwd, scope.roots);
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
            inputImagePath: resolvedInputImagePath,
            inputImageBase64: input.input_image_base64,
            inputImageMime: input.input_image_mime,
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
            edited: res.edited ?? false,
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
