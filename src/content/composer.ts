import { GEMINI_SELECTORS, findMatchingWithDiagnostics } from './selectors.js';
import { GeminiLogger } from '../shared/logger.js';

export function findGeminiComposer(logger?: GeminiLogger): HTMLElement | null {
  return findMatchingWithDiagnostics(
    GEMINI_SELECTORS.composer,
    document,
    'Gemini Composer',
    logger
  );
}

export function findComposerContainer(logger?: GeminiLogger): HTMLElement | null {
  const container = findMatchingWithDiagnostics(
    GEMINI_SELECTORS.composerContainer,
    document,
    'Composer Container',
    logger
  );
  
  if (container) {
    return container;
  }

  // Fallback: If no explicit container matched, use parent of composer
  const composer = findGeminiComposer(logger);
  return composer ? (composer.parentElement as HTMLElement) : null;
}

/**
 * Inserts prompt into Gemini composer following user adjustment #2:
 * focus -> update value/content -> dispatch beforeinput/input -> verify (no unneeded blur).
 */
export async function setComposerValue(
  element: HTMLElement,
  prompt: string,
  logger?: GeminiLogger
): Promise<boolean> {
  if (logger) {
    logger.log('Focusing composer element...');
  }
  element.focus();

  const isEditable = element.isContentEditable || element.getAttribute('contenteditable') === 'true';
  const isTextArea = element.tagName.toLowerCase() === 'textarea' || element.tagName.toLowerCase() === 'input';

  if (isEditable) {
    if (logger) {
      logger.log('Updating contenteditable composer...');
    }

    // Clear existing contents
    element.innerHTML = '';

    // Create paragraph structure commonly expected by rich text editors
    const p = document.createElement('p');
    p.textContent = prompt;
    element.appendChild(p);

    // Dispatch beforeinput and input events
    try {
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: prompt
        })
      );
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: prompt
        })
      );
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      if (logger) logger.warn('Standard InputEvent dispatch failed, using custom Event', e);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (isTextArea) {
    if (logger) {
      logger.log('Updating textarea composer...');
    }
    const textArea = element as HTMLTextAreaElement;
    
    // React / Angular input value setter override
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    if (valueSetter) {
      valueSetter.call(textArea, prompt);
    } else {
      textArea.value = prompt;
    }

    textArea.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: prompt
      })
    );
    textArea.dispatchEvent(new Event('input', { bubbles: true }));
    textArea.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Fallback setter for unknown element types
    element.textContent = prompt;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Verification step
  const insertedText = (element as HTMLTextAreaElement).value ?? element.innerText ?? element.textContent ?? '';
  const isSuccess = insertedText.trim().includes(prompt.trim().substring(0, Math.min(prompt.length, 20)));

  if (logger) {
    logger.log(`Composer insertion verification result: ${isSuccess ? 'PASSED' : 'FAILED'}`);
  }

  return isSuccess;
}
