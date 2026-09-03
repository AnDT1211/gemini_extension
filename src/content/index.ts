import { GeminiMessage } from '../shared/messages.js';
import { GeminiResponse } from '../shared/types.js';
import { createErrorResponse, createSuccessResponse } from '../shared/errors.js';
import { GeminiLogger } from '../shared/logger.js';
import { waitForCondition } from '../shared/utils.js';
import { findGeminiComposer, setComposerValue } from './composer.js';
import { findSendButton, isSendButtonEnabled, triggerSend } from './sendButton.js';
import { captureResponseBaseline, observeResponseCompletion } from './responseObserver.js';

console.log('[GeminiBridge] Content script loaded on Gemini page.');

// Maintain long-lived connection port to background service worker to prevent MV3 worker suspension
function setupKeepAlivePort(): void {
  try {
    const port = chrome.runtime.connect({ name: 'gemini-keepalive' });
    port.onDisconnect.addListener(() => {
      setTimeout(setupKeepAlivePort, 1000);
    });
  } catch {}
}
setupKeepAlivePort();

async function handleExecutePrompt(
  requestId: string,
  prompt: string,
  timeoutMs?: number,
  stabilizationMs?: number
): Promise<GeminiResponse> {
  const logger = new GeminiLogger(requestId);
  logger.log('Starting execution of prompt in Gemini tab content script.');

  // Step 1: Find composer
  const composer = findGeminiComposer(logger);
  if (!composer) {
    logger.error('Failed to locate Gemini composer element.');
    return createErrorResponse(
      requestId,
      'COMPOSER_NOT_FOUND',
      'Could not locate Gemini composer input element on the page.'
    );
  }

  // Step 2: Capture multi-signal baseline before sending (User adjustment #3)
  const baseline = captureResponseBaseline(logger);

  // Step 3: Insert prompt (User adjustment #2: focus -> update -> dispatch -> verify)
  const insertedSuccessfully = await setComposerValue(composer, prompt, logger);
  if (!insertedSuccessfully) {
    logger.error('Failed to insert prompt into composer.');
    return createErrorResponse(
      requestId,
      'PROMPT_INPUT_FAILED',
      'Failed to insert prompt text into Gemini input element.'
    );
  }

  // Step 4: Find Send button with async wait for Angular rendering/DOM update (Requirement 19)
  let sendButton: HTMLElement | null = null;
  try {
    sendButton = await waitForCondition(() => findSendButton(logger), {
      timeoutMs: 5000,
      intervalMs: 100,
      description: 'Send button appearance after prompt insertion'
    });
  } catch {
    sendButton = null;
  }

  if (!sendButton) {
    logger.error('Failed to locate Send button after waiting for DOM update.');
    return createErrorResponse(
      requestId,
      'SEND_BUTTON_NOT_FOUND',
      'Could not locate Send button in Gemini UI after prompt insertion.'
    );
  }

  // Wait until Send button becomes enabled
  try {
    await waitForCondition(() => isSendButtonEnabled(sendButton!), {
      timeoutMs: 3000,
      intervalMs: 100,
      description: 'Send button enabled state'
    });
  } catch {
    logger.error('Send button remained disabled.');
    return createErrorResponse(
      requestId,
      'SEND_BUTTON_DISABLED',
      'Gemini Send button is currently disabled.'
    );
  }

  // Step 5: Trigger send action (with fallback composer Enter keypress)
  triggerSend(sendButton, composer, logger);

  // Step 6: Observe response streaming & completion
  logger.log('Prompt submitted. Observing response streaming and completion...');
  const observation = await observeResponseCompletion({
    baseline,
    timeoutMs,
    stabilizationMs,
    logger
  });

  if (!observation.success || !observation.content) {
    return createErrorResponse(
      requestId,
      observation.error || 'GENERATION_FAILED',
      observation.details || 'Failed to capture assistant response content.'
    );
  }

  logger.log(`Response completed successfully (${observation.content.length} chars).`);
  return createSuccessResponse(requestId, observation.content);
}

// Register message listener
chrome.runtime.onMessage.addListener((message: GeminiMessage, sender, sendResponse) => {
  if (message.type === 'EXECUTE_GEMINI_PROMPT') {
    handleExecutePrompt(
      message.requestId,
      message.prompt,
      message.timeoutMs,
      message.stabilizationMs
    )
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse(
          createErrorResponse(
            message.requestId,
            'UNKNOWN_ERROR',
            err instanceof Error ? err.message : String(err)
          )
        );
      });
    return true; // Keep channel open for async execution
  }

  return false;
});
