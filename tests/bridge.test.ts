import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import WebSocket from 'ws';
import { getBridgeConfig } from '../bridge-server/config.js';
import { RequestManager } from '../bridge-server/request-manager.js';
import { createBridgeHttpServer } from '../bridge-server/http-server.js';
import { BridgeWebSocketServer } from '../bridge-server/websocket-server.js';
import { BridgeAskRequest, BridgeAskResponse } from '../src/shared/bridge-protocol.js';

describe('Local HTTP Bridge + WebSocket Server Integration Tests', () => {
  let httpServer: http.Server;
  let wsServer: BridgeWebSocketServer;
  let requestManager: RequestManager;
  let port: number;
  let baseUrl: string;
  let wsUrl: string;

  before((context, done) => {
    requestManager = new RequestManager();
    const config = getBridgeConfig();
    config.port = 0; // Use dynamic ephemeral port for tests
    config.requestTimeoutMs = 1000; // Short timeout for test speed

    let serverInstance: BridgeWebSocketServer | null = null;
    httpServer = createBridgeHttpServer(config, requestManager, () => serverInstance);
    wsServer = new BridgeWebSocketServer(httpServer, requestManager);
    serverInstance = wsServer;

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (typeof addr === 'object' && addr !== null) {
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

  // Helper HTTP request function
  function makeHttpRequest(
    method: string,
    path: string,
    body?: object | string,
    headers: Record<string, string> = {}
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: any }> {
    return new Promise((resolve, reject) => {
      const bodyStr = typeof body === 'object' ? JSON.stringify(body) : body;
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let parsedBody = data;
            try {
              parsedBody = JSON.parse(data);
            } catch {}
            resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: parsedBody });
          });
        }
      );

      req.on('error', reject);
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  // Test 1: GET /health returns 200
  test('1. GET /health returns 200 with status ok', async () => {
    const res = await makeHttpRequest('GET', '/health');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { status: 'ok' });
  });

  // Test 2: POST /ask with invalid body returns 400
  test('2. POST /ask with invalid body returns 400', async () => {
    // Missing prompt
    const res1 = await makeHttpRequest('POST', '/ask', {});
    assert.strictEqual(res1.statusCode, 400);
    assert.strictEqual(res1.body.success, false);
    assert.strictEqual(res1.body.error.code, 'INVALID_REQUEST');

    // Empty prompt
    const res2 = await makeHttpRequest('POST', '/ask', { prompt: '   ' });
    assert.strictEqual(res2.statusCode, 400);

    // Non-JSON content type
    const res3 = await makeHttpRequest('POST', '/ask', 'plain text', { 'Content-Type': 'text/plain' });
    assert.strictEqual(res3.statusCode, 400);
  });

  // Test 3: POST /ask returns 503 if extension is disconnected
  test('3. POST /ask returns 503 if extension is disconnected', async () => {
    assert.strictEqual(wsServer.isExtensionConnected(), false);
    const res = await makeHttpRequest('POST', '/ask', { prompt: 'Test prompt' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'EXTENSION_NOT_CONNECTED');
  });

  // Test 4: WebSocket connection updates extension status in GET /status
  test('4. WebSocket connection updates extension status in /status', async () => {
    const statusBefore = await makeHttpRequest('GET', '/status');
    assert.strictEqual(statusBefore.body.extensionConnected, false);

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    const statusAfter = await makeHttpRequest('GET', '/status');
    assert.strictEqual(statusAfter.body.extensionConnected, true);
    assert.ok(statusAfter.body.connectedAt);

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  // Test 5: HTTP request is correlated with correct WebSocket response
  test('5. HTTP request is correlated with correct WebSocket response', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as BridgeAskRequest;
      if (msg.type === 'ASK_GEMINI') {
        const response: BridgeAskResponse = {
          type: 'ASK_GEMINI_RESULT',
          requestId: msg.requestId,
          success: true,
          answer: `Echo response for: ${msg.prompt}`
        };
        ws.send(JSON.stringify(response));
      }
    });

    const res = await makeHttpRequest('POST', '/ask', { prompt: 'Explain virtual threads' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.answer, 'Echo response for: Explain virtual threads');
    assert.ok(res.body.requestId.startsWith('req_'));

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  // Test 6: Multiple concurrent requests resolve to the correct caller
  test('6. Multiple concurrent requests resolve to the correct caller', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as BridgeAskRequest;
      if (msg.type === 'ASK_GEMINI') {
        // Delay response slightly to simulate async processing
        setTimeout(() => {
          const response: BridgeAskResponse = {
            type: 'ASK_GEMINI_RESULT',
            requestId: msg.requestId,
            success: true,
            answer: `Response for ${msg.prompt}`
          };
          ws.send(JSON.stringify(response));
        }, Math.floor(Math.random() * 50) + 10);
      }
    });

    const prompts = ['Prompt Alpha', 'Prompt Beta', 'Prompt Gamma', 'Prompt Delta'];
    const requests = prompts.map((p) => makeHttpRequest('POST', '/ask', { prompt: p }));

    const results = await Promise.all(requests);
    for (let i = 0; i < prompts.length; i++) {
      assert.strictEqual(results[i].statusCode, 200);
      assert.strictEqual(results[i].body.success, true);
      assert.strictEqual(results[i].body.answer, `Response for ${prompts[i]}`);
    }

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  // Test 7: Request timeout cleans up pending state (504)
  test('7. Request timeout cleans up pending state', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    // Do NOT respond over WebSocket to trigger timeout
    const res = await makeHttpRequest('POST', '/ask', { prompt: 'Will timeout' });
    assert.strictEqual(res.statusCode, 504);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'BRIDGE_TIMEOUT');
    assert.strictEqual(requestManager.getPendingCount(), 0);

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  // Test 8: Extension disconnect rejects pending requests (502/503)
  test('8. Extension disconnect rejects pending requests with WEBSOCKET_DISCONNECTED', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    // Send HTTP request without answering, then abruptly close WS
    const pendingHttpReq = makeHttpRequest('POST', '/ask', { prompt: 'Will disconnect' });

    // Wait slightly to ensure request reaches server
    await new Promise((r) => setTimeout(r, 50));
    ws.close();

    const res = await pendingHttpReq;
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'WEBSOCKET_DISCONNECTED');
    assert.strictEqual(requestManager.getPendingCount(), 0);
  });

  // Test 9: Unknown requestId does not crash the bridge
  test('9. Unknown requestId does not crash the bridge', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    const unknownResponse: BridgeAskResponse = {
      type: 'ASK_GEMINI_RESULT',
      requestId: 'req_non_existent_12345',
      success: true,
      answer: 'Spurious answer'
    };

    assert.doesNotThrow(() => {
      ws.send(JSON.stringify(unknownResponse));
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsServer.isExtensionConnected(), true);

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  // Test 10: Malformed WebSocket JSON does not crash the bridge
  test('10. Malformed WebSocket JSON does not crash the bridge', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    assert.doesNotThrow(() => {
      ws.send('invalid json payload { [');
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsServer.isExtensionConnected(), true);

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });
});
