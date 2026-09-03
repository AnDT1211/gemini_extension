import { GEMINI_SELECTORS, findMatchingWithDiagnostics } from './selectors.js';
import { findComposerContainer } from './composer.js';
import { GeminiLogger } from '../shared/logger.js';

function unwrapClickableButton(element: HTMLElement): HTMLElement {
  if (element.tagName.toLowerCase() === 'button') {
    return element;
  }

  // Check light DOM
  const lightBtn = element.querySelector<HTMLElement>('button, [role="button"], .mdc-icon-button');
  if (lightBtn) {
    return lightBtn;
  }

  // Check Shadow DOM if accessible
  if (element.shadowRoot) {
    const shadowBtn = element.shadowRoot.querySelector<HTMLElement>('button, [role="button"], .mdc-icon-button');
    if (shadowBtn) {
      return shadowBtn;
    }
  }

  return element;
}

export function findSendButton(logger?: GeminiLogger): HTMLElement | null {
  const container = findComposerContainer(logger);
  
  let targetNode: HTMLElement | null = null;

  // Search within composer container scope first
  if (container) {
    targetNode = findMatchingWithDiagnostics(
      GEMINI_SELECTORS.sendButton,
      container,
      'Scoped Send Button',
      logger
    );
  }

  // Fallback to global document search if scoped search didn't locate a button node
  if (!targetNode) {
    const globalCandidates = GEMINI_SELECTORS.sendButton.filter((sel) => sel !== 'button:has(svg)');
    targetNode = findMatchingWithDiagnostics(
      globalCandidates,
      document,
      'Global Send Button (strict)',
      logger
    );
  }

  if (!targetNode) {
    return null;
  }

  const finalButton = unwrapClickableButton(targetNode);
  if (logger && finalButton !== targetNode) {
    logger.log(`Unwrapped clickable <${finalButton.tagName.toLowerCase()}> from wrapper <${targetNode.tagName.toLowerCase()}>.`);
  }

  return finalButton;
}

export function isSendButtonEnabled(btn: HTMLElement): boolean {
  if ((btn as HTMLButtonElement).disabled) {
    return false;
  }
  if (btn.getAttribute('aria-disabled') === 'true') {
    return false;
  }
  if (btn.classList.contains('disabled')) {
    return false;
  }

  // Also check parent wrapper aria-disabled state
  if (btn.parentElement && btn.parentElement.getAttribute('aria-disabled') === 'true') {
    return false;
  }

  return true;
}

export function triggerSend(
  sendButton: HTMLElement,
  composer?: HTMLElement | null,
  logger?: GeminiLogger
): void {
  if (logger) {
    logger.log(`Triggering submit on Send button (<${sendButton.tagName.toLowerCase()}>)...`);
  }

  sendButton.focus();

  // Full event sequence for modern frontend framework button handlers
  try {
    sendButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    sendButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  } catch {}

  sendButton.click();

  // Also click parent <gem-icon-button> if sendButton is inside one
  const gemIconButton = sendButton.closest('gem-icon-button');
  if (gemIconButton && gemIconButton !== sendButton) {
    try {
      (gemIconButton as HTMLElement).click();
    } catch {}
  }

  // Backup submission: If composer still contains text after 200ms, dispatch Enter keypress on composer
  if (composer) {
    setTimeout(() => {
      const currentText = (composer as HTMLTextAreaElement).value ?? composer.innerText ?? composer.textContent ?? '';
      if (currentText.trim().length > 0) {
        if (logger) logger.log('Composer still contains text after button click. Triggering fallback Enter key event...');
        composer.focus();
        composer.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          })
        );
        composer.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          })
        );
      }
    }, 200);
  }
}
