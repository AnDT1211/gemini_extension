import { askGemini } from './askGemini.js';
import { GeminiMessage } from '../shared/messages.js';
import { BridgeWebSocketClient } from './bridge-websocket-client.js';

// Expose askGemini globally in background worker environment for extension debugging / direct import
(self as unknown as Record<string, unknown>).askGemini = askGemini;

// Initialize WebSocket client to bridge server
const bridgeClient = new BridgeWebSocketClient();
bridgeClient.connect();
(self as unknown as Record<string, unknown>).bridgeClient = bridgeClient;

// Set up periodic Chrome alarm backup to ensure connection is maintained even if SW restarts
try {
  chrome.alarms.create('bridge_reconnect_alarm', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'bridge_reconnect_alarm') {
      if (bridgeClient.getState() !== 'CONNECTED') {
        console.log('[GeminiBridge] Periodic alarm triggered connection check.');
        bridgeClient.connect();
      }
    }
  });
} catch {}

// Accept keep-alive port connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'gemini-keepalive') {
    port.onDisconnect.addListener(() => {
      if (bridgeClient.getState() !== 'CONNECTED') {
        bridgeClient.connect();
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message: GeminiMessage, sender, sendResponse) => {
  if (message.type === 'ASK_GEMINI_REQUEST') {
    console.log(`[GeminiBridge] Background worker received ASK_GEMINI_REQUEST: ${message.requestId}`);
    askGemini(message.prompt, message.options)
      .then((result) => {
        console.log(`[GeminiBridge] Background sending result to popup/caller for ${message.requestId}:`, result);
        sendResponse(result);
      })
      .catch((err) => {
        console.error(`[GeminiBridge] Background error handling ${message.requestId}:`, err);
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
