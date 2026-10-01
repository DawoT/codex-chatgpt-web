const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runtimeInvocation, embeddedRuntimeInvocation } = require("../electron/runtime-command.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-development-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src/adapters/chatgpt-web"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(
    path.resolve(__dirname, "../../scripts/build-development-runtime.ts"),
    path.join(root, "scripts/build-development-runtime.ts"),
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, "bun.lock"), "fixture lock\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src/generation.ts"), 'export const generation = "September";\n');
  fs.writeFileSync(
    path.join(root, "src/cli.ts"),
    'import { generation } from "./generation";\nconsole.log(generation);\n',
  );
  fs.writeFileSync(
    path.join(root, "src/adapters/chatgpt-web/browser-helper-main.ts"),
    'import { generation } from "../../generation";\nconsole.log(generation);\n',
  );
  return root;
}

test("development commands and browser descriptor pin one built generation for the launcher lifetime", (t) => {
  const sourceRoot = fixture(t);
  const invocation = runtimeInvocation({ app: { isPackaged: false }, sourceRoot, args: ["--version"] });
  assert.match(invocation.args[0], /\.launcher-runtime[/\\][a-f0-9]{64}[/\\]app[/\\]cli\.js$/);
  const { prepareDevelopmentRuntime } = require("../electron/development-runtime.cjs");
  const snapshot = prepareDevelopmentRuntime(sourceRoot);
  assert.equal(invocation.args[0], snapshot.entrypoint);
  assert.equal(path.dirname(snapshot.entrypoint), path.dirname(snapshot.helperPath));
  fs.writeFileSync(path.join(sourceRoot, "src/generation.ts"), 'export const generation = "October";\n');
  const next = embeddedRuntimeInvocation({ app: { isPackaged: false }, sourceRoot, args: ["doctor"] });
  assert.equal(next.args[0], snapshot.entrypoint);
  assert.deepEqual(next.args.slice(1), ["doctor"]);
  const child = spawnSync(invocation.executable, invocation.args, { encoding: "utf8", cwd: invocation.cwd });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), "September");
  const helper = spawnSync(process.execPath, [snapshot.helperPath], { encoding: "utf8" });
  assert.equal(helper.status, 0);
  assert.equal(helper.stdout.trim(), "September");
});
