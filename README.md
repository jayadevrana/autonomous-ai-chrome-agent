# Autonomous AI Chrome Extension Agent (Manifest v3)

This extension now uses an injected **floating sidebar** (Claude-style) as the primary UI.

## Architecture

- `content.js`:
  - Injects persistent floating sidebar into web pages
  - Renders live status/logs/final result
  - Handles user controls (start/stop/save settings/confirm actions)
  - Extracts DOM summary and executes in-page actions via `executor.js`
- `background.js`:
  - Runs planner-executor loop
  - Calls OpenAI APIs
  - Manages state, memory, logs, safety confirmation flow
  - Guarantees `finalResult` output on completion, max-step cutoff, and runtime errors
- `openai.js`:
  - Planner (`planNextActions`) with strict JSON schema
  - Finalizer (`finalizeResultWithOpenAI`) for best-possible answer from partial progress
- `popup.html` + `popup.js`:
  - Lightweight controls only (open/toggle sidebar, stop run)

## Status Model

Run status values:

- `in_progress`
- `completed`
- `max_steps_reached`
- `error`

The sidebar badge maps these statuses with distinct colors.

## Max-Step Finalization Behavior

When `maxSteps` is hit:

1. The run status becomes `max_steps_reached`
2. Agent collects partial data (texts, links, extracted notes, action history, log tail)
3. Agent calls finalizer model step
4. UI receives `finalResult` object (never silent termination)

## Supported Actions

- `click`
- `type`
- `hover`
- `scroll`
- `wait`
- `navigate`
- `open_new_tab`
- `extract_text`
- `screenshot`
- `go_back`

## Setup

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder (the one containing `manifest.json`)
5. Click extension icon and press **Open Sidebar**

## Configure API Key

In sidebar:

1. Enter/update OpenAI API key
2. Set model and max steps
3. Toggle confirmation mode as needed
4. Click **Save**

## Notes

- API key is stored in `chrome.storage.local`
- OpenAI requests are made from the background service worker
- Content script UI stays visible while navigating page interactions

## Author

Built by [Jayadev Rana](https://jayadevrana.in) — @bluealgocapital · [YouTube](https://www.youtube.com/@jayadevrana3657) · [GitHub](https://github.com/jayadevrana)

