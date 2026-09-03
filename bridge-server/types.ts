import { BridgeAskResponse } from '../src/shared/bridge-protocol.js';

export interface PendingRequest {
  requestId: string;
  resolve: (value: BridgeAskResponse) => void;
  reject: (error: BridgeHttpError) => void;
  timeoutTimer: NodeJS.Timeout;
  createdAt: number;
}

export interface BridgeHttpError {
  statusCode: number;
  code: string;
  message: string;
}

export interface BridgeServerConfig {
  host: string;
  port: number;
  requestTimeoutMs: number;
  maxPromptLength: number;
  authToken: string;
  corsOrigin: string;
}

export interface BridgeServerStatus {
  bridgeServer: 'ready';
  extensionConnected: boolean;
  connectedAt: string | null;
}
