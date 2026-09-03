import { askGemini } from './askGemini.js';
import { GeminiMessage } from '../shared/messages.js';

// Expose askGemini globally in background worker environment for extension debugging / direct import
(self as unknown as Record<string, unknown>).askGemini = askGemini;

chrome.runtime.onMessage.addListener((message: GeminiMessage, sender, sendResponse) => {
  if (message.type === 'ASK_GEMINI_REQUEST') {
    askGemini(message.prompt, message.options)
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          requestId: message.requestId,
          status: 'error',
          error: 'UNKNOWN_ERROR',
          details: err instanceof Error ? err.message : String(err)
        });
      });
    return true; // Keep message channel open for async response
  }

  if (message.type === 'GEMINI_PING') {
    sendResponse({ type: 'GEMINI_PONG' });
    return false;
  }

  return false;
});

console.log('[GeminiBridge] Background Service Worker initialized.');
