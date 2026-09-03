import { GeminiLogger } from '../shared/logger.js';

export const GEMINI_SELECTORS = {
  // 1. Composer candidates (rich-textarea, contenteditable, aria-label, fallback textarea)
  composer: [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="prompt" i]',
    'div[contenteditable="true"][aria-label*="Enter" i]',
    'div[contenteditable="true"][aria-label*="Nhập" i]',
    'div[contenteditable="true"]',
    'textarea[aria-label*="prompt" i]',
    'textarea'
  ],

  // 2. Composer container wrapper candidates for scoping send button & stop button
  composerContainer: [
    'div:has(> [data-test-id="send-button-container"])',
    'div:has(> rich-textarea)',
    '.chat-input-container',
    '.input-area-container',
    '.composer-container',
    'rich-textarea',
    'form'
  ],

  // 3. Send button candidates (Includes exact Gemini Angular component structure)
  sendButton: [
    '[data-test-id="send-button-container"] button',
    '[data-test-id="send-button-container"]',
    'gem-icon-button.send-button button',
    'gem-icon-button.send-button',
    '.send-button-container button',
    '.send-button-container',
    'button[aria-label="Gửi tin nhắn"]',
    'button[aria-label*="Gửi tin nhắn"]',
    'button[aria-label*="Send message"]',
    'button[aria-label*="Send prompt"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Gửi" i]',
    'button[aria-label*="Submit" i]',
    'button[data-test-id*="send" i]',
    'button[data-testid*="send" i]',
    'button:has(mat-icon[data-mat-icon-name="arrow_upward"])',
    'button:has(mat-icon[fonticon="arrow_upward"])',
    'button.send-button',
    'button[type="submit"]',
    'button:has(svg)' // Scoped to composer container
  ],

  // 4. Stop / generating candidates (scoped to composer container or response area)
  generatingIndicators: [
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Dừng" i]',
    'button[aria-label*="Cancel" i]',
    '[data-test-id*="stop" i]',
    '[data-testid*="stop" i]',
    '.stop-button',
    'mat-progress-spinner',
    '[data-is-streaming="true"]',
    '.streaming',
    '.is-generating'
  ],

  // 5. Assistant message element candidates
  assistantMessages: [
    'model-response',
    '.model-response-text',
    '[data-test-id="model-response"]',
    '.assistant-message',
    'div[data-message-author="assistant"]',
    '.conversation-container model-response'
  ],

  // 6. Model content root elements for innerText extraction
  assistantContentRoot: [
    '.model-response-text',
    '.message-content',
    'message-content',
    '.response-container-content'
  ]
};

export function deepQuerySelectorAll(selector: string, root: ParentNode = document): HTMLElement[] {
  const results: HTMLElement[] = [];

  try {
    const elements = root.querySelectorAll<HTMLElement>(selector);
    elements.forEach((el) => results.push(el));
  } catch {}

  // Traverse custom elements shadow roots if accessible
  try {
    const allElements = root.querySelectorAll<HTMLElement>('*');
    allElements.forEach((el) => {
      if (el.shadowRoot) {
        const shadowResults = deepQuerySelectorAll(selector, el.shadowRoot);
        shadowResults.forEach((sEl) => results.push(sEl));
      }
    });
  } catch {}

  return results;
}

export function findMatchingWithDiagnostics(
  candidates: string[],
  context: ParentNode = document,
  contextName: string,
  logger?: GeminiLogger
): HTMLElement | null {
  const diagnostics: { selector: string; matchCount: number }[] = [];

  for (const selector of candidates) {
    try {
      const matches = deepQuerySelectorAll(selector, context);
      diagnostics.push({ selector, matchCount: matches.length });
      if (matches.length > 0) {
        if (logger) {
          logger.log(`DOM Match found for ${contextName} using selector: "${selector}"`);
        }
        return matches[0];
      }
    } catch {
      diagnostics.push({ selector, matchCount: 0 });
    }
  }

  if (logger) {
    logger.logDiagnostics(contextName, diagnostics);
  }

  return null;
}
