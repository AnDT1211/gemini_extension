export type GeminiErrorCode =
  | 'GEMINI_TAB_NOT_FOUND'
  | 'CONTENT_SCRIPT_NOT_AVAILABLE'
  | 'COMPOSER_NOT_FOUND'
  | 'PROMPT_INPUT_FAILED'
  | 'SEND_BUTTON_NOT_FOUND'
  | 'SEND_BUTTON_DISABLED'
  | 'GEMINI_BUSY'
  | 'RESPONSE_NOT_FOUND'
  | 'RESPONSE_TIMEOUT'
  | 'GENERATION_FAILED'
  | 'TAB_CLOSED'
  | 'INVALID_REQUEST'
  | 'EXTENSION_NOT_CONNECTED'
  | 'BRIDGE_TIMEOUT'
  | 'WEBSOCKET_DISCONNECTED'
  | 'INTERNAL_ERROR'
  | 'UNAUTHORIZED'
  | 'UNKNOWN_ERROR';

export interface GeminiResponse {
  requestId: string;
  status: 'success' | 'error';
  content?: string;
  error?: GeminiErrorCode;
  details?: string;
}

export type GeminiState =
  | 'IDLE'
  | 'FINDING_TAB'
  | 'FINDING_COMPOSER'
  | 'SETTING_PROMPT'
  | 'WAITING_SEND_READY'
  | 'SUBMITTING'
  | 'WAITING_RESPONSE'
  | 'STREAMING'
  | 'COMPLETED'
  | 'ERROR';

export interface AskGeminiOptions {
  timeoutMs?: number;
  stabilizationMs?: number;
}
