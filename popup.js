/**
 * Query helper.
 * @param {string} selector
 * @returns {HTMLElement}
 */
function qs(selector) {
  return document.querySelector(selector);
}

const ui = {
  openSidebar: qs("#openSidebar"),
  toggleSidebar: qs("#toggleSidebar"),
  stopAgent: qs("#stopAgent"),
  statusBadge: qs("#statusBadge"),
  statusText: qs("#statusText")
};

/**
 * Send background message.
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

/**
 * Render status text and badge.
 * @param {object} state
 */
function renderState(state) {
  const current = state || {};
  const status = current.status || "idle";

  ui.statusBadge.textContent = status;
  ui.statusBadge.className = `badge ${status}`;

  const lines = [];
  lines.push(`Step ${current.step || 0}/${current.maxSteps || 0}`);
  if (current.finalSummary) {
    lines.push(current.finalSummary);
  }
  if (current.error) {
    lines.push(`Error: ${current.error}`);
  }

  ui.statusText.textContent = lines.join("\n");
}

/**
 * Pull latest state from background.
 * @returns {Promise<void>}
 */
async function refreshState() {
  const response = await sendMessage({ type: "GET_AGENT_STATE" });
  if (response?.ok) {
    renderState(response.state || {});
  }
}

/**
 * Bind popup events.
 */
function bindEvents() {
  ui.openSidebar.addEventListener("click", async () => {
    const response = await sendMessage({ type: "OPEN_SIDEBAR" });
    if (!response?.ok) {
      ui.statusText.textContent = response?.error || "Failed to open sidebar.";
    } else {
      await refreshState();
    }
  });

  ui.toggleSidebar.addEventListener("click", async () => {
    const response = await sendMessage({ type: "TOGGLE_SIDEBAR" });
    if (!response?.ok) {
      ui.statusText.textContent = response?.error || "Failed to toggle sidebar.";
    }
  });

  ui.stopAgent.addEventListener("click", async () => {
    const response = await sendMessage({ type: "STOP_AGENT" });
    if (!response?.ok) {
      ui.statusText.textContent = response?.error || "Failed to stop agent.";
    }
    await refreshState();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "AGENT_STATE_UPDATE") {
      renderState(message.state || {});
    }
  });
}

bindEvents();
refreshState();
