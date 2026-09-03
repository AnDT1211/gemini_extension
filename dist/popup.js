// src/popup/popup.ts
document.addEventListener("DOMContentLoaded", async () => {
  const promptInput = document.getElementById("promptInput");
  const askBtn = document.getElementById("askBtn");
  const statusBadge = document.getElementById("statusBadge");
  const responseBox = document.getElementById("responseBox");
  const charCount = document.getElementById("charCount");
  function setStatus(state, text) {
    statusBadge.className = `badge ${state}`;
    switch (state) {
      case "idle":
        statusBadge.textContent = "Idle";
        break;
      case "working":
        statusBadge.textContent = "Working...";
        break;
      case "success":
        statusBadge.textContent = "Success";
        break;
      case "error":
        statusBadge.textContent = text ? `Error: ${text}` : "Error";
        break;
    }
  }
  function renderResponse(response) {
    console.log("[GeminiBridge Popup] Rendering response:", response);
    if (response.status === "success" && response.content) {
      setStatus("success");
      responseBox.className = "response-box";
      responseBox.innerText = response.content;
      charCount.textContent = `${response.content.length} chars`;
    } else {
      const errCode = response.error || "UNKNOWN_ERROR";
      setStatus("error", errCode);
      responseBox.className = "response-box placeholder";
      responseBox.innerText = `Request failed: ${errCode}
${response.details || ""}`;
    }
    askBtn.disabled = false;
  }
  function syncWithStatus(latestStatus) {
    console.log("[GeminiBridge Popup] Syncing status:", latestStatus);
    if (!latestStatus)
      return;
    if (latestStatus.prompt && !promptInput.value.trim()) {
      promptInput.value = latestStatus.prompt;
    }
    if (latestStatus.state === "working") {
      const ageMs = Date.now() - (latestStatus.timestamp || 0);
      if (ageMs > 12e4) {
        console.warn("[GeminiBridge Popup] Ignoring stale working status older than 2m");
        setStatus("idle");
        askBtn.disabled = false;
        return;
      }
      setStatus("working");
      askBtn.disabled = true;
      responseBox.className = "response-box placeholder";
      responseBox.innerText = "Waiting for Gemini generation...";
      charCount.textContent = "0 chars";
    } else if (latestStatus.state === "completed" && latestStatus.response) {
      renderResponse(latestStatus.response);
    }
  }
  try {
    const data = await chrome.storage.local.get("latestStatus");
    if (data.latestStatus) {
      syncWithStatus(data.latestStatus);
    }
  } catch (e) {
    console.warn("[GeminiBridge Popup] Failed to load initial storage status:", e);
  }
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.latestStatus?.newValue) {
      syncWithStatus(changes.latestStatus.newValue);
    }
  });
  askBtn.addEventListener("click", async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      setStatus("error", "Empty prompt");
      return;
    }
    setStatus("working");
    askBtn.disabled = true;
    responseBox.className = "response-box placeholder";
    responseBox.innerText = "Waiting for Gemini generation...";
    charCount.textContent = "0 chars";
    const requestId = crypto.randomUUID();
    const message = {
      type: "ASK_GEMINI_REQUEST",
      requestId,
      prompt
    };
    try {
      console.log("[GeminiBridge Popup] Sending ASK_GEMINI_REQUEST message to background...");
      const response = await chrome.runtime.sendMessage(message);
      console.log("[GeminiBridge Popup] Received direct response from background:", response);
      if (response) {
        renderResponse(response);
      }
    } catch (err) {
      console.error("[GeminiBridge Popup] Error in sendMessage:", err);
      setStatus("error", "Runtime error");
      responseBox.className = "response-box placeholder";
      responseBox.innerText = `Extension runtime error: ${err instanceof Error ? err.message : String(err)}`;
      askBtn.disabled = false;
    }
  });
});
