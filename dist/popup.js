// src/popup/popup.ts
document.addEventListener("DOMContentLoaded", () => {
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
  askBtn.addEventListener("click", async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      setStatus("error", "Empty prompt");
      return;
    }
    setStatus("working");
    askBtn.disabled = true;
    responseBox.className = "response-box placeholder";
    responseBox.textContent = "Waiting for Gemini generation...";
    charCount.textContent = "0 chars";
    const requestId = crypto.randomUUID();
    const message = {
      type: "ASK_GEMINI_REQUEST",
      requestId,
      prompt
    };
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response && response.status === "success" && response.content) {
        setStatus("success");
        responseBox.className = "response-box";
        responseBox.textContent = response.content;
        charCount.textContent = `${response.content.length} chars`;
      } else {
        const errCode = response?.error || "UNKNOWN_ERROR";
        setStatus("error", errCode);
        responseBox.className = "response-box placeholder";
        responseBox.textContent = `Request failed: ${errCode}
${response?.details || ""}`;
      }
    } catch (err) {
      setStatus("error", "Runtime error");
      responseBox.className = "response-box placeholder";
      responseBox.textContent = `Extension runtime error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      askBtn.disabled = false;
    }
  });
});
