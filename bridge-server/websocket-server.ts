import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { BridgeAskResponse, BridgeHelloMessage, BridgeMessage } from '../src/shared/bridge-protocol.js';
import { RequestManager } from './request-manager.js';
import { BridgeServerLogger } from './logger.js';

export class BridgeWebSocketServer {
  private wss: WebSocketServer;
  private activeSocket: WebSocket | null = null;
  private connectedAt: string | null = null;
  private requestManager: RequestManager;
  private logger = new BridgeServerLogger('WebSocketServer');

  constructor(server: HttpServer, requestManager: RequestManager) {
    this.requestManager = requestManager;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });
  }

  public isExtensionConnected(): boolean {
    return this.activeSocket !== null && this.activeSocket.readyState === WebSocket.OPEN;
  }

  public getConnectedAt(): string | null {
    return this.connectedAt;
  }

  public sendToExtension(message: BridgeMessage): boolean {
    if (!this.isExtensionConnected() || !this.activeSocket) {
      this.logger.warn('Attempted to send message to extension, but extension is not connected.');
      return false;
    }

    try {
      this.activeSocket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.logger.error('Failed to send WebSocket message to extension:', err);
      return false;
    }
  }

  public close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.activeSocket) {
        this.activeSocket.close();
        this.activeSocket = null;
      }
      this.wss.close(() => resolve());
    });
  }

  private handleConnection(ws: WebSocket): void {
    this.logger.log('New extension WebSocket client connected.');

    // If an active socket exists, replace it safely
    if (this.activeSocket && this.activeSocket !== ws) {
      this.logger.warn('Replacing existing active extension connection with new connection.');
      try {
        this.activeSocket.close(1000, 'Replaced by new extension connection');
      } catch {}
    }

    this.activeSocket = ws;
    this.connectedAt = new Date().toISOString();

    ws.on('message', (data: Buffer | string) => {
      this.handleMessage(data.toString());
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(`Extension WebSocket connection closed (code: ${code}, reason: ${reason.toString() || 'none'})`);
      if (this.activeSocket === ws) {
        this.activeSocket = null;
        this.connectedAt = null;

        // Reject pending requests due to disconnect
        this.requestManager.rejectAllPendingRequests({
          statusCode: 502,
          code: 'WEBSOCKET_DISCONNECTED',
          message: 'Chrome extension WebSocket connection was closed unexpectedly during request execution.'
        });
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.error('Extension WebSocket encountered an error:', err);
    });
  }

  private handleMessage(rawMessage: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch (err) {
      this.logger.error('Received malformed non-JSON payload from extension WebSocket:', rawMessage, err);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      this.logger.warn('Received invalid message schema from extension WebSocket:', parsed);
      return;
    }

    const msg = parsed as BridgeMessage;

    if (msg.type === 'HELLO') {
      const helloMsg = msg as BridgeHelloMessage;
      this.logger.log(`Extension handshake received from source: ${helloMsg.source}`);
      return;
    }

    if (msg.type === 'PING') {
      this.sendToExtension({ type: 'PONG' });
      return;
    }

    if (msg.type === 'PONG') {
      return;
    }

    if (msg.type === 'ASK_GEMINI_RESULT') {
      const resultMsg = msg as BridgeAskResponse;
      this.logger.req(resultMsg.requestId, `Received response from extension (success=${resultMsg.success})`);
      this.requestManager.resolveRequest(resultMsg.requestId, resultMsg);
      return;
    }

    this.logger.warn(`Received unknown message type over WebSocket: ${(msg as { type: string }).type}`);
  }
}
