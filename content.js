(() => {
  if (window.__AI_AGENT_CONTENT_LOADED) {
    return;
  }
  window.__AI_AGENT_CONTENT_LOADED = true;

  const MAX_TEXT_LEN = 160;
  const SIDEBAR_ID = "ai-agent-sidebar";
  const STYLE_ID = "ai-agent-sidebar-style";
  const HIDDEN_CLASS = "ai-agent-hidden";
  const UI_PREFS_KEY = "agentUiPrefs";

  let isResizing = false;
  let contextInvalidated = false;
  let contextInvalidatedNoticeShown = false;
  let lastLocalErrorMessage = "";
  let lastLocalErrorAt = 0;

  /**
   * Check whether runtime error indicates stale/invalidated extension context.
   * @param {any} error
   * @returns {boolean}
   */
  function isContextInvalidatedError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return (
      message.includes("extension context invalidated") ||
      message.includes("receiving end does not exist") ||
      message.includes("could not establish connection") ||
      message.includes("message port closed")
    );
  }

  /**
   * Show one-time invalidation warning and disable controls until refresh.
   */
  function handleContextInvalidated() {
    if (contextInvalidatedNoticeShown) {
      return;
    }
    contextInvalidatedNoticeShown = true;

    const sidebar = ensureSidebar();
    for (const key of ["save", "start", "stop", "approve", "deny"]) {
      const control = el(sidebar, key);
      if (control) {
        control.disabled = true;
      }
    }
    appendLocalError(sidebar, "Extension was reloaded/updated. Refresh this tab, then reopen the sidebar.");
  }

  /**
   * Runtime message helper.
   * @param {object} message
   * @returns {Promise<any>}
   */
  async function sendMessage(message) {
    if (contextInvalidated) {
      throw new Error("Extension was reloaded/updated. Refresh this tab to reconnect.");
    }

    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        contextInvalidated = true;
        handleContextInvalidated();
        throw new Error("Extension was reloaded/updated. Refresh this tab to reconnect.");
      }
      throw error;
    }
  }

  /**
   * Read from chrome.storage.local.
   * @param {string|string[]|object} key
   * @returns {Promise<object>}
   */
  function storageGet(key) {
    return new Promise((resolve) => chrome.storage.local.get(key, resolve));
  }

  /**
   * Write to chrome.storage.local.
   * @param {object} value
   * @returns {Promise<void>}
   */
  function storageSet(value) {
    return new Promise((resolve) => chrome.storage.local.set(value, resolve));
  }

  /**
   * Load sidebar UI preferences.
   * @returns {Promise<{sidebarOpen:boolean,width:number}>}
   */
  async function getUiPrefs() {
    const res = await storageGet(UI_PREFS_KEY);
    return {
      sidebarOpen: false,
      width: 420,
      ...(res[UI_PREFS_KEY] || {})
    };
  }

  /**
   * Persist sidebar UI preferences.
   * @param {Partial<{sidebarOpen:boolean,width:number}>} patch
   * @returns {Promise<void>}
   */
  async function setUiPrefs(patch) {
    const current = await getUiPrefs();
    await storageSet({ [UI_PREFS_KEY]: { ...current, ...patch } });
  }

  /**
   * Escape selector text safely.
   * @param {string} value
   * @returns {string}
   */
  function esc(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/(["\\])/g, "\\$1");
  }

  /**
   * Check if element is visible enough for interaction.
   * @param {Element} element
   * @returns {boolean}
   */
  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0
    );
  }

  /**
   * Build stable selector for an element.
   * @param {Element} element
   * @returns {string}
   */
  function getElementSelector(element) {
    if (!element || !(element instanceof Element)) {
      return "";
    }

    if (element.id) {
      return `#${esc(element.id)}`;
    }

    const dataTestId = element.getAttribute("data-testid") || element.getAttribute("data-test");
    if (dataTestId) {
      return `[data-testid="${esc(dataTestId)}"]`;
    }

    const name = element.getAttribute("name");
    if (name) {
      return `${element.tagName.toLowerCase()}[name="${esc(name)}"]`;
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return `${element.tagName.toLowerCase()}[aria-label="${esc(ariaLabel)}"]`;
    }

    const role = element.getAttribute("role");
    if (role) {
      return `${element.tagName.toLowerCase()}[role="${esc(role)}"]`;
    }

    const classes = [...element.classList].filter(Boolean).slice(0, 2);
    if (classes.length > 0) {
      return `${element.tagName.toLowerCase()}.${classes.map((c) => esc(c)).join(".")}`;
    }

    const path = [];
    let current = element;
    let depth = 0;

    while (current && current.parentElement && depth < 4) {
      const tag = current.tagName.toLowerCase();
      const siblings = [...current.parentElement.children].filter(
        (sibling) => sibling.tagName === current.tagName
      );
      const index = siblings.indexOf(current) + 1;
      path.unshift(`${tag}:nth-of-type(${index})`);
      current = current.parentElement;
      depth += 1;
    }

    return path.join(" > ");
  }

  /**
   * Read concise text from element.
   * @param {Element} element
   * @returns {string}
   */
  function getReadableText(element) {
    const text =
      element.innerText ||
      element.textContent ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      "";

    return text.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT_LEN);
  }

  /**
   * Extract metadata for form fields.
   * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} element
   * @returns {object}
   */
  function summarizeField(element) {
    return {
      selector: getElementSelector(element),
      name: element.getAttribute("name") || "",
      type: element.getAttribute("type") || element.tagName.toLowerCase(),
      placeholder: element.getAttribute("placeholder") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      required: Boolean(element.required)
    };
  }

  /**
   * Collect concise interactive DOM snapshot.
   * @returns {object}
   */
  function extractDomSummary() {
    const buttons = [...document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")]
      .filter((el) => isVisible(el))
      .slice(0, 80)
      .map((el) => ({
        text: getReadableText(el),
        selector: getElementSelector(el),
        role: el.getAttribute("role") || "",
        disabled: Boolean(el.disabled)
      }));

    const links = [...document.querySelectorAll("a[href]")]
      .filter((el) => isVisible(el))
      .slice(0, 80)
      .map((el) => ({
        text: getReadableText(el),
        selector: getElementSelector(el),
        href: el.href || ""
      }));

    const inputs = [...document.querySelectorAll("input")]
      .filter((el) => isVisible(el))
      .slice(0, 120)
      .map((el) => summarizeField(el));

    const textareas = [...document.querySelectorAll("textarea")]
      .filter((el) => isVisible(el))
      .slice(0, 60)
      .map((el) => summarizeField(el));

    const selects = [...document.querySelectorAll("select")]
      .filter((el) => isVisible(el))
      .slice(0, 60)
      .map((el) => ({
        ...summarizeField(el),
        options: [...el.options].slice(0, 10).map((opt) => opt.textContent?.trim() || "")
      }));

    const forms = [...document.querySelectorAll("form")]
      .filter((el) => isVisible(el))
      .slice(0, 30)
      .map((form) => {
        const fields = [...form.querySelectorAll("input, textarea, select")]
          .filter((field) => isVisible(field))
          .slice(0, 20)
          .map((field) => summarizeField(field));

        return {
          selector: getElementSelector(form),
          action: form.getAttribute("action") || "",
          method: form.getAttribute("method") || "get",
          fields
        };
      });

    return {
      title: document.title || "",
      url: window.location.href,
      visibleTextSnapshot: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 3000),
      buttons,
      links,
      inputs,
      textareas,
      selects,
      forms,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Inject sidebar stylesheet once.
   */
  function injectSidebarStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${SIDEBAR_ID} {
        position: fixed;
        top: 0;
        right: 0;
        width: 420px;
        max-width: 88vw;
        min-width: 320px;
        height: 100vh;
        z-index: 2147483646;
        background: #0f172a;
        color: #e2e8f0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        border-left: 1px solid #1e293b;
        box-shadow: -2px 0 16px rgba(0, 0, 0, 0.38);
        display: flex;
        flex-direction: column;
      }
      #${SIDEBAR_ID}.${HIDDEN_CLASS} {
        display: none;
      }
      #${SIDEBAR_ID} * {
        box-sizing: border-box;
      }
      #${SIDEBAR_ID}-resizer {
        position: absolute;
        left: 0;
        top: 0;
        width: 6px;
        height: 100%;
        cursor: ew-resize;
        background: transparent;
      }
      #${SIDEBAR_ID}-header {
        padding: 12px;
        border-bottom: 1px solid #1e293b;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      #${SIDEBAR_ID}-title {
        font-size: 14px;
        font-weight: 700;
        margin: 0;
        color: #f8fafc;
      }
      #${SIDEBAR_ID}-close {
        border: 1px solid #334155;
        background: #111827;
        color: #cbd5e1;
        border-radius: 8px;
        padding: 5px 9px;
        cursor: pointer;
      }
      #${SIDEBAR_ID}-status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid #1e293b;
        font-size: 12px;
      }
      #${SIDEBAR_ID}-status-badge {
        border-radius: 999px;
        padding: 3px 10px;
        font-weight: 700;
      }
      #${SIDEBAR_ID}-status-badge.idle { background: #1f2937; color: #cbd5e1; }
      #${SIDEBAR_ID}-status-badge.in_progress { background: #0b3b66; color: #bfdbfe; }
      #${SIDEBAR_ID}-status-badge.completed { background: #14532d; color: #dcfce7; }
      #${SIDEBAR_ID}-status-badge.max_steps_reached { background: #78350f; color: #fef3c7; }
      #${SIDEBAR_ID}-status-badge.error { background: #7f1d1d; color: #fee2e2; }
      #${SIDEBAR_ID}-thinking {
        padding: 10px 12px;
        border-bottom: 1px solid #1e293b;
        background: #0b1324;
      }
      #${SIDEBAR_ID}-processing {
        font-size: 11px;
        color: #7dd3fc;
        margin-bottom: 6px;
      }
      #${SIDEBAR_ID}-thinking-label,
      #${SIDEBAR_ID}-next-label {
        font-size: 11px;
        color: #93c5fd;
        margin-bottom: 4px;
      }
      #${SIDEBAR_ID}-thinking-text {
        margin: 0 0 8px;
        white-space: pre-wrap;
        font-size: 11px;
        color: #dbeafe;
        max-height: 92px;
        overflow: auto;
      }
      #${SIDEBAR_ID}-next-step {
        font-size: 11px;
        color: #cbd5e1;
        white-space: pre-wrap;
      }
      #${SIDEBAR_ID}-controls {
        padding: 10px 12px;
        border-bottom: 1px solid #1e293b;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #${SIDEBAR_ID} label {
        font-size: 11px;
        color: #93c5fd;
        margin-bottom: 3px;
        display: block;
      }
      #${SIDEBAR_ID} textarea,
      #${SIDEBAR_ID} input {
        width: 100%;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #111827;
        color: #e2e8f0;
        padding: 8px;
        font-size: 12px;
      }
      #${SIDEBAR_ID}-instruction { min-height: 74px; resize: vertical; }
      #${SIDEBAR_ID}-settings-grid {
        display: grid;
        grid-template-columns: 1fr 100px;
        gap: 8px;
      }
      #${SIDEBAR_ID}-checkbox-row {
        display: flex;
        gap: 6px;
        align-items: center;
        font-size: 11px;
        color: #cbd5e1;
      }
      #${SIDEBAR_ID}-checkbox-row input { width: auto; }
      #${SIDEBAR_ID}-button-row {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
      }
      #${SIDEBAR_ID} button {
        border-radius: 8px;
        border: 1px solid #334155;
        padding: 8px 10px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      #${SIDEBAR_ID}-save { background: #1e293b; color: #bfdbfe; }
      #${SIDEBAR_ID}-start { background: #0b3b66; color: #dbeafe; border-color: #1d4ed8; }
      #${SIDEBAR_ID}-stop { background: #7f1d1d; color: #fee2e2; border-color: #ef4444; }
      #${SIDEBAR_ID}-result {
        border-top: 1px solid #1e293b;
        border-bottom: 1px solid #1e293b;
        padding: 10px 12px;
        font-size: 12px;
        max-height: 220px;
        overflow: auto;
      }
      #${SIDEBAR_ID}-result h4 {
        margin: 0 0 8px;
        font-size: 12px;
        color: #93c5fd;
      }
      #${SIDEBAR_ID}-result pre {
        white-space: pre-wrap;
        margin: 0;
        color: #dbeafe;
      }
      #${SIDEBAR_ID}-confirm {
        border-bottom: 1px solid #1e293b;
        padding: 10px 12px;
      }
      #${SIDEBAR_ID}-confirm[hidden] { display: none; }
      #${SIDEBAR_ID}-confirm pre {
        max-height: 90px;
        overflow: auto;
        white-space: pre-wrap;
        background: #111827;
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 6px;
        margin: 6px 0;
        font-size: 11px;
      }
      #${SIDEBAR_ID}-confirm-row {
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr 1fr;
      }
      #${SIDEBAR_ID}-approve { background: #14532d; color: #dcfce7; border-color: #22c55e; }
      #${SIDEBAR_ID}-deny { background: #7f1d1d; color: #fee2e2; border-color: #ef4444; }
      #${SIDEBAR_ID}-logs {
        flex: 1;
        overflow: auto;
        padding: 10px 12px;
        font-size: 11px;
        line-height: 1.35;
      }
      #${SIDEBAR_ID}-logs .line { margin-bottom: 6px; white-space: pre-wrap; }
      #${SIDEBAR_ID}-logs .line.info { color: #bfdbfe; }
      #${SIDEBAR_ID}-logs .line.warn { color: #fde68a; }
      #${SIDEBAR_ID}-logs .line.error { color: #fecaca; }
    `;

    document.documentElement.appendChild(style);
  }

  /**
   * Build sidebar DOM if absent.
   * @returns {HTMLElement}
   */
  function ensureSidebar() {
    let sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) {
      return sidebar;
    }

    injectSidebarStyles();

    sidebar = document.createElement("aside");
    sidebar.id = SIDEBAR_ID;
    sidebar.classList.add(HIDDEN_CLASS);
    sidebar.innerHTML = `
      <div id="${SIDEBAR_ID}-resizer"></div>
      <div id="${SIDEBAR_ID}-header">
        <p id="${SIDEBAR_ID}-title">AI Browser Agent</p>
        <button id="${SIDEBAR_ID}-close" type="button">Hide</button>
      </div>
      <div id="${SIDEBAR_ID}-status-row">
        <span id="${SIDEBAR_ID}-step">Step 0/0</span>
        <span id="${SIDEBAR_ID}-status-badge" class="idle">idle</span>
      </div>
      <div id="${SIDEBAR_ID}-thinking">
        <div id="${SIDEBAR_ID}-processing">Processing: idle</div>
        <div id="${SIDEBAR_ID}-thinking-label">AI Thinking</div>
        <pre id="${SIDEBAR_ID}-thinking-text">Waiting for instruction.</pre>
        <div id="${SIDEBAR_ID}-next-label">Next Step</div>
        <div id="${SIDEBAR_ID}-next-step">None</div>
      </div>
      <div id="${SIDEBAR_ID}-controls">
        <div>
          <label for="${SIDEBAR_ID}-api">OpenAI API Key</label>
          <input id="${SIDEBAR_ID}-api" type="password" placeholder="Enter OpenAI API key" autocomplete="off" />
        </div>
        <div id="${SIDEBAR_ID}-settings-grid">
          <div>
            <label for="${SIDEBAR_ID}-model">Model</label>
            <input id="${SIDEBAR_ID}-model" type="text" value="gpt-4o" />
          </div>
          <div>
            <label for="${SIDEBAR_ID}-max">Max Steps</label>
            <input id="${SIDEBAR_ID}-max" type="number" min="1" max="60" value="20" />
          </div>
        </div>
        <label id="${SIDEBAR_ID}-checkbox-row">
          <input id="${SIDEBAR_ID}-confirm-toggle" type="checkbox" checked />
          Require confirmation for risky actions
        </label>
        <div>
          <label for="${SIDEBAR_ID}-instruction">Instruction</label>
          <textarea id="${SIDEBAR_ID}-instruction" placeholder="Example: Research top 5 Pine Script developers and summarize them"></textarea>
        </div>
        <div id="${SIDEBAR_ID}-button-row">
          <button id="${SIDEBAR_ID}-save" type="button">Save</button>
          <button id="${SIDEBAR_ID}-start" type="button">Start</button>
          <button id="${SIDEBAR_ID}-stop" type="button">Stop</button>
        </div>
      </div>
      <div id="${SIDEBAR_ID}-result">
        <h4>Final Result</h4>
        <pre id="${SIDEBAR_ID}-result-text">No result yet.</pre>
      </div>
      <div id="${SIDEBAR_ID}-confirm" hidden>
        <div>Action confirmation required:</div>
        <pre id="${SIDEBAR_ID}-confirm-text"></pre>
        <div id="${SIDEBAR_ID}-confirm-row">
          <button id="${SIDEBAR_ID}-approve" type="button">Approve</button>
          <button id="${SIDEBAR_ID}-deny" type="button">Deny</button>
        </div>
      </div>
      <div id="${SIDEBAR_ID}-logs"></div>
    `;

    document.documentElement.appendChild(sidebar);
    bindSidebarEvents(sidebar);
    loadSidebarInitialData().catch((error) => {
      appendLocalError(sidebar, error?.message || "Failed to load sidebar state.");
    });

    return sidebar;
  }

  /**
   * Return child element from sidebar.
   * @param {HTMLElement} sidebar
   * @param {string} suffix
   * @returns {HTMLElement}
   */
  function el(sidebar, suffix) {
    return sidebar.querySelector(`#${SIDEBAR_ID}-${suffix}`);
  }

  /**
   * Open sidebar.
   */
  async function openSidebar(persist = true) {
    const sidebar = ensureSidebar();
    sidebar.classList.remove(HIDDEN_CLASS);
    if (persist) {
      await setUiPrefs({ sidebarOpen: true });
    }
  }

  /**
   * Toggle sidebar visibility.
   */
  async function toggleSidebar() {
    const sidebar = ensureSidebar();
    const willOpen = sidebar.classList.contains(HIDDEN_CLASS);
    sidebar.classList.toggle(HIDDEN_CLASS);
    await setUiPrefs({ sidebarOpen: willOpen });
  }

  /**
   * Save settings from sidebar inputs.
   * @param {HTMLElement} sidebar
   * @returns {Promise<void>}
   */
  async function saveSettingsFromSidebar(sidebar) {
    const response = await sendMessage({
      type: "SAVE_SETTINGS",
      settings: {
        apiKey: (el(sidebar, "api").value || "").trim(),
        model: (el(sidebar, "model").value || "gpt-4o").trim(),
        maxSteps: Number(el(sidebar, "max").value) || 20,
        confirmationMode: Boolean(el(sidebar, "confirm-toggle").checked)
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to save settings");
    }
  }

  /**
   * Start agent using sidebar instruction.
   * @param {HTMLElement} sidebar
   * @returns {Promise<void>}
   */
  async function startAgentFromSidebar(sidebar) {
    const instruction = (el(sidebar, "instruction").value || "").trim();
    if (!instruction) {
      throw new Error("Instruction is required.");
    }
    const apiKeyValue = (el(sidebar, "api").value || "").trim();
    if (!apiKeyValue) {
      throw new Error("OpenAI API key is required. Enter it in the API Key field and click Save.");
    }

    await saveSettingsFromSidebar(sidebar);
    const response = await sendMessage({ type: "START_AGENT", instruction });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to start agent");
    }
  }

  /**
   * Stop active run.
   * @returns {Promise<void>}
   */
  async function stopAgentFromSidebar() {
    await sendMessage({ type: "STOP_AGENT" });
  }

  /**
   * Format final result for rendering.
   * @param {object|null} finalResult
   * @param {string} fallback
   * @returns {string}
   */
  function formatFinalResult(finalResult, fallback) {
    if (!finalResult || typeof finalResult !== "object") {
      return fallback || "No result yet.";
    }

    const lines = [];
    lines.push(`Status: ${finalResult.status || "unknown"}`);
    lines.push(`Summary: ${finalResult.summary || ""}`);

    if (Array.isArray(finalResult.keyFindings) && finalResult.keyFindings.length > 0) {
      lines.push("\nFindings:");
      for (const item of finalResult.keyFindings.slice(0, 8)) {
        lines.push(`- ${item}`);
      }
    }

    if (Array.isArray(finalResult.collectedLinks) && finalResult.collectedLinks.length > 0) {
      lines.push("\nLinks:");
      for (const link of finalResult.collectedLinks.slice(0, 8)) {
        lines.push(`- ${link}`);
      }
    }

    if (Array.isArray(finalResult.nextBestActions) && finalResult.nextBestActions.length > 0) {
      lines.push("\nNext best actions:");
      for (const step of finalResult.nextBestActions.slice(0, 5)) {
        lines.push(`- ${step}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Append local error line in sidebar logs pane.
   * @param {HTMLElement} sidebar
   * @param {string} message
   */
  function appendLocalError(sidebar, message) {
    const normalized = String(message || "Unknown error").trim();
    const now = Date.now();
    if (normalized && normalized === lastLocalErrorMessage && now - lastLocalErrorAt < 1500) {
      return;
    }
    lastLocalErrorMessage = normalized;
    lastLocalErrorAt = now;

    const logs = el(sidebar, "logs");
    const line = document.createElement("div");
    line.className = "line error";
    line.textContent = `[ERROR] ${normalized}`;
    logs.appendChild(line);
    logs.scrollTop = logs.scrollHeight;
  }

  /**
   * Render full state in sidebar.
   * @param {object} state
   */
  function renderState(state) {
    const sidebar = ensureSidebar();
    const current = state || {};

    const status = current.status || "idle";
    const statusBadge = el(sidebar, "status-badge");
    statusBadge.textContent = status;
    statusBadge.className = status;

    el(sidebar, "step").textContent = `Step ${current.step || 0}/${current.maxSteps || 0}`;
    el(sidebar, "processing").textContent = `Processing: ${current.processingStage || "idle"}`;
    el(sidebar, "thinking-text").textContent =
      current.currentThought || current.currentPlanSummary || "Waiting for planner output.";
    el(sidebar, "next-step").textContent = current.nextStepPreview || "None";
    el(sidebar, "result-text").textContent = formatFinalResult(current.finalResult, current.finalSummary || current.error || "");

    const logs = Array.isArray(current.logs) ? current.logs.slice(-200) : [];
    const logsEl = el(sidebar, "logs");
    logsEl.innerHTML = "";
    if (logs.length === 0) {
      logsEl.innerHTML = '<div class="line info">No logs yet.</div>';
    } else {
      for (const log of logs) {
        const line = document.createElement("div");
        line.className = `line ${log.level || "info"}`;
        const time = new Date(log.timestamp || Date.now()).toLocaleTimeString();
        line.textContent = `[${time}] [${(log.level || "info").toUpperCase()}] ${log.message || ""}`;
        logsEl.appendChild(line);
      }
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    const confirmPanel = el(sidebar, "confirm");
    const confirmText = el(sidebar, "confirm-text");
    if (current.pendingAction) {
      confirmText.textContent = JSON.stringify(current.pendingAction, null, 2);
      confirmPanel.hidden = false;
    } else {
      confirmText.textContent = "";
      confirmPanel.hidden = true;
    }

    const running = Boolean(current.running);
    el(sidebar, "start").disabled = running;
    el(sidebar, "stop").disabled = !running && !current.pendingAction;
  }

  /**
   * Render settings in sidebar.
   * @param {object} settings
   */
  function renderSettings(settings) {
    const sidebar = ensureSidebar();
    const current = settings || {};

    el(sidebar, "api").value = current.apiKey || "";
    el(sidebar, "model").value = current.model || "gpt-4o";
    el(sidebar, "max").value = String(current.maxSteps || 20);
    el(sidebar, "confirm-toggle").checked = Boolean(current.confirmationMode);
  }

  /**
   * Load initial state/settings after sidebar injection.
   */
  async function loadSidebarInitialData() {
    const sidebar = ensureSidebar();
    const [stateResult, settingsResult, prefsResult] = await Promise.allSettled([
      sendMessage({ type: "GET_AGENT_STATE" }),
      sendMessage({ type: "GET_SETTINGS" }),
      getUiPrefs()
    ]);
    const stateRes = stateResult.status === "fulfilled" ? stateResult.value : null;
    const settingsRes = settingsResult.status === "fulfilled" ? settingsResult.value : null;
    const prefs = prefsResult.status === "fulfilled" ? prefsResult.value : { sidebarOpen: false, width: 420 };

    if (stateResult.status === "rejected") {
      appendLocalError(sidebar, stateResult.reason?.message || "Failed to fetch agent state.");
    }
    if (settingsResult.status === "rejected") {
      appendLocalError(sidebar, settingsResult.reason?.message || "Failed to fetch settings.");
    }

    if (stateRes?.ok) {
      renderState(stateRes.state || {});
    }

    if (settingsRes?.ok) {
      renderSettings(settingsRes.settings || {});
      if (!settingsRes?.settings?.apiKey) {
        appendLocalError(sidebar, "No API key saved. Enter your OpenAI key above and click Save before starting.");
      }
    }

    const safeWidth = Math.max(320, Math.min(Number(prefs.width) || 420, Math.floor(window.innerWidth * 0.9)));
    sidebar.style.width = `${safeWidth}px`;

    const running = Boolean(stateRes?.state?.running);
    if (prefs.sidebarOpen || running) {
      sidebar.classList.remove(HIDDEN_CLASS);
      if (running) {
        await setUiPrefs({ sidebarOpen: true, width: safeWidth });
      }
    } else {
      sidebar.classList.add(HIDDEN_CLASS);
    }
  }

  /**
   * Bind resize and button events.
   * @param {HTMLElement} sidebar
   */
  function bindSidebarEvents(sidebar) {
    const resizer = el(sidebar, "resizer");
    resizer.addEventListener("mousedown", () => {
      isResizing = true;
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (event) => {
      if (!isResizing) {
        return;
      }

      const width = Math.min(Math.max(window.innerWidth - event.clientX, 320), Math.floor(window.innerWidth * 0.9));
      sidebar.style.width = `${width}px`;
    });

    document.addEventListener("mouseup", () => {
      const wasResizing = isResizing;
      isResizing = false;
      document.body.style.userSelect = "";
      if (wasResizing) {
        const width = Math.max(320, Math.min(parseInt(sidebar.style.width, 10) || 420, Math.floor(window.innerWidth * 0.9)));
        setUiPrefs({ width }).catch(() => {});
      }
    });

    el(sidebar, "close").addEventListener("click", () => {
      sidebar.classList.add(HIDDEN_CLASS);
      setUiPrefs({ sidebarOpen: false }).catch(() => {});
    });

    el(sidebar, "save").addEventListener("click", async () => {
      try {
        await saveSettingsFromSidebar(sidebar);
      } catch (error) {
        appendLocalError(sidebar, error.message);
      }
    });

    el(sidebar, "start").addEventListener("click", async () => {
      try {
        await startAgentFromSidebar(sidebar);
      } catch (error) {
        appendLocalError(sidebar, error.message);
      }
    });

    el(sidebar, "stop").addEventListener("click", async () => {
      await stopAgentFromSidebar();
    });

    el(sidebar, "approve").addEventListener("click", async () => {
      try {
        await sendMessage({ type: "APPROVE_PENDING_ACTION" });
      } catch (error) {
        appendLocalError(sidebar, error.message);
      }
    });

    el(sidebar, "deny").addEventListener("click", async () => {
      try {
        await sendMessage({ type: "DENY_PENDING_ACTION" });
      } catch (error) {
        appendLocalError(sidebar, error.message);
      }
    });
  }

  /**
   * Handle runtime messages.
   * @param {object} message
   * @param {chrome.runtime.MessageSender} _sender
   * @param {(response: object) => void} sendResponse
   * @returns {boolean}
   */
  function onMessage(message, _sender, sendResponse) {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "AGENT_EXTRACT_DOM") {
      try {
        const domSummary = extractDomSummary();
        sendResponse({ ok: true, domSummary });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return true;
    }

    if (message.type === "AGENT_EXECUTE_ACTION") {
      (async () => {
        try {
          if (!window.AgentExecutor || typeof window.AgentExecutor.executeAction !== "function") {
            sendResponse({ ok: false, error: "Agent executor not initialized" });
            return;
          }

          const result = await window.AgentExecutor.executeAction(message.action || {});
          sendResponse({ ok: true, result });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      })();
      return true;
    }

    if (message.type === "AGENT_STATE_UPDATE") {
      renderState(message.state || {});
      return false;
    }

    if (message.type === "AGENT_OPEN_SIDEBAR") {
      openSidebar(true)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "AGENT_TOGGLE_SIDEBAR") {
      toggleSidebar()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  ensureSidebar();
})();
