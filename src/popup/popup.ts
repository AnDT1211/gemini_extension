import { GeminiMessage } from '../shared/messages.js';
import { GeminiResponse } from '../shared/types.js';

interface StatusStorage {
  state: 'working' | 'completed';
  requestId: string;
  prompt?: string;
  response?: GeminiResponse;
  timestamp: number;
}

document.addEventListener('DOMContentLoaded', async () => {
  const promptInput = document.getElementById('promptInput') as HTMLTextAreaElement;
  const askBtn = document.getElementById('askBtn') as HTMLButtonElement;
  const statusBadge = document.getElementById('statusBadge') as HTMLSpanElement;
  const responseBox = document.getElementById('responseBox') as HTMLDivElement;
  const charCount = document.getElementById('charCount') as HTMLSpanElement;

  function setStatus(state: 'idle' | 'working' | 'success' | 'error', text?: string) {
    statusBadge.className = `badge ${state}`;
    switch (state) {
      case 'idle':
        statusBadge.textContent = 'Idle';
        break;
      case 'working':
        statusBadge.textContent = 'Working...';
        break;
      case 'success':
        statusBadge.textContent = 'Success';
        break;
      case 'error':
        statusBadge.textContent = text ? `Error: ${text}` : 'Error';
        break;
    }
  }

  function renderResponse(response: GeminiResponse) {
    console.log('[GeminiBridge Popup] Rendering response:', response);
    if (response.status === 'success' && response.content) {
      setStatus('success');
      responseBox.className = 'response-box';
      responseBox.innerText = response.content;
      charCount.textContent = `${response.content.length} chars`;
    } else {
      const errCode = response.error || 'UNKNOWN_ERROR';
      setStatus('error', errCode);
      responseBox.className = 'response-box placeholder';
      responseBox.innerText = `Request failed: ${errCode}\n${response.details || ''}`;
    }
    askBtn.disabled = false;
  }

  function syncWithStatus(latestStatus?: StatusStorage) {
    console.log('[GeminiBridge Popup] Syncing status:', latestStatus);
    if (!latestStatus) return;

    if (latestStatus.prompt && !promptInput.value.trim()) {
      promptInput.value = latestStatus.prompt;
    }

    if (latestStatus.state === 'working') {
      // Ignore stale working states older than 2 minutes
      const ageMs = Date.now() - (latestStatus.timestamp || 0);
      if (ageMs > 120_000) {
        console.warn('[GeminiBridge Popup] Ignoring stale working status older than 2m');
        setStatus('idle');
        askBtn.disabled = false;
        return;
      }

      setStatus('working');
      askBtn.disabled = true;
      responseBox.className = 'response-box placeholder';
      responseBox.innerText = 'Waiting for Gemini generation...';
      charCount.textContent = '0 chars';
    } else if (latestStatus.state === 'completed' && latestStatus.response) {
      renderResponse(latestStatus.response);
    }
  }

  // Restore latest status on popup opening
  try {
    const data = await chrome.storage.local.get('latestStatus');
    if (data.latestStatus) {
      syncWithStatus(data.latestStatus as StatusStorage);
    }
  } catch (e) {
    console.warn('[GeminiBridge Popup] Failed to load initial storage status:', e);
  }

  // Listen to storage changes in real-time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.latestStatus?.newValue) {
      syncWithStatus(changes.latestStatus.newValue as StatusStorage);
    }
  });

  askBtn.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      setStatus('error', 'Empty prompt');
      return;
    }

    setStatus('working');
    askBtn.disabled = true;
    responseBox.className = 'response-box placeholder';
    responseBox.innerText = 'Waiting for Gemini generation...';
    charCount.textContent = '0 chars';

    const requestId = crypto.randomUUID();
    const message: GeminiMessage = {
      type: 'ASK_GEMINI_REQUEST',
      requestId,
      prompt
    };

    try {
      console.log('[GeminiBridge Popup] Sending ASK_GEMINI_REQUEST message to background...');
      const response: GeminiResponse = await chrome.runtime.sendMessage(message);
      console.log('[GeminiBridge Popup] Received direct response from background:', response);
      if (response) {
        renderResponse(response);
      }
    } catch (err) {
      console.error('[GeminiBridge Popup] Error in sendMessage:', err);
      setStatus('error', 'Runtime error');
      responseBox.className = 'response-box placeholder';
      responseBox.innerText = `Extension runtime error: ${err instanceof Error ? err.message : String(err)}`;
      askBtn.disabled = false;
    }
  });
});
