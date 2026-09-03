import { BridgeServerConfig } from './types.js';

export function getBridgeConfig(): BridgeServerConfig {
  return {
    host: process.env.GEMINI_BRIDGE_HOST || '127.0.0.1',
    port: parseInt(process.env.GEMINI_BRIDGE_PORT || '3456', 10),
    requestTimeoutMs: parseInt(process.env.GEMINI_BRIDGE_REQUEST_TIMEOUT_MS || '120000', 10),
    maxPromptLength: parseInt(process.env.GEMINI_BRIDGE_MAX_PROMPT_LENGTH || '50000', 10),
    authToken: process.env.GEMINI_BRIDGE_TOKEN || '',
    corsOrigin: process.env.GEMINI_BRIDGE_CORS_ORIGIN || ''
  };
}
