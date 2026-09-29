import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { expandUserPath } from "../../config";
import { releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import {
  ChatGptWebAdapterError,
  codexTurnBindingObservationFailedError,
  codexTurnBindingRetiredError,
} from "./adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "./browser-worker";
import {
  extractChatGptThreadSpawnLineage,
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  hasRawChatGptEnvironmentContext,
  isChatGptSubagentTurn,
  MissingTrustedCodexEnvironmentError,
  priorChatGptAbortedTurnIds,
} from "./environment";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
} from "./model";
import { compileChatGptWebPrompt, type CompileChatGptWebPromptOptions } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  chatGptInstructionLineage,
  chatGptThreadOwnershipKey,
  chatGptTurnExecutionKey,
  chatGptTurnRetryKey,
  chatGptTurnRoundKey,
  chatGptTurnSessions,
  type ChatGptBrowserOutcome,
  type ChatGptTraceEvent,
  type ChatGptTurnRuntime,
} from "./turn-execution";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { enforcePreflightDeliveryBudget, preparePreflightInput } from "./preflight-budget";
import { enforceMissionHeadroom, missionRequirements } from "./mission-headroom";
import { initializeTurnWorkspace } from "./workspace-persistence";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";
import {
  defaultSubagentGovernor,
  MAX_CHATGPT_BROWSER_TABS,
  MAX_CHATGPT_LAUNCHER_PENDING_TURNS,
  SubagentConcurrencyGovernor,
} from "./concurrency";
import {
  brokerResult,
  brokerSocketPath,
  cancellableBrowserTurn,
  chatGptWebExecutionNamespace,
  chatGptWebTraceId,
  CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
  CHATGPT_WEB_COMPACTION_HEARTBEAT_MS,
  createManualTurnRuntime,
  currentToolResults,
  deferred,
  emitBrowserCompletion,
  emitReadOnlyContextWarning,
  emitTextDeltas,
  emitToolBatch,
  emitTraceEvents,
  executeCompactionFlow,
  launcherZeroRiskManualControl,
  replayEvents,
  submittedTurnFailure,
  validateBatchTools,
  withAbort,
  type ChatGptAdapterDependencies,
  type ChatGptZeroRiskManualControl,
} from "./adapter";

