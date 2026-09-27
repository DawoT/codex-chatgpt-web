import { randomBytes } from "node:crypto";
import type { LauncherManualTurnEnd, LauncherManualTurnOwner } from "../../../launcher-browser-host";
import type { CodexParsedRequest } from "../../../types";
import { ChatGptWebAdapterError } from "../adapter-error";
import type { extractChatGptTurnEnvironment } from "../environment";
import type { ChatGptWebCapabilities } from "../model";
import { compileChatGptWebPrompt } from "../prompt";
import type { TurnBrokerOwner } from "../turn-broker";
import type {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnRuntime,
} from "../turn-execution";
import { ChatGptExternalTurnProgress } from "../turn-progress";
import { cancellableBrowserTurn, deferred } from "./cancellation";
import { safeManualAdapterError, safeManualTerminalError } from "./manual-control";
import type { ChatGptZeroRiskManualControl } from "./types";

export interface ManualTurnRuntimeContext {
  parsed: CodexParsedRequest;
  environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
  checkpointInput: { parsed: CodexParsedRequest; applied: boolean; reason?: string };
  resumeInput: CodexParsedRequest | undefined;
  turnCapabilities: ChatGptWebCapabilities;
  traceId: string;
  retainedLauncherDescriptor: string | undefined;
  conversationKey: string | undefined;
  releaseRetainedConversation: (() => Promise<void>) | undefined;
  retainConversation: boolean;
  broker: TurnBrokerOwner;
  zeroRiskManualControl: ChatGptZeroRiskManualControl;
  observeCapabilityRetirement: (turnToken: string, externalProgress: ChatGptExternalTurnProgress) => void;
  submission: NonNullable<ChatGptTurnRuntime["submission"]>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  browserAbort: AbortController;
  trackBrowserOwner: (browser: Promise<string>) => Promise<string>;
}

export function createManualTurnRuntime(ctx: ManualTurnRuntimeContext): ChatGptTurnRuntime {
  const {
    parsed,
    environment,
    checkpointInput,
    resumeInput,
    turnCapabilities,
    traceId,
    retainedLauncherDescriptor,
    conversationKey,
    releaseRetainedConversation,
    retainConversation,
    broker,
    zeroRiskManualControl,
    observeCapabilityRetirement,
    submission,
    trace,
    text,
    browserAbort,
    trackBrowserOwner,
  } = ctx;

  if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
  if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");

  const token = deferred<string>();
  const externalProgress = new ChatGptExternalTurnProgress();
  const surfaceNonce = randomBytes(32).toString("base64url");
  const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
  let tokenSettled = false;
  let activeToken: string | undefined;
  let launcherStarted = false;
  let launcherEnded = false;

  const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
    if (!launcherStarted || launcherEnded) return;
    await zeroRiskManualControl.end(retainedLauncherDescriptor, {
      ...owner,
      status,
      ...(status === "completed" && retainConversation ? { retain: true } : {}),
    });
    launcherEnded = true;
  };

  const runManual = async (): Promise<string> => {
    try {
      activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
      observeCapabilityRetirement(activeToken, externalProgress);
      if (typeof broker.waitForClaim === "function") {
        void broker.waitForClaim(activeToken, browserAbort.signal).then(() => {
          externalProgress.recordClaim();
        }).catch(() => {});
      }
      const compiled = compileChatGptWebPrompt(
        checkpointInput.parsed,
        turnCapabilities,
        activeToken,
        { manualControl: true },
      );
      const resumeCompiled = resumeInput
        ? compileChatGptWebPrompt(
          resumeInput,
          turnCapabilities,
          activeToken,
          { manualControl: true, continuation: true },
        )
        : undefined;
      for (const candidate of [compiled, resumeCompiled]) {
        if (!candidate) continue;
        if (candidate.multipart) {
          throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
            status: 409,
            errorType: "invalid_request_error",
            code: "manual_multipart_unsupported",
            retryable: false,
          });
        }
      }
      tokenSettled = true;
      token.resolve(activeToken);
      if (!parsed._compactionRequest) {
        trace.push({
          kind: "commentary",
          text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the `Codex Zero Risk` plugin and the model you want, send the prompt, then confirm it was sent in the launcher.",
        });
      }
      await zeroRiskManualControl.start(retainedLauncherDescriptor, {
        ...owner,
        prompt: compiled.text,
        ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
        ...(conversationKey ? { conversationKey } : {}),
        ...(parsed._compactionRequest ? { compaction: true as const } : {}),
      });
      launcherStarted = true;
      await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
        abortSignal: browserAbort.signal,
      });
      await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
      submission.phase = "accepted";
      if (!parsed._compactionRequest) trace.push({
        kind: "commentary",
        text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for `Codex Zero Risk` to bind this turn through the selected ChatGPT connector.",
      });
      const terminalAbort = new AbortController();
      const abortTerminal = () => terminalAbort.abort();
      browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
      const terminalFailure = zeroRiskManualControl.waitTerminal(
        retainedLauncherDescriptor,
        owner,
        { abortSignal: terminalAbort.signal },
      ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
        .catch(error => terminalAbort.signal.aborted
          ? new Promise<never>(() => {})
          : Promise.reject(error));
      let answer: string;
      try {
        await Promise.race([
          broker.waitForSafeStart(activeToken, browserAbort.signal),
          terminalFailure,
        ]);
        await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
        if (!parsed._compactionRequest) trace.push({
          kind: "commentary",
          text: "> **Zero Risk connected**\n>\n> `Codex Zero Risk` is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
        });
        answer = await Promise.race([
          broker.waitForSafeCompletion(activeToken, browserAbort.signal),
          terminalFailure,
        ]);
      } finally {
        terminalAbort.abort();
        browserAbort.signal.removeEventListener("abort", abortTerminal);
      }
      text.push(answer);
      try {
        await finishLauncher("completed");
      } catch (controlError) {
        console.error(
          `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
      return answer;
    } catch (error) {
      const normalized = safeManualAdapterError(error);
      const externallyAborted = browserAbort.signal.aborted;
      if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized)).catch(() => {});
      try {
        await finishLauncher(externallyAborted ? "aborted" : "failed");
      } catch (controlError) {
        console.error(
          `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
      throw normalized;
    }
  };

  const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
  void browserTurn.browser.catch(error => {
    if (tokenSettled) return;
    tokenSettled = true;
    token.reject(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    mode: "tools",
    token: token.promise,
    externalProgress,
    browser: browserTurn.browser,
    physicalSettlement: browserTurn.physicalSettlement,
    trace,
    text,
    usageInput: checkpointInput.parsed,
    manualControl: { surfaceNonce },
    ...(conversationKey ? { conversationKey } : {}),
    ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
    retireCapability: async () => {
      if (activeToken) await broker.revoke(activeToken);
    },
    submission,
    cancel: (reason?: Error) => {
      browserTurn.cancel(reason);
      if (activeToken) {
        void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
          console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    },
  };
}
