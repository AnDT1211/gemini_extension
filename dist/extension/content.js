// src/shared/errors.ts
function createErrorResponse(requestId, error, details) {
  return {
    requestId,
    status: "error",
    error,
    ...details ? { details } : {}
  };
}
function createSuccessResponse(requestId, content) {
  return {
    requestId,
    status: "success",
    content
  };
}

// src/shared/logger.ts
var GeminiLogger = class {
  requestId;
  constructor(requestId = "GLOBAL") {
    this.requestId = requestId;
  }
  log(message, ...extra) {
    console.log(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }
  warn(message, ...extra) {
    console.warn(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }
  error(message, ...extra) {
    console.error(`[GeminiBridge][${this.requestId}] ${message}`, ...extra);
  }
  logDiagnostics(contextName, candidates) {
    console.groupCollapsed(`[GeminiBridge][${this.requestId}] DOM Detection Diagnostics: ${contextName}`);
    for (const c of candidates) {
      console.log(`Selector: "${c.selector}" -> Matched ${c.matchCount} element(s)`);
    }
    console.groupEnd();
  }
};

// src/shared/utils.ts
async function waitForCondition(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1e4;
  const intervalMs = options.intervalMs ?? 100;
  const startTime = Date.now();
  while (true) {
    const result = await predicate();
    if (result) {
      return result;
    }
    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(`Timeout waiting for condition: ${options.description ?? "unspecified condition"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// src/content/selectors.ts
var GEMINI_SELECTORS = {
  // 1. Composer candidates (rich-textarea, contenteditable, aria-label, fallback textarea)
  composer: [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="prompt" i]',
    'div[contenteditable="true"][aria-label*="Enter" i]',
    'div[contenteditable="true"][aria-label*="Nh\u1EADp" i]',
    'div[contenteditable="true"]',
    'textarea[aria-label*="prompt" i]',
    "textarea"
  ],
  // 2. Composer container wrapper candidates for scoping send button & stop button
  composerContainer: [
    'div:has(> [data-test-id="send-button-container"])',
    "div:has(> rich-textarea)",
    ".chat-input-container",
    ".input-area-container",
    ".composer-container",
    "rich-textarea",
    "form"
  ],
  // 3. Send button candidates (Includes exact Gemini Angular component structure)
  sendButton: [
    '[data-test-id="send-button-container"] button',
    '[data-test-id="send-button-container"]',
    "gem-icon-button.send-button button",
    "gem-icon-button.send-button",
    ".send-button-container button",
    ".send-button-container",
    'button[aria-label="G\u1EEDi tin nh\u1EAFn"]',
    'button[aria-label*="G\u1EEDi tin nh\u1EAFn"]',
    'button[aria-label*="Send message"]',
    'button[aria-label*="Send prompt"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="G\u1EEDi" i]',
    'button[aria-label*="Submit" i]',
    'button[data-test-id*="send" i]',
    'button[data-testid*="send" i]',
    'button:has(mat-icon[data-mat-icon-name="arrow_upward"])',
    'button:has(mat-icon[fonticon="arrow_upward"])',
    "button.send-button",
    'button[type="submit"]',
    "button:has(svg)"
    // Scoped to composer container
  ],
  // 4. Stop / generating candidates (strict specific selectors)
  generatingIndicators: [
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="D\u1EEBng t\u1EA1o" i]',
    'button[aria-label*="D\u1EEBng c\xE2u tr\u1EA3 l\u1EDDi" i]',
    '[data-test-id="stop-button"]',
    '[data-testid="stop-button"]',
    ".stop-button"
  ],
  // 5. Assistant message element candidates
  assistantMessages: [
    "model-response",
    ".model-response-text",
    '[data-test-id="model-response"]',
    ".assistant-message",
    'div[data-message-author="assistant"]',
    ".conversation-container model-response"
  ],
  // 6. Model content root elements for innerText extraction
  assistantContentRoot: [
    ".model-response-text",
    ".message-content",
    "message-content",
    ".response-container-content"
  ]
};
function deepQuerySelectorAll(selector, root = document) {
  const results = [];
  try {
    const elements = root.querySelectorAll(selector);
    elements.forEach((el) => results.push(el));
  } catch {
  }
  try {
    const allElements = root.querySelectorAll("*");
    allElements.forEach((el) => {
      if (el.shadowRoot) {
        const shadowResults = deepQuerySelectorAll(selector, el.shadowRoot);
        shadowResults.forEach((sEl) => results.push(sEl));
      }
    });
  } catch {
  }
  return results;
}
function findMatchingWithDiagnostics(candidates, context = document, contextName, logger) {
  const diagnostics = [];
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

// src/content/composer.ts
function findGeminiComposer(logger) {
  return findMatchingWithDiagnostics(
    GEMINI_SELECTORS.composer,
    document,
    "Gemini Composer",
    logger
  );
}
function findComposerContainer(logger) {
  const container = findMatchingWithDiagnostics(
    GEMINI_SELECTORS.composerContainer,
    document,
    "Composer Container",
    logger
  );
  if (container) {
    return container;
  }
  const composer = findGeminiComposer(logger);
  return composer ? composer.parentElement : null;
}
async function setComposerValue(element, prompt, logger) {
  if (logger) {
    logger.log("Focusing composer element...");
  }
  element.focus();
  const isEditable = element.isContentEditable || element.getAttribute("contenteditable") === "true";
  const isTextArea = element.tagName.toLowerCase() === "textarea" || element.tagName.toLowerCase() === "input";
  if (isEditable) {
    if (logger) {
      logger.log("Updating contenteditable composer...");
    }
    element.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = prompt;
    element.appendChild(p);
    try {
      element.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: prompt
        })
      );
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: prompt
        })
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      if (logger)
        logger.warn("Standard InputEvent dispatch failed, using custom Event", e);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } else if (isTextArea) {
    if (logger) {
      logger.log("Updating textarea composer...");
    }
    const textArea = element;
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (valueSetter) {
      valueSetter.call(textArea, prompt);
    } else {
      textArea.value = prompt;
    }
    textArea.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: prompt
      })
    );
    textArea.dispatchEvent(new Event("input", { bubbles: true }));
    textArea.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    element.textContent = prompt;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const insertedText = element.value ?? element.innerText ?? element.textContent ?? "";
  const isSuccess = insertedText.trim().includes(prompt.trim().substring(0, Math.min(prompt.length, 20)));
  if (logger) {
    logger.log(`Composer insertion verification result: ${isSuccess ? "PASSED" : "FAILED"}`);
  }
  return isSuccess;
}

// src/content/sendButton.ts
function unwrapClickableButton(element) {
  if (element.tagName.toLowerCase() === "button") {
    return element;
  }
  const lightBtn = element.querySelector('button, [role="button"], .mdc-icon-button');
  if (lightBtn) {
    return lightBtn;
  }
  if (element.shadowRoot) {
    const shadowBtn = element.shadowRoot.querySelector('button, [role="button"], .mdc-icon-button');
    if (shadowBtn) {
      return shadowBtn;
    }
  }
  return element;
}
function findSendButton(logger) {
  const container = findComposerContainer(logger);
  let targetNode = null;
  if (container) {
    targetNode = findMatchingWithDiagnostics(
      GEMINI_SELECTORS.sendButton,
      container,
      "Scoped Send Button",
      logger
    );
  }
  if (!targetNode) {
    const globalCandidates = GEMINI_SELECTORS.sendButton.filter((sel) => sel !== "button:has(svg)");
    targetNode = findMatchingWithDiagnostics(
      globalCandidates,
      document,
      "Global Send Button (strict)",
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
function isSendButtonEnabled(btn) {
  if (btn.disabled) {
    return false;
  }
  if (btn.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (btn.classList.contains("disabled")) {
    return false;
  }
  if (btn.parentElement && btn.parentElement.getAttribute("aria-disabled") === "true") {
    return false;
  }
  return true;
}
function triggerSend(sendButton, composer, logger) {
  if (logger) {
    logger.log(`Triggering submit on Send button (<${sendButton.tagName.toLowerCase()}>)...`);
  }
  sendButton.focus();
  try {
    sendButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    sendButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    sendButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    sendButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  } catch {
  }
  sendButton.click();
  const gemIconButton = sendButton.closest("gem-icon-button");
  if (gemIconButton && gemIconButton !== sendButton) {
    try {
      gemIconButton.click();
    } catch {
    }
  }
  if (composer) {
    setTimeout(() => {
      const currentText = composer.value ?? composer.innerText ?? composer.textContent ?? "";
      if (currentText.trim().length > 0) {
        if (logger)
          logger.log("Composer still contains text after button click. Triggering fallback Enter key event...");
        composer.focus();
        composer.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          })
        );
        composer.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: "Enter",
            code: "Enter",
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

// src/content/messageExtractor.ts
function getAssistantMessageElements(logger) {
  for (const selector of GEMINI_SELECTORS.assistantMessages) {
    const matches = Array.from(document.querySelectorAll(selector));
    if (matches.length > 0) {
      return matches;
    }
  }
  return [];
}
function getLatestAssistantMessageElement(logger) {
  const messages = getAssistantMessageElements(logger);
  return messages.length > 0 ? messages[messages.length - 1] : null;
}
function extractAssistantContent(messageElement, logger) {
  if (!messageElement) {
    return "";
  }
  const contentRoot = findMatchingWithDiagnostics(
    GEMINI_SELECTORS.assistantContentRoot,
    messageElement,
    "Model Content Root",
    logger
  );
  const targetNode = contentRoot || messageElement;
  let rawText = targetNode.innerText ?? targetNode.textContent ?? "";
  const uiNoiseRegex = /\b(Copy|Share|Good response|Bad response|Regenerate|Modify response|Export to Docs|Draft in Gmail)\b/gi;
  if (!uiNoiseRegex.test(rawText)) {
    return rawText.trim();
  }
  if (logger) {
    logger.log("UI action noise detected in raw innerText. Performing fallback DOM filtering...");
  }
  const clone = targetNode.cloneNode(true);
  const selectorsToRemove = [
    "button",
    "footer",
    ".action-buttons",
    ".response-actions",
    '[role="toolbar"]',
    "mat-icon",
    "svg",
    ".feedback-container"
  ];
  for (const sel of selectorsToRemove) {
    const elements = clone.querySelectorAll(sel);
    elements.forEach((el) => el.remove());
  }
  return (clone.innerText ?? clone.textContent ?? "").trim();
}

// src/content/responseObserver.ts
function captureResponseBaseline(logger) {
  const elements = getAssistantMessageElements(logger);
  const lastElement = getLatestAssistantMessageElement(logger);
  const lastText = lastElement ? extractAssistantContent(lastElement, logger) : "";
  if (logger) {
    logger.log(`Captured baseline: ${elements.length} message(s), last element: ${!!lastElement}`);
  }
  return {
    count: elements.length,
    lastElement,
    lastText
  };
}
function isNewResponsePresent(baseline, logger) {
  const currentElements = getAssistantMessageElements(logger);
  const currentLatest = getLatestAssistantMessageElement(logger);
  if (currentElements.length > baseline.count) {
    return true;
  }
  if (currentLatest && baseline.lastElement && currentLatest !== baseline.lastElement) {
    return true;
  }
  if (!baseline.lastElement && currentLatest) {
    return true;
  }
  if (currentLatest) {
    const currentText = extractAssistantContent(currentLatest, logger);
    if (baseline.lastText !== currentText && currentText.trim().length > 0) {
      return true;
    }
  }
  if (isGeminiGenerating(currentLatest, logger)) {
    return true;
  }
  return false;
}
function isGeminiGenerating(responseElement, logger) {
  const composerContainer = findComposerContainer(logger);
  const searchScopes = [];
  if (responseElement)
    searchScopes.push(responseElement);
  if (composerContainer)
    searchScopes.push(composerContainer);
  for (const scope of searchScopes) {
    const indicator = findMatchingWithDiagnostics(
      GEMINI_SELECTORS.generatingIndicators,
      scope,
      "Scoped Generation Indicator",
      logger
    );
    if (indicator) {
      return true;
    }
  }
  return false;
}
function isGeminiGenerationComplete(responseElement, logger) {
  const hasFooterComplete = responseElement.querySelector('.response-footer.complete, .response-footer[class*="complete"]') !== null;
  const hasMessageActions = responseElement.querySelector('message-actions, .actions-container-v2, [data-test-id="thumb-up-button"], [data-test-id="regenerate-button"]') !== null;
  if (hasFooterComplete || hasMessageActions) {
    if (logger)
      logger.log("Explicit Gemini response completion indicators detected (footer/actions present).");
    return true;
  }
  const busyElements = responseElement.querySelectorAll('[aria-busy="true"]');
  if (busyElements.length > 0) {
    return false;
  }
  return !isGeminiGenerating(responseElement, logger);
}
function observeResponseCompletion(options) {
  const { baseline, logger } = options;
  const timeoutMs = options.timeoutMs ?? 12e4;
  const defaultStabilizationMs = options.stabilizationMs ?? 500;
  return new Promise((resolve) => {
    let observer = null;
    let pollIntervalTimer = null;
    let timeoutTimer = null;
    let stabilizationTimer = null;
    let isFinished = false;
    let lastExtractedContent = "";
    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
        logger.log("MutationObserver disconnected.");
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
    const finish = (result) => {
      if (isFinished)
        return;
      isFinished = true;
      cleanup();
      resolve(result);
    };
    timeoutTimer = setTimeout(() => {
      logger.warn(`Response generation timed out after ${timeoutMs}ms.`);
      finish({
        success: false,
        error: "RESPONSE_TIMEOUT",
        details: `Gemini response did not complete within ${timeoutMs}ms limit.`
      });
    }, timeoutMs);
    const checkState = () => {
      if (isFinished)
        return;
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
      const windowMs = isComplete ? 200 : defaultStabilizationMs;
      stabilizationTimer = setTimeout(() => {
        const reVerifiedLatest = getLatestAssistantMessageElement(logger);
        const reVerifiedContent = reVerifiedLatest ? extractAssistantContent(reVerifiedLatest, logger) : "";
        if (reVerifiedContent.trim().length > 0 && reVerifiedContent === lastExtractedContent) {
          logger.log(`Response text verified stable (${reVerifiedContent.length} chars). Completing askGemini request!`);
          finish({
            success: true,
            content: reVerifiedContent
          });
        } else {
          logger.log("Response text changed during stabilization window, continuing stream observation...");
        }
      }, windowMs);
    };
    observer = new MutationObserver(() => {
      checkState();
    });
    const targetContainer = document.querySelector("main") || document.body;
    observer.observe(targetContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });
    pollIntervalTimer = setInterval(() => {
      checkState();
    }, 300);
    logger.log("Started MutationObserver & 300ms polling watcher for Gemini response...");
    checkState();
  });
}

// src/content/index.ts
console.log("[GeminiBridge] Content script loaded on Gemini page.");
function setupKeepAlivePort() {
  try {
    const port = chrome.runtime.connect({ name: "gemini-keepalive" });
    port.onDisconnect.addListener(() => {
      setTimeout(setupKeepAlivePort, 1e3);
    });
  } catch {
  }
}
setupKeepAlivePort();
async function handleExecutePrompt(requestId, prompt, timeoutMs, stabilizationMs) {
  const logger = new GeminiLogger(requestId);
  logger.log("Starting execution of prompt in Gemini tab content script.");
  const composer = findGeminiComposer(logger);
  if (!composer) {
    logger.error("Failed to locate Gemini composer element.");
    return createErrorResponse(
      requestId,
      "COMPOSER_NOT_FOUND",
      "Could not locate Gemini composer input element on the page."
    );
  }
  const baseline = captureResponseBaseline(logger);
  const insertedSuccessfully = await setComposerValue(composer, prompt, logger);
  if (!insertedSuccessfully) {
    logger.error("Failed to insert prompt into composer.");
    return createErrorResponse(
      requestId,
      "PROMPT_INPUT_FAILED",
      "Failed to insert prompt text into Gemini input element."
    );
  }
  let sendButton = null;
  try {
    sendButton = await waitForCondition(() => findSendButton(logger), {
      timeoutMs: 5e3,
      intervalMs: 100,
      description: "Send button appearance after prompt insertion"
    });
  } catch {
    sendButton = null;
  }
  if (!sendButton) {
    logger.error("Failed to locate Send button after waiting for DOM update.");
    return createErrorResponse(
      requestId,
      "SEND_BUTTON_NOT_FOUND",
      "Could not locate Send button in Gemini UI after prompt insertion."
    );
  }
  try {
    await waitForCondition(() => isSendButtonEnabled(sendButton), {
      timeoutMs: 3e3,
      intervalMs: 100,
      description: "Send button enabled state"
    });
  } catch {
    logger.error("Send button remained disabled.");
    return createErrorResponse(
      requestId,
      "SEND_BUTTON_DISABLED",
      "Gemini Send button is currently disabled."
    );
  }
  triggerSend(sendButton, composer, logger);
  logger.log("Prompt submitted. Observing response streaming and completion...");
  const observation = await observeResponseCompletion({
    baseline,
    timeoutMs,
    stabilizationMs,
    logger
  });
  if (!observation.success || !observation.content) {
    return createErrorResponse(
      requestId,
      observation.error || "GENERATION_FAILED",
      observation.details || "Failed to capture assistant response content."
    );
  }
  logger.log(`Response completed successfully (${observation.content.length} chars).`);
  return createSuccessResponse(requestId, observation.content);
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXECUTE_GEMINI_PROMPT") {
    handleExecutePrompt(
      message.requestId,
      message.prompt,
      message.timeoutMs,
      message.stabilizationMs
    ).then((result) => sendResponse(result)).catch((err) => {
      sendResponse(
        createErrorResponse(
          message.requestId,
          "UNKNOWN_ERROR",
          err instanceof Error ? err.message : String(err)
        )
      );
    });
    return true;
  }
  return false;
});
