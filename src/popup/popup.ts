import { GeminiMessage } from '../shared/messages.js';
import { GeminiResponse } from '../shared/types.js';

document.addEventListener('DOMContentLoaded', () => {
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

  askBtn.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      setStatus('error', 'Empty prompt');
      return;
    }

    setStatus('working');
    askBtn.disabled = true;
    responseBox.className = 'response-box placeholder';
    responseBox.textContent = 'Waiting for Gemini generation...';
    charCount.textContent = '0 chars';

    const requestId = crypto.randomUUID();
    const message: GeminiMessage = {
      type: 'ASK_GEMINI_REQUEST',
      requestId,
      prompt
    };

    try {
      const response: GeminiResponse = await chrome.runtime.sendMessage(message);

      if (response && response.status === 'success' && response.content) {
        setStatus('success');
        responseBox.className = 'response-box';
        responseBox.textContent = response.content;
        charCount.textContent = `${response.content.length} chars`;
      } else {
        const errCode = response?.error || 'UNKNOWN_ERROR';
        setStatus('error', errCode);
        responseBox.className = 'response-box placeholder';
        responseBox.textContent = `Request failed: ${errCode}\n${response?.details || ''}`;
      }
    } catch (err) {
      setStatus('error', 'Runtime error');
      responseBox.className = 'response-box placeholder';
      responseBox.textContent = `Extension runtime error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      askBtn.disabled = false;
    }
  });
});
