// src/background/tabFinder.ts
async function findGeminiTab() {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (!tabs || tabs.length === 0) {
    return null;
  }
  const activeTab = tabs.find((t) => t.active);
  if (activeTab) {
    return activeTab;
  }
  const sortedByRecent = [...tabs].sort((a, b) => {
    const timeA = a.lastAccessed ?? 0;
    const timeB = b.lastAccessed ?? 0;
    return timeB - timeA;
  });
  if (sortedByRecent[0] && (sortedByRecent[0].lastAccessed ?? 0) > 0) {
    return sortedByRecent[0];
  }
  return tabs[0] ?? null;
}

// src/shared/errors.ts
function createErrorResponse(requestId, error, details) {
  return {
    requestId,
    status: "error",
    error,
    ...details ? { details } : {}
  };
}

// src/shared/logger.ts
var GeminiLogger = class {
  requestId;
  constructor(requestId = "GLOBAL") {
    this.requestId = requestId;
  }
  log(message, ...extra) {
    console.log(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }
  warn(message, ...extra) {
    console.warn(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }
  error(message, ...extra) {
    console.error(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }
  logDiagnostics(contextName, candidates) {
    console.groupCollapsed(`[GeminiBridge][${this.requestId}] DOM Detection Diagnostics: ${contextName}`);
    for (const c of candidates) {
      console.log(`Selector: "${c.selector}" -> Matched ${c.matchCount} element(s)`);
    }
    console.groupEnd();
  }
};

// src/background/askGemini.ts
var activeTabRequests = /* @__PURE__ */ new Map();
async function askGemini(prompt, options = {}) {
  const requestId = crypto.randomUUID();
  const logger = new GeminiLogger(requestId);
  logger.log(`Received askGemini request for prompt length: ${prompt.length}`);
  await chrome.storage.local.set({
    latestStatus: {
      state: "working",
      requestId,
      prompt,
      timestamp: Date.now()
    }
  });
  const tab = await findGeminiTab();
  if (!tab || !tab.id) {
    logger.warn("No active/open Gemini tab found.");
    const errorRes = createErrorResponse(requestId, "GEMINI_TAB_NOT_FOUND", "No open gemini.google.com tab detected.");
    await chrome.storage.local.set({
      latestStatus: { state: "completed", requestId, response: errorRes, timestamp: Date.now() }
    });
    return errorRes;
  }
  const tabId = tab.id;
  logger.log(`Selected Gemini tab ID: ${tabId} (${tab.title || tab.url})`);
  if (activeTabRequests.has(tabId)) {
    const existingReqId = activeTabRequests.get(tabId);
    logger.warn(`Tab ${tabId} is currently busy with request: ${existingReqId}`);
    const busyRes = createErrorResponse(
      requestId,
      "GEMINI_BUSY",
      `Tab ${tabId} is currently executing request ${existingReqId}`
    );
    await chrome.storage.local.set({
      latestStatus: { state: "completed", requestId, response: busyRes, timestamp: Date.now() }
    });
    return busyRes;
  }
  activeTabRequests.set(tabId, requestId);
  try {
    const message = {
      type: "EXECUTE_GEMINI_PROMPT",
      requestId,
      prompt,
      timeoutMs: options.timeoutMs,
      stabilizationMs: options.stabilizationMs
    };
    let response;
    try {
      logger.log(`Sending EXECUTE_GEMINI_PROMPT to content script on tab ${tabId}...`);
      response = await chrome.tabs.sendMessage(tabId, message);
      logger.log(`Received result from content script on tab ${tabId}:`, response);
    } catch (sendErr) {
      logger.warn("Content script not reachable. Attempting scripting fallback injection...", sendErr);
      let injectionSuccess = false;
      for (const scriptPath of ["dist/content.js", "content.js"]) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [scriptPath]
          });
          injectionSuccess = true;
          logger.log(`Successfully injected content script via: ${scriptPath}`);
          break;
        } catch {
        }
      }
      if (injectionSuccess) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          response = await chrome.tabs.sendMessage(tabId, message);
          logger.log(`Received result from content script post-injection on tab ${tabId}:`, response);
        } catch (retryErr) {
          logger.error("Failed to communicate after content script injection:", retryErr);
          response = createErrorResponse(
            requestId,
            "CONTENT_SCRIPT_NOT_AVAILABLE",
            `Could not communicate with content script on tab ${tabId}. Please refresh (F5) the Gemini browser tab.`
          );
        }
      } else {
        logger.error("Failed to inject content script using any path candidate.");
        response = createErrorResponse(
          requestId,
          "CONTENT_SCRIPT_NOT_AVAILABLE",
          `Could not inject content script on tab ${tabId}. Please refresh (F5) the Gemini browser tab.`
        );
      }
    }
    if (!response) {
      response = createErrorResponse(requestId, "UNKNOWN_ERROR", "Received empty response from content script.");
    }
    await chrome.storage.local.set({
      latestStatus: {
        state: "completed",
        requestId,
        response,
        timestamp: Date.now()
      }
    });
    return response;
  } catch (err) {
    logger.error("Unexpected error in askGemini background execution:", err);
    const errRes = createErrorResponse(
      requestId,
      "UNKNOWN_ERROR",
      err instanceof Error ? err.message : String(err)
    );
    await chrome.storage.local.set({
      latestStatus: { state: "completed", requestId, response: errRes, timestamp: Date.now() }
    });
    return errRes;
  } finally {
    activeTabRequests.delete(tabId);
    logger.log(`Released concurrency lock for tab ${tabId}`);
  }
}

// src/background/index.ts
self.askGemini = askGemini;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ASK_GEMINI_REQUEST") {
    console.log(`[GeminiBridge] Background worker received ASK_GEMINI_REQUEST: ${message.requestId}`);
    askGemini(message.prompt, message.options).then((result) => {
      console.log(`[GeminiBridge] Background sending result to popup/caller for ${message.requestId}:`, result);
      sendResponse(result);
    }).catch((err) => {
      console.error(`[GeminiBridge] Background error handling ${message.requestId}:`, err);
      sendResponse({
        requestId: message.requestId,
        status: "error",
        error: "UNKNOWN_ERROR",
        details: err instanceof Error ? err.message : String(err)
      });
    });
    return true;
  }
  if (message.type === "GEMINI_PING") {
    sendResponse({ type: "GEMINI_PONG" });
    return false;
  }
  return false;
});
console.log("[GeminiBridge] Background Service Worker initialized.");
