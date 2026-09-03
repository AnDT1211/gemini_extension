import { AskGeminiOptions } from './types.js';

export interface BridgeAskRequest {
  type: 'ASK_GEMINI';
  requestId: string;
  prompt: string;
  options?: AskGeminiOptions;
}

export interface BridgeAskResponse {
  type: 'ASK_GEMINI_RESULT';
  requestId: string;
  success: boolean;
  answer?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface BridgeHelloMessage {
  type: 'HELLO';
  source: 'extension';
}

export interface BridgePingMessage {
  type: 'PING';
}

export interface BridgePongMessage {
  type: 'PONG';
}

export type BridgeMessage =
  | BridgeAskRequest
  | BridgeAskResponse
  | BridgeHelloMessage
  | BridgePingMessage
  | BridgePongMessage;