export {
  CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
  CHATGPT_WEB_COMPACTION_HEARTBEAT_MS,
  chatGptWebExecutionNamespace,
  chatGptWebTraceId,
  type ChatGptZeroRiskManualControl,
};

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: ChatGptAdapterDependencies = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const subagentGovernor = dependencies.subagentGovernor ?? (
    provider.chatgptWeb?.maxConcurrentSubagents !== undefined
      ? new SubagentConcurrencyGovernor(provider.chatgptWeb.maxConcurrentSubagents)
      : defaultSubagentGovernor
  );
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalSkillAttachments = provider.chatgptWeb?.experimentalSkillAttachments;
  if (experimentalSkillAttachments !== undefined && typeof experimentalSkillAttachments !== "boolean") {
    throw new Error("ChatGPT skill attachments preference must be a boolean");
  }
  if (experimentalSkillAttachments && provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Skills as files is unavailable in Zero Risk mode");
  }
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const freshConversationPerTurn = provider.chatgptWeb?.experimentalFreshConversationPerTurn === true;
  if (provider.chatgptWeb?.experimentalFreshConversationPerTurn !== undefined
    && typeof provider.chatgptWeb.experimentalFreshConversationPerTurn !== "boolean") {
    throw new Error("ChatGPT fresh conversation preference must be a boolean");
  }
  if (freshConversationPerTurn && manualInteraction) {
    throw new Error("Fresh browser conversations per turn is available only in automatic mode");
  }
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: { onCompactionProgress?: () => void; onHeartbeat?: () => void } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const sessionActorOwner: { generation?: number } = {};
    const runBrowserTurn = (turn: BrowserTurn): Promise<string> => {
      const manager = dependencies.sessionActorManager;
      if (!manager || !identity.threadId || !identity.turnId) return worker.run(turn);
      const sessionId = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
      const originalSubmitted = turn.onSubmitted;
      return manager.runBrowserTurn(
        sessionId,
        identity.turnId,
        `browser:${traceId}`,
        (onAccepted, onToolBatchObserved, onSurfaceLeased, onSurfaceReleased, onResultReady) => worker.run({
          ...turn,
          onSubmitted: async () => {
            await onAccepted();
            await originalSubmitted?.();
          },
          onToolBatchObserved: async (requestId, revision) => {
            await onToolBatchObserved(requestId, revision);
          },
          onSurfaceLeased,
          onSurfaceReleased,
          onResultReady,
        }),
        generation => { sessionActorOwner.generation = generation; },
      );
    };
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const pendingMissionRequirements = missionRequirements(checkpointInput.parsed.context.messages)
      ?.some(item => item.status !== "verified") ?? false;
    const isSubagent = isChatGptSubagentTurn(checkpointInput.parsed);
    const conversationKey = !parsed._compactionRequest
      && !freshConversationPerTurn
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && retainedLauncherDescriptor
      && !isSubagent
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined;
    const resumeInput = conversationKey
      ? retainedConversationResumeRequest(checkpointInput.parsed)
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
        await worker.releaseConversationContextPressure(conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest, overrides?: Partial<CompileChatGptWebPromptOptions>) => {
      if (manualRequest) return { ...overrides };
      const { input: preflightInput, verdict } = preparePreflightInput(input, turnCapabilities, { experimentalBiggerContext });
      enforcePreflightDeliveryBudget(preflightInput, verdict);
      const shouldPromoteMultipart = experimentalBiggerContext || verdict.actionRequired === "promote_multipart";
      const experimentalMultipartParts = shouldPromoteMultipart
        ? resolveBiggerContextMultipartParts(
            preflightInput,
            turnCapabilities,
            experimentalSkillAttachments,
            verdict.actionRequired === "promote_multipart",
          )
        : undefined;
      return {
        captureLunaCheckpoint,
        experimentalSkillAttachments,
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
        ...overrides,
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        () => {
          const retirement = codexTurnBindingRetiredError();
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = codexTurnBindingObservationFailedError(error);
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    const submissionLifecycle = {
      ...(!parsed._compactionRequest ? {
        onSendActivated: () => {
          if (submission.phase === "prepared") submission.phase = "send_activated";
        },
      } : {}),
      onSubmitted: () => {
        if (!parsed._compactionRequest) submission.phase = "accepted";
        hooks.onCompactionProgress?.();
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? { onMultipartStageAcknowledged: hooks.onCompactionProgress }
      : {};

    if (manualRequest) {
      return createManualTurnRuntime({
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
      });
    }

    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(runBrowserTurn({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
        capabilities: turnCapabilities,
        pendingMissionRequirements,
        prepare: async () => {
          const { input: preflightInput } = preparePreflightInput(checkpointInput.parsed, turnCapabilities, { experimentalBiggerContext });
          const compiled = compileChatGptWebPrompt(
            preflightInput,
            turnCapabilities,
            undefined,
            compileOptionsFor(preflightInput),
          );
          if ("effort" in mode) enforceMissionHeadroom(preflightInput, compiled, mode.effort, turnCapabilities);
          return {
            ...compiled,
            release: () => {},
          };
        },
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(hooks.onHeartbeat ? { onHeartbeat: hooks.onHeartbeat } : {}),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        submission,
        cancel: browserTurn.cancel,
      };
    }

    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    let lastRegisteredToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest, optionsOverrides?: Partial<CompileChatGptWebPromptOptions>) => {
      const predecessor = environment.execution === "host-only" ? undefined : activeToken ?? lastRegisteredToken;
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
        false,
        "turn",
        predecessor,
      );
      activeToken = turnToken;
      lastRegisteredToken = turnToken;
      try {
        const { input: preflightInput } = preparePreflightInput(input, turnCapabilities, { experimentalBiggerContext });
        const compiled = compileChatGptWebPrompt(
          preflightInput,
          turnCapabilities,
          turnToken,
          compileOptionsFor(preflightInput, optionsOverrides),
        );
        if ("effort" in mode) enforceMissionHeadroom(preflightInput, compiled, mode.effort, turnCapabilities);
        observeCapabilityRetirement(turnToken, externalProgress);
        if (typeof broker.waitForClaim === "function") {
          void broker.waitForClaim(turnToken, browserAbort.signal).then(() => {
            externalProgress.recordClaim();
            if (submission && !parsed._compactionRequest) {
              submission.phase = "accepted";
            }
          }).catch(() => {});
        }
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeCheckpoint(runBrowserTurn({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      capabilities: turnCapabilities,
      pendingMissionRequirements,
      prepare: () => prepareWith(checkpointInput.parsed),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput, { continuation: true }) } : {}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      ...multipartProgressLifecycle,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      ...(hooks.onHeartbeat ? { onHeartbeat: hooks.onHeartbeat } : {}),
      externalProgress,
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }))), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      ...(dependencies.sessionActorManager ? { sessionActorOwner } : {}),
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      usageInput: checkpointInput.parsed,
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
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const runChatGptWebTurn = async (): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools || parsed._compactionRequest) {
          try {
            environment = parsed._hostTurn?.environment
              ?? environmentStore.resolve(parsed);
          } catch (error) {
            if (parsed._compactionRequest
              && !mode.localTools
              && error instanceof MissingTrustedCodexEnvironmentError
              && !hasRawChatGptEnvironmentContext(parsed)) {
              environment = undefined;
            } else {
              const identity = extractChatGptTurnIdentity(parsed);
              console.warn(
                `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
              );
              throw error;
            }
          }
        }
        if (environment?.cwd && environment.execution !== "host-only") {
          try {
            let subId: string | undefined;
            if (isChatGptSubagentTurn(parsed)) {
              const lineage = extractChatGptThreadSpawnLineage(parsed);
              subId = lineage?.agentName?.replace(/^\/root\/?/, "").replace(/\//g, "_")
                || extractChatGptTurnIdentity(parsed).turnId
                || "sub_default";
            }
            initializeTurnWorkspace(environment, subId);
          } catch (stateErr) {
            console.warn("[chatgpt-web] best-effort workspace state init failed:", stateErr);
          }
        }

        if (parsed._compactionRequest) {
          const handled = await executeCompactionFlow({
            worker,
            parsed,
            incoming,
            emit,
            configuredCapabilities,
            turnCapabilities,
            manualRequest,
            retainedLauncherDescriptor,
            structuredBroker,
            broker,
            executionNamespace,
            timeoutMs,
            freshConversationPerTurn,
            experimentalBiggerContext,
            experimentalSkillAttachments,
            retryKey,
            environment,
            startRuntime,
            sessionActorManager: dependencies.sessionActorManager,
          });
          if (handled) return;
        }

        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const traceId = chatGptWebTraceId(provider, parsed);
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities, {
            onHeartbeat: () => emit({ type: "heartbeat" }),
          }),
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          chatGptInstructionLineage(parsed),
          retainedLauncherDescriptor ? MAX_CHATGPT_LAUNCHER_PENDING_TURNS : MAX_CHATGPT_BROWSER_TABS,
        );
        const roundKey = chatGptTurnRoundKey(parsed);
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          session.appendRoundEvents(roundKey, events);
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        const sessionActorGeneration = (): number => {
          const generation = session.runtime.sessionActorOwner?.generation;
          if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
            throw new Error("Session actor browser generation is unavailable for tool delivery");
          }
          return generation;
        };
        try {
          await session.runExclusive(async () => {
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                buffer,
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (dependencies.sessionActorManager) {
                    const revision = session.runtime.externalProgress.snapshot().lastToolBatchRevision;
                    for (const request of outstanding) {
                      const recorded = await dependencies.sessionActorManager.recordToolCallPreparation(
                        ownerKey,
                        nativeTurnId,
                        `browser:${traceId}`,
                        request.callId,
                        revision,
                        sessionActorGeneration(),
                      );
                      if (recorded.status !== "accepted") {
                        throw new Error(`Session actor tool emission requires recovery: ${recorded.status}`);
                      }
                    }
                  }
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                    buffer,
                  ));
                  if (dependencies.sessionActorManager) {
                    const revision = session.runtime.externalProgress.snapshot().lastToolBatchRevision;
                    for (const request of outstanding) {
                      const recorded = await dependencies.sessionActorManager.recordToolCallEmission(
                        ownerKey,
                        nativeTurnId,
                        `browser:${traceId}`,
                        request.callId,
                        revision,
                        sessionActorGeneration(),
                      );
                      if (recorded.status !== "accepted") {
                        throw new Error(`Session actor tool emission requires recovery: ${recorded.status}`);
                      }
                    }
                  }
                  if (broker.recordToolLifecyclePhase) {
                    await Promise.all(outstanding.map(request => broker.recordToolLifecyclePhase!(
                      turnToken!,
                      request.callId,
                      "codex_emitted",
                      "adapter_replayed_tool_call",
                    )));
                  }
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                for (const message of results) {
                  const result = brokerResult(message);
                  if (dependencies.sessionActorManager) {
                    await dependencies.sessionActorManager.deliverToolResult(
                      ownerKey,
                      nativeTurnId,
                      `browser:${traceId}`,
                      message.toolCallId,
                      JSON.stringify(result),
                      () => broker.completeTool(turnToken!, message.toolCallId, result),
                      sessionActorGeneration(),
                    );
                  } else {
                    await broker.completeTool(turnToken, message.toolCallId, result);
                  }
                  session.runtime.externalProgress.recordToolResult();
                  session.markResultDelivered(message.toolCallId);
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    externalProgress.recordClaim();
                    if (session.runtime.submission && !parsed._compactionRequest) {
                      session.runtime.submission.phase = "accepted";
                    }
                    const revision = externalProgress.recordToolBatch(requests.length);
                    if (!session.runtime.manualControl) {
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                        undefined,
                        () => console.warn(JSON.stringify({
                          event: "tool_batch_observation_slow",
                          traceId,
                          revision,
                          thresholdMs: 10_000,
                        })),
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                    if (dependencies.sessionActorManager) {
                      const confirmed = await dependencies.sessionActorManager.recordToolBatchConfirmed(
                        ownerKey,
                        nativeTurnId,
                        `browser:${traceId}`,
                        revision,
                        sessionActorGeneration(),
                      );
                      if (confirmed.status !== "accepted") {
                        throw new Error(`Session actor tool batch requires recovery: ${confirmed.status}`);
                      }
                    }
                    if (broker.recordToolLifecyclePhase) {
                      await Promise.all(requests.map(request => broker.recordToolLifecyclePhase!(
                        turnToken,
                        request.callId,
                        "browser_observed",
                        "browser_acknowledged_tool_boundary",
                      )));
                    }
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (turnToken) await broker.revoke(turnToken);
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(completedOutcome.answer);
                if (bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                if (dependencies.sessionActorManager) {
                  const revision = externalProgress.snapshot().lastToolBatchRevision;
                  for (const request of next.requests) {
                    const recorded = await dependencies.sessionActorManager.recordToolCallPreparation(
                      ownerKey,
                      nativeTurnId,
                      `browser:${traceId}`,
                      request.callId,
                      revision,
                      sessionActorGeneration(),
                    );
                    if (recorded.status !== "accepted") {
                      throw new Error(`Session actor tool emission requires recovery: ${recorded.status}`);
                    }
                  }
                }
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                if (dependencies.sessionActorManager) {
                  const revision = externalProgress.snapshot().lastToolBatchRevision;
                  for (const request of next.requests) {
                    const recorded = await dependencies.sessionActorManager.recordToolCallEmission(
                      ownerKey,
                      nativeTurnId,
                      `browser:${traceId}`,
                      request.callId,
                      revision,
                      sessionActorGeneration(),
                    );
                    if (recorded.status !== "accepted") {
                      throw new Error(`Session actor tool emission requires recovery: ${recorded.status}`);
                    }
                  }
                }
                if (broker.recordToolLifecyclePhase) {
                  await Promise.all(next.requests.map(request => broker.recordToolLifecyclePhase!(
                    turnToken,
                    request.callId,
                    "codex_emitted",
                    "adapter_emitted_tool_call",
                  )));
                }
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          });
        } catch (error) {
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl) {
              chatGptTurnSessions.retire(executionKey, session);
            }
            throw error;
          }
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            if (handledError.code === "context_compaction_required"
              || handledError.code === "chatgpt_tool_boundary_observation_timeout"
              || handledError.code === "chatgpt_browser_dom_unresponsive") {
              emitRoundEvent({
                type: "milestone",
                kind: "intervention_required",
                result: "Browser delivery stopped",
                evidence: handledError.code,
                nextStep: handledError.code === "context_compaction_required"
                  ? "Compact the Codex context, then retry"
                  : "Inspect the retained browser page before retrying",
              });
            }
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      const isSubagent = isChatGptSubagentTurn(parsed);
      let releaseSubagentPermit: (() => void) | undefined;
      try {
        if (isSubagent) {
          releaseSubagentPermit = await subagentGovernor.acquire(incoming.abortSignal);
        }
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
        releaseSubagentPermit?.();
      }
    },
  };
}
