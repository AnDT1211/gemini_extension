import { askGemini } from './askGemini.js';
import { BridgeAskRequest, BridgeAskResponse, BridgeHelloMessage, BridgeMessage } from '../shared/bridge-protocol.js';
import { GeminiLogger } from '../shared/logger.js';

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export class BridgeWebSocketClient {
  private url: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'DISCONNECTED';
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private backoffIntervals: number[] = [1000, 2000, 3000, 5000];
  private logger: GeminiLogger;

  constructor(url: string = 'ws://127.0.0.1:3456/ws') {
    this.url = url;
    this.logger = new GeminiLogger('WS_CLIENT');
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      this.logger.log('WebSocket connection already active or connecting. Skipping duplicate connect.');
      return;
    }

    this.setState(this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING');
    this.logger.log(`Connecting to bridge WebSocket server at ${this.url}... (Attempt ${this.reconnectAttempt + 1})`);

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.logger.log('WebSocket connected to bridge server successfully.');
        this.setState('CONNECTED');
        this.reconnectAttempt = 0;

        // Send HELLO message
        const hello: BridgeHelloMessage = {
          type: 'HELLO',
          source: 'extension'
        };
        this.send(hello);

        // Start 20s keep-alive heartbeat ping to keep MV3 SW active
        this.startHeartbeat();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (event: Event) => {
        this.logger.warn('WebSocket error encountered:', event);
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.logger.warn(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason || 'None'}`);
        this.stopHeartbeat();
        this.cleanupSocket();
        this.scheduleReconnect();
      };
    } catch (err) {
      this.logger.error('Failed to instantiate WebSocket:', err);
      this.stopHeartbeat();
      this.cleanupSocket();
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Remove listeners before closing to prevent unwanted reconnect schedules
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setState('DISCONNECTED');
    this.reconnectAttempt = 0;
    this.logger.log('WebSocket client disconnected explicitly.');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'PING' });
      }
    }, 20000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(message: BridgeMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.logger.error('Cannot send message, WebSocket is not open.');
    }
  }

  private async handleMessage(rawMessage: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch (err) {
      this.logger.error('Received non-JSON message over WebSocket:', rawMessage, err);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      this.logger.warn('Received invalid message schema over WebSocket:', parsed);
      return;
    }

    const msg = parsed as BridgeMessage;

    if (msg.type === 'PONG') {
      // Heartbeat ack from server
      return;
    }

    if (msg.type === 'PING') {
      this.send({ type: 'PONG' });
      return;
    }

    if (msg.type === 'ASK_GEMINI') {
      const requestId = msg.requestId;
      const reqLogger = new GeminiLogger(requestId);
      reqLogger.log('Received ASK_GEMINI prompt via WebSocket bridge.');

      try {
        const result = await askGemini(msg.prompt, msg.options);
        
        let bridgeResponse: BridgeAskResponse;
        if (result.status === 'success') {
          bridgeResponse = {
            type: 'ASK_GEMINI_RESULT',
            requestId,
            success: true,
            answer: result.content
          };
        } else {
          bridgeResponse = {
            type: 'ASK_GEMINI_RESULT',
            requestId,
            success: false,
            error: {
              code: result.error || 'UNKNOWN_ERROR',
              message: result.details || result.error || 'An error occurred during Gemini interaction.'
            }
          };
        }

        reqLogger.log(`Sending ASK_GEMINI_RESULT back via WebSocket (success=${bridgeResponse.success})`);
        this.send(bridgeResponse);
      } catch (err) {
        reqLogger.error('Unhandled error processing ASK_GEMINI in WebSocket client:', err);
        const errResponse: BridgeAskResponse = {
          type: 'ASK_GEMINI_RESULT',
          requestId,
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: err instanceof Error ? err.message : String(err)
          }
        };
        this.send(errResponse);
      }
    } else {
      this.logger.warn(`Received unexpected message type: ${(msg as { type: string }).type}`);
    }
  }

  private scheduleReconnect(): void {
    this.setState('RECONNECTING');
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

  private cleanupSocket(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws = null;
    }
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.logger.log(`WebSocket client state transition: ${this.state} -> ${newState}`);
      this.state = newState;
    }
  }
}
