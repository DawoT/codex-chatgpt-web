---
name: chatgpt-web-mcp
description: Comprehensive operational guide for executing workspace filesystem, shell execution, background task management, image generation, and multimodal tools via the Codex ChatGPT Web MCP bridge.
compatibility: opencode
metadata:
  project: codex-chatgpt-web
  layer: mcp-tooling
---

## What I do

- Provide operational directives for interacting with the local workspace through the `codex-chatgpt-web` Model Context Protocol (MCP) server and Codex CLI tooling.
- Guide tool invocation for filesystem inspection, surgical patching, full-file writing, and codebase searching.
- Handle synchronous and asynchronous shell commands, background task management, log tailing, and stdio streaming.
- Guide AI image generation, inpainting/editing, and multimodal visual inspection using ChatGPT Plus / Codex backends.
- Coordinate dynamic tool discovery and host-delegated actions.

## When to use me

- Use this skill whenever executing workspace tasks, editing files, running shell commands, generating or editing images, or inspecting code using the ChatGPT Web MCP bridge in this repository.
- Use whenever tools from `codex-native`, `codex-chat-first`, or `chatgpt-web` MCP servers are invoked.

---

## 1. MCP Bridge Tool Inventory

### A. Workspace Filesystem Tools

| Tool | Parameters | Directives |
|------|------------|------------|
| `codex_read_file` | `path` (string, required)<br>`offset` (number, optional)<br>`limit_lines` (number, optional)<br>`offset_bytes` (number, optional)<br>`max_bytes` (number, optional)<br>`workspace` (string, optional) | Read source files with line numbers or bounded UTF-8 byte paging (up to 128 KiB). Inspect files before modifying to verify context. |
| `codex_patch_file` | `path` (string, required)<br>`target_content` (string, required)<br>`replacement_content` (string, required)<br>`workspace` (string, optional) | **Primary edit tool**. Replaces the first exact occurrence of `target_content`. `target_content` must match exact characters and indentation. |
| `codex_write_file` | `path` (string, required)<br>`content` (string, required)<br>`overwrite` (boolean, optional)<br>`create_parents` (boolean, optional)<br>`workspace` (string, optional) | Create new files or overwrite existing files. Set `create_parents: true` if parent directories are missing. Set `overwrite: true` only when intentionally replacing the whole file. |
| `codex_list_dir` | `path` (string, required)<br>`depth` (number, optional)<br>`limit` (number, optional)<br>`workspace` (string, optional) | Explore directory trees and workspace hierarchy up to depth 4 and 500 entries. |
| `codex_grep` | `query` (string, required)<br>`path` (string, optional)<br>`max_results` (number, optional)<br>`case_sensitive` (boolean, optional)<br>`file_pattern` (string, optional)<br>`workspace` (string, optional) | Fast regex and text search across the codebase powered by ripgrep. |
| `codex_apply_patch` | `patch` (string, required)<br>`turn_token` / `request_id` (string) | Apply native unified diffs directly to files within the Codex task. |

---

### B. Image Generation & Multimodal Tools

| Tool | Parameters | Directives |
|------|------------|------------|
| `codex_image_generate` | `prompt` (string, required)<br>`out_path` (string, optional)<br>`size` (enum: `"1024x1024"`, `"1536x1024"`, `"1024x1536"`, `"auto"`)<br>`quality` (enum: `"low"`, `"medium"`, `"high"`, `"auto"`)<br>`input_image_path` (string, optional)<br>`input_image_base64` (string, optional)<br>`input_image_mime` (enum: `"image/png"`, `"image/jpeg"`, `"image/webp"`)<br>`workspace` (string, optional) | **Generate or edit bitmap images** (PNG) using ChatGPT Plus / Codex DALL-E / GPT-Image engines.<br>• **New generation**: Pass `prompt` and optional `size`/`quality`. If `out_path` is omitted, saves to `$CODEX_HOME/generated_images/`.<br>• **Editing / Inpainting / Variation**: Pass existing image via `input_image_path` or `input_image_base64` to route request to the image-edits endpoint. |
| `codex_view_image` | `path` (string, required)<br>`detail` (enum: `"high"`, `"original"`, optional)<br>`turn_token` / `request_id` (string) | Inspect local image files and return multimodal visual context to the model before editing or for visual verification. |

