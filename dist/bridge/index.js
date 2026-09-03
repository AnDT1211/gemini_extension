// bridge-server/config.ts
function getBridgeConfig() {
  return {
    host: process.env.GEMINI_BRIDGE_HOST || "127.0.0.1",
    port: parseInt(process.env.GEMINI_BRIDGE_PORT || "3456", 10),
    requestTimeoutMs: parseInt(process.env.GEMINI_BRIDGE_REQUEST_TIMEOUT_MS || "120000", 10),
    maxPromptLength: parseInt(process.env.GEMINI_BRIDGE_MAX_PROMPT_LENGTH || "50000", 10),
    authToken: process.env.GEMINI_BRIDGE_TOKEN || "",
    corsOrigin: process.env.GEMINI_BRIDGE_CORS_ORIGIN || ""
  };
}

// bridge-server/logger.ts
var BridgeServerLogger = class {
  scope;
  constructor(scope = "BridgeServer") {
    this.scope = scope;
  }
  log(message, ...extra) {
    console.log(`[${this.scope}][${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`, ...extra);
  }
  warn(message, ...extra) {
    console.warn(`[${this.scope}][${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`, ...extra);
  }
  error(message, ...extra) {
    console.error(`[${this.scope}][${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`, ...extra);
  }
  req(requestId, message, ...extra) {
    console.log(`[${this.scope}][${requestId}][${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`, ...extra);
  }
};

// bridge-server/request-manager.ts
var RequestManager = class {
  pendingRequests = /* @__PURE__ */ new Map();
  logger = new BridgeServerLogger("RequestManager");
  createPendingRequest(requestId, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.pendingRequests.has(requestId)) {
        reject({
          statusCode: 400,
          code: "INVALID_REQUEST",
          message: `Duplicate requestId: ${requestId}`
        });
        return;
      }
      const timeoutTimer = setTimeout(() => {
        this.logger.req(requestId, `Request timed out after ${timeoutMs}ms`);
        this.pendingRequests.delete(requestId);
        reject({
          statusCode: 504,
          code: "BRIDGE_TIMEOUT",
          message: `Request timed out after ${timeoutMs}ms waiting for Gemini response.`
        });
      }, timeoutMs);
      const pendingReq = {
        requestId,
        resolve,
        reject,
        timeoutTimer,
        createdAt: Date.now()
      };
      this.pendingRequests.set(requestId, pendingReq);
      this.logger.req(requestId, `Registered pending request (total active: ${this.pendingRequests.size})`);
    });
  }
  resolveRequest(requestId, response) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.logger.warn(`Received response for unknown or already completed requestId: ${requestId}`);
      return false;
    }
    clearTimeout(pending.timeoutTimer);
    this.pendingRequests.delete(requestId);
    this.logger.req(requestId, "Successfully resolved pending request.");
    pending.resolve(response);
    return true;
  }
  rejectRequest(requestId, error) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeoutTimer);
    this.pendingRequests.delete(requestId);
    this.logger.req(requestId, `Rejected request with code ${error.code}: ${error.message}`);
    pending.reject(error);
    return true;
  }
  rejectAllPendingRequests(error) {
    if (this.pendingRequests.size === 0) {
      return;
    }
    this.logger.warn(`Rejecting all ${this.pendingRequests.size} pending request(s) due to error: ${error.code}`);
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutTimer);
      pending.reject(error);
      this.logger.req(requestId, `Rejected during bulk disconnect/cleanup: ${error.message}`);
    }
    this.pendingRequests.clear();
  }
  getPendingCount() {
    return this.pendingRequests.size;
  }
};

