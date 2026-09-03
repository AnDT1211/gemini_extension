# Gemini Web Chrome Extension & Local HTTP Bridge

A Manifest V3 Chrome Extension and Local HTTP/WebSocket Bridge Server that exposes a standard local HTTP API (`POST http://127.0.0.1:3456/ask`) to interact with an open Google Gemini web UI tab ([https://gemini.google.com/](https://gemini.google.com/)).

This allows any external application (Java, Python, Node.js, Go, cURL, Postman, shell scripts, etc.) to programmatic send prompts and receive responses from Gemini Web UI.

---

## Architecture

```text
External Application (Java, Python, Node, cURL)
        |
        | HTTP POST /ask (http://127.0.0.1:3456)
        v
Local HTTP Bridge Server
        |
        | WebSocket (ws://127.0.0.1:3456/ws)
        v
Chrome Extension Background Service Worker (Manifest V3)
        |
        | chrome.tabs.sendMessage
        v
Gemini Content Script
        |
        v
Gemini Web UI (https://gemini.google.com)
```

---

## Output Build Directory Structure

```text
dist/
├── extension/          # Unpacked Chrome extension (load in chrome://extensions)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── bridge/
    └── index.js        # Node.js Local Bridge Server
```

---

## Quick Start Guide

### 1. Installation & Build

```bash
# 1. Install dependencies
npm install

# 2. Build both Chrome extension and Bridge Server
npm run build
```

### 2. Load Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle switch in the top-right corner).
3. Click **Load unpacked**.
4. Select the directory: `dist/extension/`
5. Open a browser tab to [https://gemini.google.com/](https://gemini.google.com/).

### 3. Start the Bridge Server

In your terminal, start the local bridge server:

```bash
npm run start:bridge
```

The bridge server will start at:
- **HTTP Base URL**: `http://127.0.0.1:3456`
- **WebSocket Endpoint**: `ws://127.0.0.1:3456/ws`

---

## API Endpoints & Usage

### 1. Health Check

Verify that the local bridge process is running.

```bash
curl http://127.0.0.1:3456/health
```

**Response (200 OK):**
```json
{
  "status": "ok"
}
```

---

### 2. Connection Status

Check if the Chrome extension is connected to the bridge server over WebSocket.

```bash
curl http://127.0.0.1:3456/status
```

**Response (200 OK):**
```json
{
  "bridgeServer": "ready",
  "extensionConnected": true,
  "connectedAt": "2026-09-03T01:28:00.000Z"
}
```

---

### 3. Ask Gemini (`POST /ask`)

Submit a prompt to Gemini and receive the assistant's response.

#### Simple Request Example

```bash
curl -X POST http://127.0.0.1:3456/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain Java virtual threads in one sentence"}'
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "requestId": "req_885545f3-628c-4063-bc0a-d2941bc3c415",
  "answer": "Virtual threads are lightweight, JVM-managed threads designed to dramatically simplify high-throughput concurrent applications."
}
```

#### Complex / Multi-line Prompt Example

For long prompts with newlines, quotes, or JSON schemas, use a cURL heredoc format:

```bash
curl -X POST http://127.0.0.1:3456/ask \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "prompt": "You are a precise NLP analyzer.\nExtract key terms from: He decided to spend the night there."
}
EOF
```

---

## Environment Configuration

You can customize server parameters using environment variables:

| Variable | Default | Description |
|---|---|---|
| `GEMINI_BRIDGE_HOST` | `127.0.0.1` | Host address to bind (local only by default). |
| `GEMINI_BRIDGE_PORT` | `3456` | HTTP and WebSocket port. |
| `GEMINI_BRIDGE_REQUEST_TIMEOUT_MS` | `120000` | Request timeout in milliseconds (2 minutes). |
| `GEMINI_BRIDGE_MAX_PROMPT_LENGTH` | `50000` | Maximum character length for prompt strings. |
| `GEMINI_BRIDGE_TOKEN` | `""` | Optional Bearer authorization token. |
| `GEMINI_BRIDGE_CORS_ORIGIN` | `""` | Allowed origin header for browser callers (disabled by default). |

### Optional Token Authorization Example

If `GEMINI_BRIDGE_TOKEN=mysecrettoken` is set:

```bash
curl -X POST http://127.0.0.1:3456/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mysecrettoken" \
  -d '{"prompt":"Hello Gemini"}'
```

---

## Error Handling Reference

| HTTP Status | Error Code | Description |
|---|---|---|
| `400` | `INVALID_REQUEST` | Malformed JSON, missing prompt, or prompt exceeds length limit. |
| `401` | `UNAUTHORIZED` | Invalid or missing `Authorization: Bearer <token>`. |
| `502` / `503` | `WEBSOCKET_DISCONNECTED` | WebSocket connection dropped during request execution. |
| `503` | `EXTENSION_NOT_CONNECTED` | Chrome extension is not connected to the local bridge. |
| `504` | `BRIDGE_TIMEOUT` | Exceeded timeout waiting for Gemini response. |
| `200` (success: false) | `GEMINI_TAB_NOT_FOUND` | No open `https://gemini.google.com/*` tab found in Chrome. |
| `200` (success: false) | `GEMINI_BUSY` | Selected Gemini tab is busy processing another prompt. |

---

## Development & Testing

```bash
# Run TypeScript type check
npm run typecheck

# Build Chrome Extension only
npm run build:extension

# Build Bridge Server only
npm run build:bridge

# Run full integration test suite (10 automated test scenarios)
npm test
```
