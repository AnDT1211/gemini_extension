import {
  getAssistantMessageElements,
  getLatestAssistantMessageElement,
  extractAssistantContent
} from './messageExtractor.js';
import { findComposerContainer } from './composer.js';
import { GEMINI_SELECTORS, findMatchingWithDiagnostics } from './selectors.js';
import { GeminiLogger } from '../shared/logger.js';
import { GeminiErrorCode } from '../shared/types.js';

export interface ResponseBaseline {
  count: number;
  lastElement: HTMLElement | null;
  lastText: string;
}

export function captureResponseBaseline(logger?: GeminiLogger): ResponseBaseline {
  const elements = getAssistantMessageElements(logger);
  const lastElement = getLatestAssistantMessageElement(logger);
  const lastText = lastElement ? extractAssistantContent(lastElement, logger) : '';

  if (logger) {
    logger.log(`Captured baseline: ${elements.length} message(s), last element: ${!!lastElement}`);
  }

  return {
    count: elements.length,
    lastElement,
    lastText
  };
}

export function isNewResponsePresent(
  baseline: ResponseBaseline,
  logger?: GeminiLogger
): boolean {
  const currentElements = getAssistantMessageElements(logger);
  const currentLatest = getLatestAssistantMessageElement(logger);

  // Signal 1: Message count increased
  if (currentElements.length > baseline.count) {
    return true;
  }

  // Signal 2: Latest message element reference changed
  if (currentLatest && baseline.lastElement && currentLatest !== baseline.lastElement) {
    return true;
  }

  // Signal 3: Baseline had no messages and now we have one
  if (!baseline.lastElement && currentLatest) {
    return true;
  }

  // Signal 4: Content text changed on the latest element
  if (currentLatest) {
    const currentText = extractAssistantContent(currentLatest, logger);
    if (baseline.lastText !== currentText && currentText.trim().length > 0) {
      return true;
    }
  }

  // Signal 5: Gemini is actively generating right now
  if (isGeminiGenerating(currentLatest, logger)) {
    return true;
  }

  return false;
}

export function isGeminiGenerating(
  responseElement?: HTMLElement | null,
  logger?: GeminiLogger
): boolean {
  const composerContainer = findComposerContainer(logger);
  const searchScopes: ParentNode[] = [];

  if (responseElement) searchScopes.push(responseElement);
  if (composerContainer) searchScopes.push(composerContainer);

  for (const scope of searchScopes) {
    const indicator = findMatchingWithDiagnostics(
      GEMINI_SELECTORS.generatingIndicators,
      scope,
      'Scoped Generation Indicator',
      logger
    );
    if (indicator) {
      return true;
    }
  }

  return false;
}

export function isGeminiGenerationComplete(
  responseElement: HTMLElement,
  logger?: GeminiLogger
): boolean {
  // Check 1: Explicit Gemini completed footer class
  const hasFooterComplete =
    responseElement.querySelector('.response-footer.complete, .response-footer[class*="complete"]') !== null;
  
  // Check 2: Rendered message actions toolbar (Copy, Like, Dislike, Regenerate)
  const hasMessageActions =
    responseElement.querySelector('message-actions, .actions-container-v2, [data-test-id="thumb-up-button"], [data-test-id="regenerate-button"]') !== null;

  if (hasFooterComplete || hasMessageActions) {
    if (logger) logger.log('Explicit Gemini response completion indicators detected (footer/actions present).');
    return true;
  }

  // Check 3: Check for active aria-busy="true" inside response node
  const busyElements = responseElement.querySelectorAll('[aria-busy="true"]');
  if (busyElements.length > 0) {
    return false;
  }

  // Check 4: Check if streaming indicator buttons are gone
  return !isGeminiGenerating(responseElement, logger);
}

export interface ObserveResponseOptions {
  baseline: ResponseBaseline;
  timeoutMs?: number;
  stabilizationMs?: number;
  logger: GeminiLogger;
}

export interface ObserveResponseResult {
  success: boolean;
  content?: string;
  error?: GeminiErrorCode;
  details?: string;
}

export function observeResponseCompletion(
  options: ObserveResponseOptions
): Promise<ObserveResponseResult> {
  const { baseline, logger } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const defaultStabilizationMs = options.stabilizationMs ?? 500;

  return new Promise((resolve) => {
    let observer: MutationObserver | null = null;
    let pollIntervalTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let stabilizationTimer: NodeJS.Timeout | null = null;
    let isFinished = false;

    let lastExtractedContent = '';

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
        logger.log('MutationObserver disconnected.');
      }
      if (pollIntervalTimer) {
        clearInterval(pollIntervalTimer);
        pollIntervalTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (stabilizationTimer) {
        clearTimeout(stabilizationTimer);
        stabilizationTimer = null;
      }
    };

    const finish = (result: ObserveResponseResult) => {
      if (isFinished) return;
      isFinished = true;
      cleanup();
      resolve(result);
    };

    // Safety timeout
    timeoutTimer = setTimeout(() => {
      logger.warn(`Response generation timed out after ${timeoutMs}ms.`);
      finish({
        success: false,
        error: 'RESPONSE_TIMEOUT',
        details: `Gemini response did not complete within ${timeoutMs}ms limit.`
      });
    }, timeoutMs);

    const checkState = () => {
      if (isFinished) return;

      const hasNewResponse = isNewResponsePresent(baseline, logger);
      if (!hasNewResponse) {
        return;
      }

      const currentLatest = getLatestAssistantMessageElement(logger);
      if (!currentLatest) {
        return;
      }

      const currentContent = extractAssistantContent(currentLatest, logger);
      if (!currentContent || currentContent.trim().length === 0) {
        return;
      }

      const isComplete = isGeminiGenerationComplete(currentLatest, logger);
      const isGenerating = isGeminiGenerating(currentLatest, logger);

      logger.log(
        `Stream check: len=${currentContent.length}, isComplete=${isComplete}, isGenerating=${isGenerating}`
      );

      if (stabilizationTimer) {
        clearTimeout(stabilizationTimer);
      }

      lastExtractedContent = currentContent;
      // If explicit DOM completion signals (message-actions or .response-footer.complete) are present, use short 200ms delay
      const windowMs = isComplete ? 200 : defaultStabilizationMs;

      stabilizationTimer = setTimeout(() => {
        const reVerifiedLatest = getLatestAssistantMessageElement(logger);
        const reVerifiedContent = reVerifiedLatest ? extractAssistantContent(reVerifiedLatest, logger) : '';

        // Text stability condition: If text is non-empty and has remained unchanged across stabilization window, finish!
        if (reVerifiedContent.trim().length > 0 && reVerifiedContent === lastExtractedContent) {
          logger.log(`Response text verified stable (${reVerifiedContent.length} chars). Completing askGemini request!`);
          finish({
            success: true,
            content: reVerifiedContent
          });
        } else {
          logger.log('Response text changed during stabilization window, continuing stream observation...');
        }
      }, windowMs);
    };

    // 1. MutationObserver watching conversation root
    observer = new MutationObserver(() => {
      checkState();
    });

    const targetContainer = document.querySelector('main') || document.body;
    observer.observe(targetContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // 2. Interval polling watcher (300ms)
    pollIntervalTimer = setInterval(() => {
      checkState();
    }, 300);

    logger.log('Started MutationObserver & 300ms polling watcher for Gemini response...');
    checkState();
  });
}
