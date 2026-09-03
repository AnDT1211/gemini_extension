import { GEMINI_SELECTORS, findMatchingWithDiagnostics } from './selectors.js';
import { GeminiLogger } from '../shared/logger.js';

export function getAssistantMessageElements(logger?: GeminiLogger): HTMLElement[] {
  for (const selector of GEMINI_SELECTORS.assistantMessages) {
    const matches = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    if (matches.length > 0) {
      return matches;
    }
  }
  return [];
}

export function getLatestAssistantMessageElement(logger?: GeminiLogger): HTMLElement | null {
  const messages = getAssistantMessageElements(logger);
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

/**
 * Extracts assistant response content.
 * Follows user adjustment #5: Prefers innerText directly on the model content root element,
 * falling back to DOM cloning/filtering if necessary.
 */
export function extractAssistantContent(
  messageElement: HTMLElement,
  logger?: GeminiLogger
): string {
  if (!messageElement) {
    return '';
  }

  // 1. Try finding specific model content root child element
  const contentRoot = findMatchingWithDiagnostics(
    GEMINI_SELECTORS.assistantContentRoot,
    messageElement,
    'Model Content Root',
    logger
  );

  const targetNode = contentRoot || messageElement;

  // 2. Primary extraction via innerText
  let rawText = targetNode.innerText ?? targetNode.textContent ?? '';

  // Clean common Gemini UI actions if they got captured
  const uiNoiseRegex = /\b(Copy|Share|Good response|Bad response|Regenerate|Modify response|Export to Docs|Draft in Gmail)\b/gi;
  
  // If no obvious UI noise present, return directly
  if (!uiNoiseRegex.test(rawText)) {
    return rawText.trim();
  }

  if (logger) {
    logger.log('UI action noise detected in raw innerText. Performing fallback DOM filtering...');
  }

  // Fallback: Clone node and strip interactive action buttons
  const clone = targetNode.cloneNode(true) as HTMLElement;
  const selectorsToRemove = [
    'button',
    'footer',
    '.action-buttons',
    '.response-actions',
    '[role="toolbar"]',
    'mat-icon',
    'svg',
    '.feedback-container'
  ];

  for (const sel of selectorsToRemove) {
    const elements = clone.querySelectorAll(sel);
    elements.forEach((el) => el.remove());
  }

  return (clone.innerText ?? clone.textContent ?? '').trim();
}