// bridge-server/http-server.ts
import http from "http";
import { randomUUID } from "crypto";
function createBridgeHttpServer(config, requestManager, getWsServer) {
  const logger = new BridgeServerLogger("HttpServer");
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (config.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;
    if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (pathname === "/status" && req.method === "GET") {
      const wsServer = getWsServer();
      const isConnected = wsServer ? wsServer.isExtensionConnected() : false;
      const connectedAt = wsServer ? wsServer.getConnectedAt() : null;
      res.writeHead(200);
      res.end(
        JSON.stringify({
          bridgeServer: "ready",
          extensionConnected: isConnected,
          connectedAt
        })
      );
      return;
    }
    if (pathname === "/ask" && req.method === "POST") {
      handleAskRequest(req, res, config, requestManager, getWsServer, logger);
      return;
    }
    res.writeHead(404);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Endpoint not found: ${req.method} ${pathname}`
        }
      })
    );
  });
  return server;
}
async function handleAskRequest(req, res, config, requestManager, getWsServer, logger) {
  if (config.authToken) {
    const authHeader = req.headers["authorization"];
    const expectedAuth = `Bearer ${config.authToken}`;
    if (!authHeader || authHeader !== expectedAuth) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid or missing Bearer authorization token"
          }
        })
      );
      return;
    }
  }
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("application/json")) {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Content-Type must be application/json"
        }
      })
    );
    return;
  }
  let bodyStr = "";
  try {
    bodyStr = await readRequestBody(req, config.maxPromptLength * 2);
  } catch (readErr) {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: readErr instanceof Error ? readErr.message : "Failed to read request body"
        }
      })
    );
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Malformed JSON payload"
        }
      })
    );
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: "JSON body must be an object"
        }
      })
    );
    return;
  }
  const payload = parsed;
  if (typeof payload.prompt !== "string" || payload.prompt.trim() === "") {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Prompt must be a non-empty string"
        }
      })
    );
    return;
  }
  if (payload.prompt.length > config.maxPromptLength) {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Prompt exceeds maximum allowed length of ${config.maxPromptLength} characters`
        }
      })
    );
    return;
  }
  let wsServer = getWsServer();
  if (!wsServer || !wsServer.isExtensionConnected()) {
    const startWait = Date.now();
    while (Date.now() - startWait < 3e3) {
      await new Promise((r) => setTimeout(r, 100));
      wsServer = getWsServer();
      if (wsServer && wsServer.isExtensionConnected()) {
        break;
      }
    }
  }
  if (!wsServer || !wsServer.isExtensionConnected()) {
    res.writeHead(503);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "EXTENSION_NOT_CONNECTED",
          message: "Chrome extension is not connected to the local bridge"
        }
      })
    );
    return;
  }
  const requestId = `req_${randomUUID()}`;
  logger.req(requestId, `HTTP POST /ask received (prompt length: ${payload.prompt.length})`);
  const bridgeReq = {
    type: "ASK_GEMINI",
    requestId,
    prompt: payload.prompt,
    options: typeof payload.options === "object" && payload.options !== null ? payload.options : void 0
  };
  const pendingPromise = requestManager.createPendingRequest(requestId, config.requestTimeoutMs);
  const sent = wsServer.sendToExtension(bridgeReq);
  if (!sent) {
    requestManager.rejectRequest(requestId, {
      statusCode: 503,
      code: "EXTENSION_NOT_CONNECTED",
      message: "Failed to dispatch request to extension WebSocket"
    });
  }
  try {
    const result = await pendingPromise;
    res.writeHead(200);
    const outputPayload = {
      success: result.success,
      requestId: result.requestId,
      ...result.success ? { answer: result.answer } : { error: result.error }
    };
    res.end(JSON.stringify(outputPayload));
  } catch (err) {
    const httpErr = err;
    const statusCode = httpErr.statusCode || 500;
    const errorCode = httpErr.code || "INTERNAL_ERROR";
    const message = httpErr.message || "An internal bridge error occurred";
    res.writeHead(statusCode);
    res.end(
      JSON.stringify({
        success: false,
        requestId,
        error: {
          code: errorCode,
          message
        }
      })
    );
  }
}
function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytesRead = 0;
    req.on("data", (chunk) => {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        req.destroy();
        reject(new Error(`Payload size exceeds maximum allowed size of ${maxBytes} bytes`));
        return;
      }
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

// bridge-server/websocket-server.ts
import { WebSocketServer, WebSocket } from "ws";
var BridgeWebSocketServer = class {
  wss;
  activeSocket = null;
  connectedAt = null;
  requestManager;
  logger = new BridgeServerLogger("WebSocketServer");
  constructor(server, requestManager) {
    this.requestManager = requestManager;
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      this.handleConnection(ws);
    });
  }
  isExtensionConnected() {
    return this.activeSocket !== null && this.activeSocket.readyState === WebSocket.OPEN;
  }
  getConnectedAt() {
    return this.connectedAt;
  }
  sendToExtension(message) {
    if (!this.isExtensionConnected() || !this.activeSocket) {
      this.logger.warn("Attempted to send message to extension, but extension is not connected.");
      return false;
    }
    try {
      this.activeSocket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.logger.error("Failed to send WebSocket message to extension:", err);
      return false;
    }
  }
  close() {
    return new Promise((resolve) => {
      if (this.activeSocket) {
        this.activeSocket.close();
        this.activeSocket = null;
      }
      this.wss.close(() => resolve());
    });
  }
  handleConnection(ws) {
    this.logger.log("New extension WebSocket client connected.");
    if (this.activeSocket && this.activeSocket !== ws) {
      this.logger.warn("Replacing existing active extension connection with new connection.");
      try {
        this.activeSocket.close(1e3, "Replaced by new extension connection");
      } catch {
      }
    }
    this.activeSocket = ws;
    this.connectedAt = (/* @__PURE__ */ new Date()).toISOString();
    ws.on("message", (data) => {
      this.handleMessage(data.toString());
    });
    ws.on("close", (code, reason) => {
      this.logger.warn(`Extension WebSocket connection closed (code: ${code}, reason: ${reason.toString() || "none"})`);
      if (this.activeSocket === ws) {
        this.activeSocket = null;
        this.connectedAt = null;
        this.requestManager.rejectAllPendingRequests({
          statusCode: 502,
          code: "WEBSOCKET_DISCONNECTED",
          message: "Chrome extension WebSocket connection was closed unexpectedly during request execution."
        });
      }
    });
    ws.on("error", (err) => {
      this.logger.error("Extension WebSocket encountered an error:", err);
    });
  }
  handleMessage(rawMessage) {
    let parsed;
    try {
      parsed = JSON.parse(rawMessage);
    } catch (err) {
      this.logger.error("Received malformed non-JSON payload from extension WebSocket:", rawMessage, err);
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      this.logger.warn("Received invalid message schema from extension WebSocket:", parsed);
      return;
    }
    const msg = parsed;
    if (msg.type === "HELLO") {
      const helloMsg = msg;
      this.logger.log(`Extension handshake received from source: ${helloMsg.source}`);
      return;
    }
    if (msg.type === "PING") {
      this.sendToExtension({ type: "PONG" });
      return;
    }
    if (msg.type === "PONG") {
      return;
    }
    if (msg.type === "ASK_GEMINI_RESULT") {
      const resultMsg = msg;
      this.logger.req(resultMsg.requestId, `Received response from extension (success=${resultMsg.success})`);
      this.requestManager.resolveRequest(resultMsg.requestId, resultMsg);
      return;
    }
    this.logger.warn(`Received unknown message type over WebSocket: ${msg.type}`);
  }
};

