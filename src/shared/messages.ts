import { AskGeminiOptions, GeminiResponse } from './types.js';

export type GeminiMessage =
  | {
      type: 'ASK_GEMINI_REQUEST';
      requestId: string;
      prompt: string;
      options?: AskGeminiOptions;
    }
  | {
      type: 'EXECUTE_GEMINI_PROMPT';
      requestId: string;
      prompt: string;
      timeoutMs?: number;
      stabilizationMs?: number;
    }
  | {
      type: 'GEMINI_PING';
    };

export type GeminiMessageResponse =
  | GeminiResponse
  | { type: 'GEMINI_PONG' };
