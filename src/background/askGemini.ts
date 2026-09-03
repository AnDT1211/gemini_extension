import { findGeminiTab } from './tabFinder.js';
import { AskGeminiOptions, GeminiResponse } from '../shared/types.js';
import { createErrorResponse } from '../shared/errors.js';
import { GeminiMessage } from '../shared/messages.js';
import { GeminiLogger } from '../shared/logger.js';

// Per-tab concurrency Map<tabId, requestId>
const activeTabRequests = new Map<number, string>();

export async function askGemini(
  prompt: string,
  options: AskGeminiOptions = {}
): Promise<GeminiResponse> {
  const requestId = crypto.randomUUID();
  const logger = new GeminiLogger(requestId);

  logger.log(`Received askGemini request for prompt length: ${prompt.length}`);

  // Save working status to storage for popup state persistence
  await chrome.storage.local.set({
    latestStatus: {
      state: 'working',
      requestId,
      prompt,
      timestamp: Date.now()
    }
  });

  // 1. Tab Discovery
  const tab = await findGeminiTab();
  if (!tab || !tab.id) {
    logger.warn('No active/open Gemini tab found.');
    const errorRes = createErrorResponse(requestId, 'GEMINI_TAB_NOT_FOUND', 'No open gemini.google.com tab detected.');
    await chrome.storage.local.set({
      latestStatus: { state: 'completed', requestId, response: errorRes, timestamp: Date.now() }
    });
    return errorRes;
  }

  const tabId = tab.id;
  logger.log(`Selected Gemini tab ID: ${tabId} (${tab.title || tab.url})`);

  // 2. Per-tab Concurrency check
  if (activeTabRequests.has(tabId)) {
    const existingReqId = activeTabRequests.get(tabId);
    logger.warn(`Tab ${tabId} is currently busy with request: ${existingReqId}`);
    const busyRes = createErrorResponse(
      requestId,
      'GEMINI_BUSY',
      `Tab ${tabId} is currently executing request ${existingReqId}`
    );
    await chrome.storage.local.set({
      latestStatus: { state: 'completed', requestId, response: busyRes, timestamp: Date.now() }
    });
    return busyRes;
  }

  // Set busy state for this tab
  activeTabRequests.set(tabId, requestId);

  try {
    const message: GeminiMessage = {
      type: 'EXECUTE_GEMINI_PROMPT',
      requestId,
      prompt,
      timeoutMs: options.timeoutMs,
      stabilizationMs: options.stabilizationMs
    };

    // Attempt sending message to content script
    let response: GeminiResponse;
    try {
      logger.log(`Sending EXECUTE_GEMINI_PROMPT to content script on tab ${tabId}...`);
      response = await chrome.tabs.sendMessage(tabId, message);
      logger.log(`Received result from content script on tab ${tabId}:`, response);
    } catch (sendErr) {
      logger.warn('Content script not reachable. Attempting scripting fallback injection...', sendErr);
      
      let injectionSuccess = false;
      for (const scriptPath of ['dist/content.js', 'content.js']) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [scriptPath]
          });
          injectionSuccess = true;
          logger.log(`Successfully injected content script via: ${scriptPath}`);
          break;
        } catch {}
      }

      if (injectionSuccess) {
        // Pause for content script initialization
        await new Promise((r) => setTimeout(r, 300));
        try {
          response = await chrome.tabs.sendMessage(tabId, message);
          logger.log(`Received result from content script post-injection on tab ${tabId}:`, response);
        } catch (retryErr) {
          logger.error('Failed to communicate after content script injection:', retryErr);
          response = createErrorResponse(
            requestId,
            'CONTENT_SCRIPT_NOT_AVAILABLE',
            `Could not communicate with content script on tab ${tabId}. Please refresh (F5) the Gemini browser tab.`
          );
        }
      } else {
        logger.error('Failed to inject content script using any path candidate.');
        response = createErrorResponse(
          requestId,
          'CONTENT_SCRIPT_NOT_AVAILABLE',
          `Could not inject content script on tab ${tabId}. Please refresh (F5) the Gemini browser tab.`
        );
      }
    }

    if (!response) {
      response = createErrorResponse(requestId, 'UNKNOWN_ERROR', 'Received empty response from content script.');
    }

    // Save final response to storage
    await chrome.storage.local.set({
      latestStatus: {
        state: 'completed',
        requestId,
        response,
        timestamp: Date.now()
      }
    });

    return response;
  } catch (err) {
    logger.error('Unexpected error in askGemini background execution:', err);
    const errRes = createErrorResponse(
      requestId,
      'UNKNOWN_ERROR',
      err instanceof Error ? err.message : String(err)
    );
    await chrome.storage.local.set({
      latestStatus: { state: 'completed', requestId, response: errRes, timestamp: Date.now() }
    });
    return errRes;
  } finally {
    // Always release tab concurrency state
    activeTabRequests.delete(tabId);
    logger.log(`Released concurrency lock for tab ${tabId}`);
  }
}
