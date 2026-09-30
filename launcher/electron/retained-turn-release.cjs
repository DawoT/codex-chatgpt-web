function releaseRetainedConversation(host, conversationKey) {
  const retained = [...host.turnTabs.values()].filter(
    (tab) => tab.status === "ready" && tab.conversationKey === conversationKey,
  );
  for (const tab of retained) {
    host.removeTurnTab(tab, false);
    host.logger.info("browser.tab_released", {
      tabId: tab.id,
      traceId: tab.traceId,
      status: tab.status,
      reason: "retained_conversation_superseded",
    });
  }
  return retained.length;
}

function releaseRetainedSurface(host, surfaceId) {
  const matching = [...host.turnTabs.values()].filter((tab) => tab.surfaceId === surfaceId);
  for (const tab of matching) {
    host.removeTurnTab(tab, true);
    host.logger.info("browser.tab_released", {
      tabId: tab.id,
      traceId: tab.traceId,
      status: tab.status,
      reason: "retained_surface_released",
    });
  }
  return matching.length;
}

module.exports = { releaseRetainedConversation, releaseRetainedSurface };
