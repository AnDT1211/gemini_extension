// tests/bridge.test.ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import http2 from "node:http";
import WebSocket2 from "ws";

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

// tests/bridge.test.ts
describe("Local HTTP Bridge + WebSocket Server Integration Tests", () => {
  let httpServer;
  let wsServer;
  let requestManager;
  let port;
  let baseUrl;
  let wsUrl;
  before((context, done) => {
    requestManager = new RequestManager();
    const config = getBridgeConfig();
    config.port = 0;
    config.requestTimeoutMs = 1e3;
    let serverInstance = null;
    httpServer = createBridgeHttpServer(config, requestManager, () => serverInstance);
    wsServer = new BridgeWebSocketServer(httpServer, requestManager);
    serverInstance = wsServer;
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (typeof addr === "object" && addr !== null) {
        port = addr.port;
        baseUrl = `http://127.0.0.1:${port}`;
        wsUrl = `ws://127.0.0.1:${port}/ws`;
      }
      done();
    });
  });
  after((context, done) => {
    wsServer.close().then(() => {
      httpServer.close(() => done());
    });
  });
  function makeHttpRequest(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const bodyStr = typeof body === "object" ? JSON.stringify(body) : body;
      const req = http2.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers
          }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            let parsedBody = data;
            try {
              parsedBody = JSON.parse(data);
            } catch {
            }
            resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: parsedBody });
          });
        }
      );
      req.on("error", reject);
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }
  test("1. GET /health returns 200 with status ok", async () => {
    const res = await makeHttpRequest("GET", "/health");
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { status: "ok" });
  });
  test("2. POST /ask with invalid body returns 400", async () => {
    const res1 = await makeHttpRequest("POST", "/ask", {});
    assert.strictEqual(res1.statusCode, 400);
    assert.strictEqual(res1.body.success, false);
    assert.strictEqual(res1.body.error.code, "INVALID_REQUEST");
    const res2 = await makeHttpRequest("POST", "/ask", { prompt: "   " });
    assert.strictEqual(res2.statusCode, 400);
    const res3 = await makeHttpRequest("POST", "/ask", "plain text", { "Content-Type": "text/plain" });
    assert.strictEqual(res3.statusCode, 400);
  });
  test("3. POST /ask returns 503 if extension is disconnected", async () => {
    assert.strictEqual(wsServer.isExtensionConnected(), false);
    const res = await makeHttpRequest("POST", "/ask", { prompt: "Test prompt" });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, "EXTENSION_NOT_CONNECTED");
  });
  test("4. WebSocket connection updates extension status in /status", async () => {
    const statusBefore = await makeHttpRequest("GET", "/status");
    assert.strictEqual(statusBefore.body.extensionConnected, false);
    const ws = new WebSocket2(wsUrl);
    await new Promise((resolve) => ws.on("open", resolve));
    const statusAfter = await makeHttpRequest("GET", "/status");
    assert.strictEqual(statusAfter.body.extensionConnected, true);
    assert.ok(statusAfter.body.connectedAt);
    ws.close();
    await new Promise((resolve) => ws.on("close", resolve));
  });
  test("5. HTTP request is correlated with correct WebSocket response", async () => {
    const ws = new WebSocket2(wsUrl);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ASK_GEMINI") {
        const response = {
          type: "ASK_GEMINI_RESULT",
          requestId: msg.requestId,
          success: true,
          answer: `Echo response for: ${msg.prompt}`
        };
        ws.send(JSON.stringify(response));
      }
    });
    const res = await makeHttpRequest("POST", "/ask", { prompt: "Explain virtual threads" });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.answer, "Echo response for: Explain virtual threads");
    assert.ok(res.body.requestId.startsWith("req_"));
    ws.close();
    await new Promise((resolve) => ws.on("close", resolve));
  });
  test("6. Multiple concurrent requests resolve to the correct caller", async () => {
    const ws = new WebSocket2(wsUrl);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ASK_GEMINI") {
        setTimeout(() => {
          const response = {
            type: "ASK_GEMINI_RESULT",
            requestId: msg.requestId,
            success: true,
            answer: `Response for ${msg.prompt}`
          };
          ws.send(JSON.stringify(response));
        }, Math.floor(Math.random() * 50) + 10);
      }
    });
    const prompts = ["Prompt Alpha", "Prompt Beta", "Prompt Gamma", "Prompt Delta"];
    const requests = prompts.map((p) => makeHttpRequest("POST", "/ask", { prompt: p }));
    const results = await Promise.all(requests);
    for (let i = 0; i < prompts.length; i++) {
      assert.strictEqual(results[i].statusCode, 200);
      assert.strictEqual(results[i].body.success, true);
      assert.strictEqual(results[i].body.answer, `Response for ${prompts[i]}`);
    }
    ws.close();
    await new Promise((resolve) => ws.on("close", resolve));
  });
  test("7. Request timeout cleans up pending state", async () => {
    const ws = new WebSocket2(wsUrl);
    await new Promise((resolve) => ws.on("open", resolve));
    const res = await makeHttpRequest("POST", "/ask", { prompt: "Will timeout" });
    assert.strictEqual(res.statusCode, 504);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, "BRIDGE_TIMEOUT");
    assert.strictEqual(requestManager.getPendingCount(), 0);
    ws.close();
    await new Promise((resolve) => ws.on("close", resolve));
  });
  test("8. Extension disconnect rejects pending requests with WEBSOCKET_DISCONNECTED", async () => {
    const ws = new WebSocket2(wsUrl);
    await new Promise((resolve) => ws.on("open", resolve));
    const pendingHttpReq = makeHttpRequest("POST", "/ask", { prompt: "Will disconnect" });
    await new Promise((r) => setTimeout(r, 50));
    ws.close();
    const res = await pendingHttpReq;
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, "WEBSOCKET_DISCONNECTED");
    assert.strictEqual(requestManager.getPendingCount(), 0);
  });
  test("9. Unknown requestId does not crash the bridge", async () => {
    const ws = new WebSocket2(wsUrl);
    await new Promise((resolve) => ws.on("open", resolve));
    const unknownResponse = {
      type: "ASK_GEMINI_RESULT",
      requestId: "req_non_existent_12345",
      success: true,
      answer: "Spurious answer"
    };
    assert.doesNotThrow(() => {
      ws.send(JSON.stringify(unknownResponse));
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsServer.isExtensionConnected(), true);
    ws.close();
    await new Promise((resolve) => ws.on("close", resolve));
  });
  test("10. Malformed WebSocket JSON does not crash the bridge", async () => {
    const ws = new WebSocket2(wsUrl);
    await new Promise((resolve) => ws.on("open", resolve));
    assert.doesNotThrow(() => {
      ws.send("invalid json payload { [");
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsServer.isExtensionConnected(), true);
    ws.close();
    await new Promise((resolve) => ws.on("close", resolve));
  });
});
