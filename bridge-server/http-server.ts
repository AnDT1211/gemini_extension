import http, { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { BridgeAskRequest } from '../src/shared/bridge-protocol.js';
import { BridgeServerConfig, BridgeHttpError } from './types.js';
import { RequestManager } from './request-manager.js';
import { BridgeWebSocketServer } from './websocket-server.js';
import { BridgeServerLogger } from './logger.js';

export function createBridgeHttpServer(
  config: BridgeServerConfig,
  requestManager: RequestManager,
  getWsServer: () => BridgeWebSocketServer | null
): http.Server {
  const logger = new BridgeServerLogger('HttpServer');

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    // Set basic headers
    res.setHeader('Content-Type', 'application/json');

    // CORS handling if configured
    if (config.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    // Route: GET /health
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Route: GET /status
    if (pathname === '/status' && req.method === 'GET') {
      const wsServer = getWsServer();
      const isConnected = wsServer ? wsServer.isExtensionConnected() : false;
      const connectedAt = wsServer ? wsServer.getConnectedAt() : null;

      res.writeHead(200);
      res.end(
        JSON.stringify({
          bridgeServer: 'ready',
          extensionConnected: isConnected,
          connectedAt
        })
      );
      return;
    }

    // Route: POST /ask
    if (pathname === '/ask' && req.method === 'POST') {
      handleAskRequest(req, res, config, requestManager, getWsServer, logger);
      return;
    }

    // Default: 404 Not Found
    res.writeHead(404);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: `Endpoint not found: ${req.method} ${pathname}`
        }
      })
    );
  });

  return server;
}

async function handleAskRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeServerConfig,
  requestManager: RequestManager,
  getWsServer: () => BridgeWebSocketServer | null,
  logger: BridgeServerLogger
): Promise<void> {
  // Authorization check if token configured
  if (config.authToken) {
    const authHeader = req.headers['authorization'];
    const expectedAuth = `Bearer ${config.authToken}`;
    if (!authHeader || authHeader !== expectedAuth) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or missing Bearer authorization token'
          }
        })
      );
      return;
    }
  }

  // Content type validation
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Content-Type must be application/json'
        }
      })
    );
    return;
  }

  // Parse body with size limit check
  let bodyStr = '';
  try {
    bodyStr = await readRequestBody(req, config.maxPromptLength * 2);
  } catch (readErr) {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: readErr instanceof Error ? readErr.message : 'Failed to read request body'
        }
      })
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Malformed JSON payload'
        }
      })
    );
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'JSON body must be an object'
        }
      })
    );
    return;
  }

  const payload = parsed as { prompt?: unknown; options?: unknown };
  if (typeof payload.prompt !== 'string' || payload.prompt.trim() === '') {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Prompt must be a non-empty string'
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
          code: 'INVALID_REQUEST',
          message: `Prompt exceeds maximum allowed length of ${config.maxPromptLength} characters`
        }
      })
    );
    return;
  }

  // Extension connection check with up to 3s grace wait for auto-reconnect
  let wsServer = getWsServer();
  if (!wsServer || !wsServer.isExtensionConnected()) {
    const startWait = Date.now();
    while (Date.now() - startWait < 3000) {
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
          code: 'EXTENSION_NOT_CONNECTED',
          message: 'Chrome extension is not connected to the local bridge'
        }
      })
    );
    return;
  }

  const requestId = `req_${randomUUID()}`;
  logger.req(requestId, `HTTP POST /ask received (prompt length: ${payload.prompt.length})`);

  const bridgeReq: BridgeAskRequest = {
    type: 'ASK_GEMINI',
    requestId,
    prompt: payload.prompt,
    options: typeof payload.options === 'object' && payload.options !== null ? payload.options : undefined
  };

  // Register request with timeout
  const pendingPromise = requestManager.createPendingRequest(requestId, config.requestTimeoutMs);

  // Send request over WebSocket to extension
  const sent = wsServer.sendToExtension(bridgeReq);
  if (!sent) {
    requestManager.rejectRequest(requestId, {
      statusCode: 503,
      code: 'EXTENSION_NOT_CONNECTED',
      message: 'Failed to dispatch request to extension WebSocket'
    });
  }

  try {
    const result = await pendingPromise;
    res.writeHead(200);
    const outputPayload = {
      success: result.success,
      requestId: result.requestId,
      ...(result.success ? { answer: result.answer } : { error: result.error })
    };
    res.end(JSON.stringify(outputPayload));
  } catch (err) {
    const httpErr = err as BridgeHttpError;
    const statusCode = httpErr.statusCode || 500;
    const errorCode = httpErr.code || 'INTERNAL_ERROR';
    const message = httpErr.message || 'An internal bridge error occurred';

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

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytesRead = 0;

    req.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        req.destroy();
        reject(new Error(`Payload size exceeds maximum allowed size of ${maxBytes} bytes`));
        return;
      }
      body += chunk.toString('utf-8');
    });

    req.on('end', () => {
      resolve(body);
    });

    req.on('error', (err: Error) => {
      reject(err);
    });
  });
}
