const RUNTIME_MUTATION_CHANNELS = new Set([
  "launcher:limits-setup",
  "launcher:mcp-verify",
  "launcher:uninstall-integration",
  "launcher:setup-core",
  "launcher:setup-mcp",
  "launcher:bigger-context",
  "launcher:skill-attachments",
  "launcher:fresh-conversation-per-turn",
  "launcher:use-saved-chats",
  "launcher:zero-risk-pro",
  "launcher:browser-interaction-mode",
  "launcher:update-install",
]);

function createRuntimeStartupGate() {
  let finish;
  let settled = false;
  let revoked;
  const ready = new Promise((resolve) => {
    finish = resolve;
  });
  return {
    run: async (operation) => {
      const failure = await ready;
      if (failure) throw failure;
      if (revoked) throw revoked;
      return operation();
    },
    settle: (failure) => {
      if (settled) return;
      settled = true;
      finish(failure);
    },
    revoke: (failure) => {
      revoked ??= failure;
      if (!settled) {
        settled = true;
        finish(revoked);
      }
    },
    guard(channel, handler) {
      if (!RUNTIME_MUTATION_CHANNELS.has(channel)) return handler;
      return (...args) => this.run(() => handler(...args));
    },
  };
}

module.exports = { createRuntimeStartupGate };