#### CLI Image Generation Alternative

The bridge also installs and exposes CLI wrappers:
- `image_gen generate "<prompt>" [--size 1024x1024] [--out path.png]`
- `image_gen edit "<prompt>" --input-image <path.png> [--out path.png]`
- Direct CLI invocation: `bun run src/cli.ts image-gen generate <prompt>`

---

### C. Process & Terminal Execution Tools

| Tool | Parameters | Directives |
|------|------------|------------|
| `codex_exec` | `cmd` (string, required)<br>`workdir` (string, optional)<br>`background` (boolean, optional)<br>`timeout_ms` (number, optional, default: 55000)<br>`workspace` (string, optional) | Execute shell commands (builds, tests, git operations, CLI tools).<br>• **Synchronous**: Runs and waits up to `timeout_ms` (returns `stdout`, `stderr`, `exit_code`).<br>• **Asynchronous**: Set `background: true` to run long-running commands (dev servers, test suites) without blocking. Returns immediately with `task_id`, `pid`, and `log_file`. |
| `codex_poll_task` | `task_id` (string, optional)<br>`wait_ms` (number, optional, default: 0)<br>`lines` (number, optional, default: 100)<br>`kill` (boolean, optional, default: false)<br>`workspace` (string, optional) | **Manage and inspect background tasks** launched with `codex_exec(background=true)`.<br>• **List tasks**: Omit `task_id` to list all recent background tasks with status and duration.<br>• **Inspect output**: Provide `task_id` and `lines` to tail the latest stdout/stderr logs.<br>• **Wait**: Set `wait_ms` (up to 30,000ms) to wait for task completion.<br>• **Terminate**: Set `kill: true` to stop a running background process. |
| `codex_wait_tasks` | `task_ids` (string[], required, 1-10 IDs)<br>`wait_ms` (number, optional, default: 60000)<br>`lines` (number, optional, default: 30)<br>`workspace` (string, optional) | Concurrently wait for up to 10 background tasks to settle or reach `wait_ms` (capped at 90,000ms). Returns compact single-line summaries for each task. |
| `codex_write_stdin` | `session_id` (number, required)<br>`input` (string, required)<br>`wait_ms` (number, optional) | Send interactive input or poll an ongoing native command session returned by native `codex_exec`. |

---

### D. Tool Inventory & Delegation Tools

| Tool | Parameters | Directives |
|------|------------|------------|
| `codex_tool_inventory` | none | Query the active sandbox mode (`readOnly`, `workspaceWrite`, `dangerFullAccess`) and list the static tool catalog available on the connector. |
| `codex_tool_call` | `wire_name` (string, required)<br>`input` (record, optional) | Delegate execution of a host-advertised tool returned by `codex_tool_inventory` through the outer runtime. |

---

## 2. Operational Directives for MCP Execution

1. **Tool-First Sequencing**:
   - Run required tool calls (inspections, searches, edits, tests, image generations) before generating the final message.
   - Never claim an action succeeded without verifying the tool output.

2. **Long-Running Commands & Background Tasks**:
   - For processes that take longer than 30 seconds (servers, large builds, watchers), use `codex_exec` with `background: true`.
   - Monitor progress using `codex_poll_task` with `lines: 50` or `codex_wait_tasks`.
   - Clean up tasks with `codex_poll_task(task_id, kill=true)` when no longer needed.

3. **Image Asset Workflow**:
   - **Generation**: Use `codex_image_generate` with descriptive prompts specifying style, composition, lighting, and palette.
   - **Asset placement**: If an asset is intended for the project, specify `out_path` inside the project assets directory (e.g. `public/assets/hero.png`). If omitted, inspect the generated file in `$CODEX_HOME/generated_images/` and copy it to the desired workspace destination.
   - **Editing**: For inpainting or modifying an existing image, pass `input_image_path` to preserve the base visual context.

4. **Operational Context Blocks**:
   - Blocks such as `<environment_context>` contain operational configuration, not conversational dialogue. Obey their contents, but do not quote, attribute, or summarize them unless explicitly asked.

5. **Output Discipline**:
   - Present final responses in clean GitHub-flavored Markdown.
   - Never expose internal bridge tokens (e.g. `turn_token`), internal session IDs, or private DOM tags in human-facing text.