// bridge-server/index.ts
async function startServer() {
  const logger = new BridgeServerLogger("Main");
  const config = getBridgeConfig();
  const requestManager = new RequestManager();
  let wsServer = null;
  const httpServer = createBridgeHttpServer(
    config,
    requestManager,
    () => wsServer
  );
  wsServer = new BridgeWebSocketServer(httpServer, requestManager);
  httpServer.listen(config.port, config.host, () => {
    logger.log(`=======================================================`);
    logger.log(`Gemini Bridge Server running at http://${config.host}:${config.port}`);
    logger.log(`WebSocket endpoint available at ws://${config.host}:${config.port}/ws`);
    logger.log(`Health endpoint: GET http://${config.host}:${config.port}/health`);
    logger.log(`Status endpoint: GET http://${config.host}:${config.port}/status`);
    logger.log(`Ask API endpoint: POST http://${config.host}:${config.port}/ask`);
    logger.log(`=======================================================`);
  });
  const shutdown = async (signal) => {
    logger.log(`Received ${signal}. Shutting down bridge server gracefully...`);
    requestManager.rejectAllPendingRequests({
      statusCode: 503,
      code: "INTERNAL_ERROR",
      message: "Bridge server is shutting down."
    });
    if (wsServer) {
      await wsServer.close();
    }
    httpServer.close(() => {
      logger.log("HTTP server closed. Shutdown complete.");
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
startServer().catch((err) => {
  console.error("[GeminiBridgeServer] Critical startup failure:", err);
  process.exit(1);
});
