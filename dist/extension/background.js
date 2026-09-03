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

// src/background/bridge-websocket-client.ts
var BridgeWebSocketClient = class {
  url;
  ws = null;
  state = "DISCONNECTED";
  reconnectAttempt = 0;
  reconnectTimer = null;
  pingTimer = null;
  backoffIntervals = [1e3, 2e3, 3e3, 5e3];
  logger;
  constructor(url = "ws://127.0.0.1:3456/ws") {
    this.url = url;
    this.logger = new GeminiLogger("WS_CLIENT");
  }
  getState() {
    return this.state;
  }
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      this.logger.log("WebSocket connection already active or connecting. Skipping duplicate connect.");
      return;
    }
    this.setState(this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING");
    this.logger.log(`Connecting to bridge WebSocket server at ${this.url}... (Attempt ${this.reconnectAttempt + 1})`);
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.logger.log("WebSocket connected to bridge server successfully.");
        this.setState("CONNECTED");
        this.reconnectAttempt = 0;
        const hello = {
          type: "HELLO",
          source: "extension"
        };
        this.send(hello);
        this.startHeartbeat();
      };
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      this.ws.onerror = (event) => {
        this.logger.warn("WebSocket error encountered:", event);
      };
      this.ws.onclose = (event) => {
        this.logger.warn(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason || "None"}`);
        this.stopHeartbeat();
        this.cleanupSocket();
        this.scheduleReconnect();
      };
    } catch (err) {
      this.logger.error("Failed to instantiate WebSocket:", err);
      this.stopHeartbeat();
      this.cleanupSocket();
      this.scheduleReconnect();
    }
  }
  disconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setState("DISCONNECTED");
    this.reconnectAttempt = 0;
    this.logger.log("WebSocket client disconnected explicitly.");
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: "PING" });
      }
    }, 2e4);
  }
  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.logger.error("Cannot send message, WebSocket is not open.");
    }
  }
  async handleMessage(rawMessage) {
    let parsed;
    try {
      parsed = JSON.parse(rawMessage);
    } catch (err) {
      this.logger.error("Received non-JSON message over WebSocket:", rawMessage, err);
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      this.logger.warn("Received invalid message schema over WebSocket:", parsed);
      return;
    }
    const msg = parsed;
    if (msg.type === "PONG") {
      return;
    }
    if (msg.type === "PING") {
      this.send({ type: "PONG" });
      return;
    }
    if (msg.type === "ASK_GEMINI") {
      const requestId = msg.requestId;
      const reqLogger = new GeminiLogger(requestId);
      reqLogger.log("Received ASK_GEMINI prompt via WebSocket bridge.");
      try {
        const result = await askGemini(msg.prompt, msg.options);
        let bridgeResponse;
        if (result.status === "success") {
          bridgeResponse = {
            type: "ASK_GEMINI_RESULT",
            requestId,
            success: true,
            answer: result.content
          };
        } else {
          bridgeResponse = {
            type: "ASK_GEMINI_RESULT",
            requestId,
            success: false,
            error: {
              code: result.error || "UNKNOWN_ERROR",
              message: result.details || result.error || "An error occurred during Gemini interaction."
            }
          };
        }
        reqLogger.log(`Sending ASK_GEMINI_RESULT back via WebSocket (success=${bridgeResponse.success})`);
        this.send(bridgeResponse);
      } catch (err) {
        reqLogger.error("Unhandled error processing ASK_GEMINI in WebSocket client:", err);
        const errResponse = {
          type: "ASK_GEMINI_RESULT",
          requestId,
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : String(err)
          }
        };
        this.send(errResponse);
      }
    } else {
      this.logger.warn(`Received unexpected message type: ${msg.type}`);
    }
  }
  scheduleReconnect() {
    this.setState("RECONNECTING");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    const backoffIndex = Math.min(this.reconnectAttempt, this.backoffIntervals.length - 1);
    const delayMs = this.backoffIntervals[backoffIndex];
    this.reconnectAttempt++;
    this.logger.log(`Scheduling reconnect in ${delayMs}ms (attempt ${this.reconnectAttempt})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
  cleanupSocket() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws = null;
    }
  }
  setState(newState) {
    if (this.state !== newState) {
      this.logger.log(`WebSocket client state transition: ${this.state} -> ${newState}`);
      this.state = newState;
    }
  }
};

// src/background/index.ts
self.askGemini = askGemini;
var bridgeClient = new BridgeWebSocketClient();
bridgeClient.connect();
self.bridgeClient = bridgeClient;
try {
  chrome.alarms.create("bridge_reconnect_alarm", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "bridge_reconnect_alarm") {
      if (bridgeClient.getState() !== "CONNECTED") {
        console.log("[GeminiBridge] Periodic alarm triggered connection check.");
        bridgeClient.connect();
      }
    }
  });
} catch {
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "gemini-keepalive") {
    port.onDisconnect.addListener(() => {
      if (bridgeClient.getState() !== "CONNECTED") {
        bridgeClient.connect();
      }
    });
  }
});
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
