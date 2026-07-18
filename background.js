import { finalizeResultWithOpenAI, planNextActions, RUN_STATUS } from "./openai.js";

const STATE_KEY = "agentState";
const SETTINGS_KEY = "agentSettings";
const MEMORY_KEY = "agentMemory";

const DEFAULT_STATE = {
  status: "idle",
  running: false,
  instruction: "",
  tabId: null,
  step: 0,
  maxSteps: 20,
  history: [],
  logs: [],
  pendingAction: null,
  finalSummary: "",
  finalResult: null,
  currentThought: "",
  currentPlanSummary: "",
  nextStepPreview: "",
  processingStage: "idle",
  error: "",
  startedAt: null,
  finishedAt: null
};

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gpt-4o",
  maxSteps: 20,
  confirmationMode: true
};

const DESTRUCTIVE_KEYWORDS = ["delete", "remove", "submit", "purchase", "pay", "logout"];

let inMemoryState = { ...DEFAULT_STATE };
let currentRunToken = null;
let pendingConfirmationResolver = null;

/**
 * Sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run async operation with timeout protection.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 */
async function withTimeout(promise, timeoutMs, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
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
 * Emit state update event for sidebar/popup.
 * @returns {Promise<void>}
 */
async function broadcastState() {
  try {
    await chrome.runtime.sendMessage({ type: "AGENT_STATE_UPDATE", state: inMemoryState });
  } catch {
    // UI may be closed in some contexts.
  }
}

/**
 * Persist state and broadcast update.
 * @returns {Promise<void>}
 */
async function persistAndBroadcast() {
  await storageSet({
    [STATE_KEY]: inMemoryState,
    [MEMORY_KEY]: inMemoryState.history.slice(-120)
  });
  await broadcastState();
}

/**
 * Append one log line into the state buffer.
 * @param {"info"|"warn"|"error"} level
 * @param {string} message
 * @returns {Promise<void>}
 */
async function appendLog(level, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };

  inMemoryState.logs = [...(inMemoryState.logs || []), entry].slice(-300);
  await persistAndBroadcast();
}

/**
 * Return active tab in current focused window.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

/**
 * Check if URL allows content script execution.
 * @param {string} url
 * @returns {boolean}
 */
function isInjectableUrl(url) {
  return /^https?:/i.test(url || "");
}

/**
 * Ensure an injectable tab is available, creating one when needed.
 * @param {chrome.tabs.Tab|null} currentTab
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function getRunnableTab(currentTab) {
  if (currentTab?.id && isInjectableUrl(currentTab.url || "")) {
    return currentTab;
  }

  const fallbackTab = await chrome.tabs.create({ url: "https://www.google.com", active: true });
  if (!fallbackTab?.id) {
    throw new Error("Could not create a fallback website tab.");
  }

  await waitForTabComplete(fallbackTab.id, 15_000).catch(() => {
    // Best effort; page can continue loading.
  });

  return fallbackTab;
}

/**
 * Wait until tab reaches complete status.
 * @param {number} tabId
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForTabComplete(tabId, timeoutMs = 20_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Tab ${tabId} did not finish loading`);
}

/**
 * Ensure content bridge scripts are available in target tab.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureContentBridge(tabId) {
  const tab = await chrome.tabs.get(tabId);

  if (!isInjectableUrl(tab.url || "")) {
    throw new Error("Unsupported tab URL. Open a normal http/https page.");
  }

  if (tab.status !== "complete") {
    await waitForTabComplete(tabId, 12_000).catch(() => {
      // Best effort.
    });
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["executor.js", "content.js"]
    });
  } catch (error) {
    const message = error?.message || "Unknown script injection error";
    if (
      message.includes("Cannot access") ||
      message.includes("extensions gallery") ||
      message.includes("chrome://")
    ) {
      throw new Error("Cannot inject sidebar into this page. Try a standard website tab.");
    }

    throw new Error(`Failed to inject agent scripts: ${message}`);
  }
}

/**
 * Send message to content script with retry support.
 * @param {number} tabId
 * @param {object} message
 * @param {number} retries
 * @returns {Promise<any>}
 */
async function sendTabMessage(tabId, message, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      const errorText = error?.message || "";
      const missingReceiver =
        errorText.includes("Could not establish connection") ||
        errorText.includes("Receiving end does not exist");

      if (missingReceiver) {
        await ensureContentBridge(tabId);
      }

      if (attempt >= retries) {
        throw error;
      }
      await sleep(120 + attempt * 120);
    }
  }

  throw new Error("Unexpected messaging failure");
}

/**
 * Open or toggle sidebar in active tab.
 * @param {boolean} forceOpen
 * @returns {Promise<object>}
 */
async function openSidebarInActiveTab(forceOpen = false) {
  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    throw new Error("No active tab available.");
  }

  const tab = await getRunnableTab(activeTab);
  await ensureContentBridge(tab.id);
  await sendTabMessage(tab.id, { type: forceOpen ? "AGENT_OPEN_SIDEBAR" : "AGENT_TOGGLE_SIDEBAR" }, 1);

  return { tabId: tab.id, url: tab.url || "" };
}

/**
 * Determine if action should be gated by confirmation mode.
 * @param {object} action
 * @param {boolean} confirmationMode
 * @returns {boolean}
 */
function needsConfirmation(action, confirmationMode) {
  if (!confirmationMode) {
    return false;
  }

  if (action?.requiresConfirmation === true) {
    return true;
  }

  if (action?.type !== "click") {
    return false;
  }

  const reason = `${action?.reason || ""} ${action?.label || ""}`.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((keyword) => reason.includes(keyword));
}

/**
 * Ask user to approve or reject pending action.
 * @param {object} action
 * @returns {Promise<boolean>}
 */
async function requestActionConfirmation(action) {
  inMemoryState.pendingAction = action;
  await appendLog("warn", `Confirmation required for action: ${action.type}`);

  const approved = await new Promise((resolve) => {
    pendingConfirmationResolver = resolve;
    setTimeout(() => {
      if (pendingConfirmationResolver) {
        pendingConfirmationResolver(false);
        pendingConfirmationResolver = null;
      }
    }, 120_000);
  });

  inMemoryState.pendingAction = null;
  await persistAndBroadcast();
  return approved;
}

/**
 * Route actions handled in background context.
 * @param {number} tabId
 * @param {object} action
 * @returns {Promise<object>}
 */
async function executeBackgroundAction(tabId, action) {
  if (action.type === "navigate") {
    if (!action.url) {
      throw new Error("navigate action missing url");
    }
    await chrome.tabs.update(tabId, { url: action.url });
    await waitForTabComplete(tabId);
    return { success: true, message: `Navigated to ${action.url}` };
  }

  if (action.type === "open_new_tab") {
    const newTab = await chrome.tabs.create({ url: action.url || "https://www.google.com", active: true });
    if (!newTab.id) {
      throw new Error("Failed to create new tab");
    }

    inMemoryState.tabId = newTab.id;
    await waitForTabComplete(newTab.id);
    return { success: true, message: `Opened new tab: ${action.url || "https://www.google.com"}` };
  }

  if (action.type === "go_back") {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.history.back()
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await waitForTabComplete(tabId, 10_000).catch(() => {});
      return { success: true, message: "Navigated back" };
    } catch (error) {
      throw new Error(`go_back failed: ${error.message}`);
    }
  }

  if (action.type === "screenshot") {
    const tab = await chrome.tabs.get(tabId);
    const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return {
      success: true,
      message: "Captured screenshot",
      screenshotBytes: screenshotUrl?.length || 0
    };
  }

  throw new Error(`Unsupported background action: ${action.type}`);
}

/**
 * Execute one action via background or content runtime.
 * @param {number} tabId
 * @param {object} action
 * @returns {Promise<object>}
 */
async function executeAction(tabId, action) {
  const backgroundTypes = new Set(["navigate", "open_new_tab", "go_back", "screenshot"]);

  if (backgroundTypes.has(action.type)) {
    return withTimeout(executeBackgroundAction(tabId, action), 30_000, `Action ${action.type}`);
  }

  const response = await withTimeout(
    sendTabMessage(tabId, { type: "AGENT_EXECUTE_ACTION", action }, 2),
    20_000,
    `Action ${action.type}`
  );

  if (!response?.ok) {
    throw new Error(response?.error || `Action ${action.type} failed in content script`);
  }

  return response.result || { success: false, message: "Unknown action result" };
}

/**
 * Ask content script to summarize active page DOM.
 * @param {number} tabId
 * @returns {Promise<object>}
 */
async function extractDom(tabId) {
  await ensureContentBridge(tabId);
  const response = await withTimeout(sendTabMessage(tabId, { type: "AGENT_EXTRACT_DOM" }, 2), 15_000, "DOM extraction");

  if (!response?.ok) {
    throw new Error(response?.error || "DOM extraction failed");
  }

  return response.domSummary || {};
}

/**
 * Request plan from OpenAI with retry handling.
 * @param {object} args
 * @returns {Promise<object>}
 */
async function planWithRetry(args) {
  const retries = 2;
  let mutableArgs = { ...args };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await planNextActions(mutableArgs);
    } catch (error) {
      const message = (error?.message || "").toLowerCase();
      if (
        mutableArgs.screenshotDataUrl &&
        (message.includes("image") ||
          message.includes("vision") ||
          message.includes("image_url") ||
          message.includes("content type"))
      ) {
        mutableArgs = { ...mutableArgs, screenshotDataUrl: "" };
        await appendLog("warn", "Planner image input unsupported for current model; retrying without screenshot.");
      }

      if (attempt >= retries) {
        throw error;
      }
      await sleep(300 * (attempt + 1));
    }
  }

  throw new Error("Planner retry exhausted");
}

/**
 * Extract all URLs from text.
 * @param {string} text
 * @returns {Array<string>}
 */
function extractUrls(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  return (text.match(/https?:\/\/[^\s)\]"']+/g) || []).slice(0, 20);
}

/**
 * Build human-readable preview text for one action.
 * @param {object} action
 * @returns {string}
 */
function formatActionPreview(action) {
  if (!action || typeof action !== "object") {
    return "No planned action";
  }

  if (action.type === "navigate" || action.type === "open_new_tab") {
    return `${action.type} -> ${action.url || "(missing url)"}`;
  }

  if (action.selector) {
    return `${action.type} -> ${action.selector}`;
  }

  if (action.type === "wait") {
    return `${action.type} -> ${Number(action.milliseconds) || 0}ms`;
  }

  return action.type || "unknown";
}

/**
 * Build stable signature for action repetition detection.
 * @param {object} action
 * @returns {string}
 */
function getActionSignature(action) {
  if (!action || typeof action !== "object") {
    return "";
  }
  return [action.type || "", action.selector || "", action.url || "", action.text || ""].join("|");
}

/**
 * Check whether loop behavior is likely (repeating same actions).
 * @param {Array<object>} history
 * @returns {boolean}
 */
function isLikelyStuck(history) {
  const recent = (history || []).slice(-8).map((h) => getActionSignature(h?.action)).filter(Boolean);
  if (recent.length < 4) {
    return false;
  }

  const uniqueCount = new Set(recent).size;
  return uniqueCount <= Math.max(2, Math.floor(recent.length / 2));
}

/**
 * Decide whether instruction is about canceling subscription.
 * @param {string} instruction
 * @returns {boolean}
 */
function isCancelSubscriptionIntent(instruction) {
  const text = (instruction || "").toLowerCase();
  return (
    (text.includes("cancel") || text.includes("unsubscribe") || text.includes("stop renewal")) &&
    (text.includes("subscription") || text.includes("plan") || text.includes("billing"))
  );
}

/**
 * Capture screenshot for vision-assisted planning.
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function capturePlannerScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 45 });
  return typeof dataUrl === "string" ? dataUrl : "";
}

/**
 * Create heuristic actions for cancel-subscription workflows when model is stuck.
 * @param {string} instruction
 * @param {object} domSummary
 * @param {Array<object>} history
 * @returns {Array<object>}
 */
function buildCancelHeuristicActions(instruction, domSummary, history) {
  if (!isCancelSubscriptionIntent(instruction)) {
    return [];
  }

  const recentSelectors = new Set(
    (history || [])
      .slice(-20)
      .map((h) => h?.action?.selector)
      .filter((v) => typeof v === "string" && v)
  );
  const recentUrls = new Set(
    (history || [])
      .slice(-20)
      .map((h) => h?.action?.url)
      .filter((v) => typeof v === "string" && v)
  );

  const candidates = [];
  const addCandidate = (item, source) => {
    if (!item?.selector || recentSelectors.has(item.selector)) {
      return;
    }

    const text = `${item.text || ""} ${item.href || ""}`.toLowerCase();
    let score = 0;
    if (text.includes("cancel") || text.includes("unsubscribe") || text.includes("stop renewal")) {
      score += 100;
    }
    if (text.includes("subscription")) {
      score += 70;
    }
    if (text.includes("billing") || text.includes("manage plan") || text.includes("plan")) {
      score += 50;
    }
    if (text.includes("account") || text.includes("settings")) {
      score += 30;
    }

    if (score > 0) {
      candidates.push({
        score,
        selector: item.selector,
        label: item.text || source
      });
    }
  };

  for (const button of domSummary?.buttons || []) {
    addCandidate(button, "button");
  }
  for (const link of domSummary?.links || []) {
    addCandidate(link, "link");
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best) {
    return [
      {
        type: "click",
        selector: best.selector,
        text: null,
        url: null,
        direction: null,
        amount: null,
        milliseconds: null,
        label: best.label,
        requiresConfirmation: best.score >= 95,
        reason: "Heuristic cancel-subscription action"
      },
      {
        type: "wait",
        selector: null,
        text: null,
        url: null,
        direction: null,
        amount: null,
        milliseconds: 1200,
        label: "Wait for panel update",
        requiresConfirmation: false,
        reason: "Allow account UI to update"
      },
      {
        type: "extract_text",
        selector: "body",
        text: null,
        url: null,
        direction: null,
        amount: null,
        milliseconds: null,
        label: "Read result state",
        requiresConfirmation: false,
        reason: "Capture confirmation/cancel text"
      }
    ];
  }

  const currentUrl = domSummary?.url || "";
  try {
    const origin = new URL(currentUrl).origin;
    const paths = [
      "/settings",
      "/settings/billing",
      "/billing",
      "/subscription",
      "/account/subscription",
      "/account/billing",
      "/account/settings"
    ];

    for (const path of paths) {
      const targetUrl = `${origin}${path}`;
      if (recentUrls.has(targetUrl)) {
        continue;
      }
      return [
        {
          type: "navigate",
          selector: null,
          text: null,
          url: targetUrl,
          direction: null,
          amount: null,
          milliseconds: null,
          label: "Navigate to billing/subscription settings",
          requiresConfirmation: false,
          reason: "Heuristic navigation for cancellation"
        },
        {
          type: "wait",
          selector: null,
          text: null,
          url: null,
          direction: null,
          amount: null,
          milliseconds: 1000,
          label: "Wait for page load",
          requiresConfirmation: false,
          reason: "Allow settings page render"
        }
      ];
    }
  } catch {
    // Ignore URL parse issues.
  }

  return [];
}

/**
 * Reduce planned waits to keep execution responsive.
 * @param {object} action
 * @returns {object}
 */
function optimizeActionForSpeed(action) {
  if (!action || typeof action !== "object") {
    return action;
  }

  if (action.type === "wait") {
    const requested = Number(action.milliseconds) || 1000;
    const accelerated = Math.max(80, Math.min(Math.round(requested * 0.5), 1800));
    return { ...action, milliseconds: accelerated };
  }

  return action;
}

/**
 * Collect data gathered so far for final summarization.
 * @returns {Promise<object>}
 */
async function collectDataForFinalization() {
  const extractedTexts = [];
  const extractedData = [];
  const links = new Set();

  for (const entry of inMemoryState.history || []) {
    if (entry?.action?.url) {
      links.add(entry.action.url);
    }

    if (entry?.extractedText) {
      extractedTexts.push(entry.extractedText);
      for (const url of extractUrls(entry.extractedText)) {
        links.add(url);
      }
    }

    if (entry?.note) {
      extractedData.push(entry.note);
      for (const url of extractUrls(entry.note)) {
        links.add(url);
      }
    }
  }

  let currentUrl = "";
  if (inMemoryState.tabId) {
    try {
      const tab = await chrome.tabs.get(inMemoryState.tabId);
      currentUrl = tab?.url || "";
      if (currentUrl) {
        links.add(currentUrl);
      }
    } catch {
      // Ignore tab read failures during finalization.
    }
  }

  return {
    currentUrl,
    extractedTexts: extractedTexts.slice(-18),
    extractedData: extractedData.slice(-40),
    collectedLinks: Array.from(links).slice(0, 25),
    actionHistory: (inMemoryState.history || []).slice(-80).map((entry) => ({
      step: entry.step,
      actionType: entry?.action?.type || "",
      success: Boolean(entry.success),
      note: entry.note || ""
    })),
    logTail: (inMemoryState.logs || []).slice(-100).map((log) => `[${log.level}] ${log.message}`)
  };
}

/**
 * Build deterministic immediate final result before model finalization.
 * @param {string} status
 * @param {string} reason
 * @param {object} collectedData
 * @returns {object}
 */
function buildImmediateFinalResult(status, reason, collectedData) {
  const findings = [];
  const links = Array.isArray(collectedData?.collectedLinks) ? collectedData.collectedLinks.slice(0, 12) : [];
  const extractedTexts = Array.isArray(collectedData?.extractedTexts) ? collectedData.extractedTexts : [];
  const extractedData = Array.isArray(collectedData?.extractedData) ? collectedData.extractedData : [];
  const actionHistory = Array.isArray(collectedData?.actionHistory) ? collectedData.actionHistory : [];

  if (extractedTexts.length > 0) {
    for (const text of extractedTexts.slice(0, 4)) {
      findings.push(text.slice(0, 240));
    }
  } else if (extractedData.length > 0) {
    for (const item of extractedData.slice(0, 4)) {
      findings.push(item.slice(0, 200));
    }
  } else if (actionHistory.length > 0) {
    findings.push(`Executed ${actionHistory.length} actions. No explicit extracted_text payload captured.`);
  } else {
    findings.push("No extractable content was captured before run end.");
  }

  const summaryBase =
    status === RUN_STATUS.MAX_STEPS_REACHED
      ? `Reached max step limit (${inMemoryState.maxSteps}). Returning best partial result.`
      : status === RUN_STATUS.COMPLETED
        ? "Task completed. Returning summarized result."
        : status === RUN_STATUS.ERROR
          ? `Run ended with error: ${reason || "Unknown error."}`
          : "Run ended. Returning available progress.";

  return {
    status,
    summary: `${summaryBase}${reason ? ` ${reason}` : ""}`.trim(),
    keyFindings: findings,
    collectedLinks: links,
    extractedData: extractedData.slice(0, 12),
    nextBestActions: [
      "Refine the instruction with explicit output format.",
      "Use extract_text on target sections earlier in the workflow.",
      "Re-run from the most relevant page for cleaner results."
    ],
    confidence: findings.length > 0 || links.length > 0 ? "medium" : "low"
  };
}

/**
 * Finalize run with guaranteed finalResult object.
 * @param {string} status
 * @param {string} reason
 * @param {object} settings
 * @returns {Promise<void>}
 */
async function finalizeRun(status, reason, settings) {
  inMemoryState.running = false;
  inMemoryState.status = status;
  inMemoryState.processingStage = "finalizing";
  inMemoryState.nextStepPreview = "Generating final result summary";
  inMemoryState.finishedAt = new Date().toISOString();

  if (status === RUN_STATUS.ERROR) {
    inMemoryState.error = reason || "Unexpected error.";
    await appendLog("error", inMemoryState.error);
  } else if (status === RUN_STATUS.MAX_STEPS_REACHED) {
    await appendLog("warn", reason || `Reached max step limit (${inMemoryState.maxSteps}).`);
  } else {
    await appendLog("info", reason || "Task completed.");
  }

  let collectedData = {
    currentUrl: "",
    extractedTexts: [],
    extractedData: [],
    collectedLinks: [],
    actionHistory: [],
    logTail: []
  };
  try {
    collectedData = await collectDataForFinalization();
  } catch (error) {
    await appendLog("warn", `Failed to collect full finalization data: ${error.message}`);
  }

  // Always publish a deterministic final result immediately.
  const immediateFinal = buildImmediateFinalResult(status, reason, collectedData);
  inMemoryState.finalResult = immediateFinal;
  inMemoryState.finalSummary = immediateFinal.summary || reason || "";
  inMemoryState.currentThought = immediateFinal.summary || reason || "";
  inMemoryState.currentPlanSummary = immediateFinal.summary || "";

  if (status === RUN_STATUS.ERROR && !inMemoryState.error) {
    inMemoryState.error = inMemoryState.finalSummary || "Execution failed.";
  }

  await appendLog("info", `Immediate final result generated (${status}).`);
  await persistAndBroadcast();

  // Try to enrich final result using model summary; keep immediate result if this fails.
  try {
    const modelFinal = await withTimeout(
      finalizeResultWithOpenAI({
        apiKey: settings.apiKey,
        model: settings.model,
        instruction: inMemoryState.instruction,
        status,
        stepsExecuted: inMemoryState.step,
        collectedData
      }),
      25_000,
      "Finalizer"
    );

    if (modelFinal && typeof modelFinal === "object") {
      inMemoryState.finalResult = {
        ...immediateFinal,
        ...modelFinal,
        status
      };
      inMemoryState.finalSummary = inMemoryState.finalResult.summary || inMemoryState.finalSummary;
      inMemoryState.currentThought = inMemoryState.finalResult.summary || inMemoryState.currentThought;
      inMemoryState.currentPlanSummary = inMemoryState.finalResult.summary || inMemoryState.currentPlanSummary;
      await appendLog("info", `Model-enriched final result generated (${status}).`);
      await persistAndBroadcast();
    }
  } catch (error) {
    await appendLog("warn", `Model finalizer unavailable, kept immediate final result: ${error.message}`);
  }

  inMemoryState.processingStage = status;
  inMemoryState.nextStepPreview = "Run finished";
  currentRunToken = null;
  await persistAndBroadcast();
}

/**
 * Main autonomous reasoning-execution loop.
 * @param {string} runToken
 * @param {object} settings
 * @returns {Promise<void>}
 */
async function runAgentLoop(runToken, settings) {
  let status = RUN_STATUS.IN_PROGRESS;
  let reason = "";

  while (inMemoryState.running && currentRunToken === runToken) {
    if (inMemoryState.step >= inMemoryState.maxSteps) {
      status = RUN_STATUS.MAX_STEPS_REACHED;
      reason = `Reached step limit (${inMemoryState.maxSteps}).`;
      break;
    }

    inMemoryState.step += 1;
    inMemoryState.processingStage = "analyzing";
    inMemoryState.nextStepPreview = "Analyze page DOM";
    await appendLog("info", `Step ${inMemoryState.step}/${inMemoryState.maxSteps}: analyzing page`);

    const remainingSteps = inMemoryState.maxSteps - inMemoryState.step;
    if (remainingSteps <= 2) {
      await appendLog("warn", `Only ${remainingSteps} steps remaining, prioritizing summarization-oriented actions.`);
    }

    const tabId = inMemoryState.tabId;
    if (!tabId) {
      status = RUN_STATUS.ERROR;
      reason = "No active tab found for execution.";
      break;
    }

    let domSummary;
    try {
      domSummary = await extractDom(tabId);
    } catch (error) {
      status = RUN_STATUS.ERROR;
      reason = `DOM extraction failed: ${error.message}`;
      break;
    }

    let plan;
    try {
      inMemoryState.processingStage = "planning";
      inMemoryState.nextStepPreview = "Generate next action plan";
      await persistAndBroadcast();

      let screenshotDataUrl = "";
      if (isLikelyStuck(inMemoryState.history) || remainingSteps <= 3) {
        try {
          screenshotDataUrl = await withTimeout(capturePlannerScreenshot(tabId), 12_000, "Planner screenshot");
          if (screenshotDataUrl) {
            await appendLog("info", "Captured screenshot for vision-assisted planning.");
          }
        } catch (error) {
          await appendLog("warn", `Screenshot assist unavailable: ${error.message}`);
        }
      }

      plan = await planWithRetry({
        apiKey: settings.apiKey,
        model: settings.model,
        instruction: inMemoryState.instruction,
        currentUrl: domSummary.url || "",
        domSummary,
        history: inMemoryState.history,
        step: inMemoryState.step,
        maxSteps: inMemoryState.maxSteps,
        screenshotDataUrl
      });
    } catch (error) {
      status = RUN_STATUS.ERROR;
      reason = `Planner failed: ${error.message}`;
      break;
    }

    if (plan.modelUsed && plan.modelUsed !== settings.model) {
      await appendLog("warn", `Primary model unavailable, using fallback model: ${plan.modelUsed}`);
    }

    inMemoryState.currentThought = plan.thought || "";
    inMemoryState.currentPlanSummary = plan.summary || "";
    inMemoryState.nextStepPreview = formatActionPreview(plan.actions?.[0] || null);
    await persistAndBroadcast();

    await appendLog("info", `AI thought: ${plan.thought || "(none)"}`);

    if (plan.status === RUN_STATUS.ERROR) {
      status = RUN_STATUS.ERROR;
      reason = plan.summary || "Planner reported blocked state.";
      break;
    }

    if (plan.status === RUN_STATUS.COMPLETED || plan.done) {
      status = RUN_STATUS.COMPLETED;
      reason = plan.summary || "Task completed.";
      break;
    }

    if (!Array.isArray(plan.actions) || plan.actions.length === 0) {
      await appendLog("warn", "Planner returned no actions; retrying on next step.");
      await sleep(220);
      continue;
    }

    // If planner appears stuck on repetitive actions, inject deterministic cancel heuristics.
    if (isLikelyStuck(inMemoryState.history)) {
      const heuristicActions = buildCancelHeuristicActions(inMemoryState.instruction, domSummary, inMemoryState.history);
      if (heuristicActions.length > 0) {
        plan.actions = heuristicActions;
        await appendLog("warn", "Detected loop behavior; switched to cancel-subscription heuristic actions.");
      }
    }

    // Preserve evidence for finalization when near step limit.
    if (remainingSteps <= 2 && !plan.actions.some((a) => a?.type === "extract_text")) {
      plan.actions.push({
        type: "extract_text",
        selector: "body",
        text: null,
        url: null,
        direction: null,
        amount: null,
        milliseconds: null,
        label: "Capture final page evidence",
        requiresConfirmation: false,
        reason: "Low-step safeguard"
      });
      plan.actions = plan.actions.slice(0, 5);
      await appendLog("info", "Low-step safeguard added extract_text action.");
    }

    for (const rawAction of plan.actions.slice(0, 5)) {
      if (!inMemoryState.running || currentRunToken !== runToken) {
        return;
      }

      const action = optimizeActionForSpeed(rawAction);
      inMemoryState.processingStage = "executing";
      inMemoryState.nextStepPreview = formatActionPreview(action);
      await persistAndBroadcast();

      if (needsConfirmation(action, settings.confirmationMode)) {
        const approved = await requestActionConfirmation(action);
        if (!approved) {
          await appendLog("warn", `User denied action: ${action.type}`);
          inMemoryState.history.push({
            step: inMemoryState.step,
            action,
            success: false,
            note: "Action denied by user",
            extractedText: ""
          });
          inMemoryState.history = inMemoryState.history.slice(-120);
          await persistAndBroadcast();
          continue;
        }
      }

      await appendLog("info", `Executing action: ${action.type}`);

      try {
        const actionResult = await executeAction(inMemoryState.tabId, action);
        const note = actionResult?.message || "Action executed";
        inMemoryState.history.push({
          step: inMemoryState.step,
          action,
          success: Boolean(actionResult?.success),
          note,
          extractedText: actionResult?.extractedText || ""
        });
        await appendLog("info", note);
      } catch (error) {
        inMemoryState.history.push({
          step: inMemoryState.step,
          action,
          success: false,
          note: error.message,
          extractedText: ""
        });
        await appendLog("error", `Action failed (${action.type}): ${error.message}`);
      }

      inMemoryState.history = inMemoryState.history.slice(-120);
      await persistAndBroadcast();
      await sleep(80);
    }
  }

  if (!inMemoryState.running || currentRunToken !== runToken) {
    return;
  }

  if (status === RUN_STATUS.IN_PROGRESS) {
    status = RUN_STATUS.MAX_STEPS_REACHED;
    reason = `Reached step limit (${inMemoryState.maxSteps}).`;
  }

  await finalizeRun(status, reason, settings);
}

/**
 * Start new autonomous run for provided instruction.
 * @param {string} instruction
 * @returns {Promise<void>}
 */
async function startAgent(instruction) {
  const cleanInstruction = (instruction || "").trim();
  if (!cleanInstruction) {
    throw new Error("Instruction is required.");
  }

  const { [SETTINGS_KEY]: settingsFromStore } = await storageGet(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(settingsFromStore || {}) };

  if (!settings.apiKey) {
    throw new Error("OpenAI API key is missing. Save it in settings first.");
  }

  if (inMemoryState.running) {
    throw new Error("Agent is already running.");
  }

  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    throw new Error("No active browser tab available.");
  }

  const tab = await getRunnableTab(activeTab);

  inMemoryState = {
    ...DEFAULT_STATE,
    status: RUN_STATUS.IN_PROGRESS,
    running: true,
    instruction: cleanInstruction,
    tabId: tab.id,
    step: 0,
    maxSteps: Number(settings.maxSteps) || DEFAULT_SETTINGS.maxSteps,
    history: [],
    logs: [],
    finalResult: null,
    currentThought: "Initializing run",
    currentPlanSummary: "",
    nextStepPreview: "Prepare content bridge",
    processingStage: "starting",
    startedAt: new Date().toISOString()
  };

  currentRunToken = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await persistAndBroadcast();
  if (!isInjectableUrl(activeTab.url || "")) {
    await appendLog("warn", "Active tab was restricted; switched to a fallback website tab automatically.");
  }
  await appendLog("info", `Started agent on tab ${tab.id}`);

  await ensureContentBridge(tab.id);
  await sendTabMessage(tab.id, { type: "AGENT_OPEN_SIDEBAR" }, 1);
  await appendLog("info", "Sidebar and content bridge ready");

  runAgentLoop(currentRunToken, settings).catch(async (error) => {
    if (currentRunToken) {
      await finalizeRun(RUN_STATUS.ERROR, `Unexpected runtime error: ${error.message}`, settings);
    }
  });
}

/**
 * Stop current run safely.
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function stopAgent(reason = "Stopped by user") {
  if (!inMemoryState.running) {
    inMemoryState.status = "idle";
    inMemoryState.processingStage = "idle";
    inMemoryState.nextStepPreview = "";
    inMemoryState.finalSummary = reason;
    await persistAndBroadcast();
    return;
  }

  inMemoryState.running = false;
  currentRunToken = null;

  if (pendingConfirmationResolver) {
    pendingConfirmationResolver(false);
    pendingConfirmationResolver = null;
  }

  inMemoryState.status = "idle";
  inMemoryState.processingStage = "idle";
  inMemoryState.nextStepPreview = "";
  inMemoryState.finishedAt = new Date().toISOString();
  inMemoryState.finalSummary = reason;
  await appendLog("warn", reason);
  await persistAndBroadcast();
}

/**
 * Save user settings to storage.
 * @param {object} data
 * @returns {Promise<object>}
 */
async function saveSettings(data) {
  const { [SETTINGS_KEY]: current } = await storageGet(SETTINGS_KEY);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(current || {}),
    ...data
  };

  await storageSet({ [SETTINGS_KEY]: merged });
  return merged;
}

/**
 * Initialize service worker state on startup.
 * @returns {Promise<void>}
 */
async function init() {
  const stored = await storageGet([STATE_KEY]);
  inMemoryState = { ...DEFAULT_STATE, ...(stored[STATE_KEY] || {}) };

  if (inMemoryState.running) {
    inMemoryState.running = false;
    inMemoryState.status = "idle";
    inMemoryState.pendingAction = null;
    inMemoryState.error = "Service worker restarted. Resume manually.";
    await persistAndBroadcast();
  }
}

/**
 * Message router for popup/sidebar/content requests.
 * @param {object} message
 * @param {chrome.runtime.MessageSender} _sender
 * @param {(response?: any) => void} sendResponse
 * @returns {boolean}
 */
function onRuntimeMessage(message, _sender, sendResponse) {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "Invalid message" });
    return false;
  }

  if (message.type === "GET_AGENT_STATE") {
    sendResponse({ ok: true, state: inMemoryState });
    return false;
  }

  if (message.type === "GET_SETTINGS") {
    storageGet(SETTINGS_KEY)
      .then((res) => sendResponse({ ok: true, settings: { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) } }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    saveSettings(message.settings || {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "START_AGENT") {
    startAgent(message.instruction || "")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STOP_AGENT") {
    stopAgent("Stopped by user")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "OPEN_SIDEBAR") {
    openSidebarInActiveTab(true)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TOGGLE_SIDEBAR") {
    openSidebarInActiveTab(false)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "APPROVE_PENDING_ACTION") {
    if (pendingConfirmationResolver) {
      pendingConfirmationResolver(true);
      pendingConfirmationResolver = null;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "DENY_PENDING_ACTION") {
    if (pendingConfirmationResolver) {
      pendingConfirmationResolver(false);
      pendingConfirmationResolver = null;
    }
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  return false;
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);
init().catch(() => {
  // Initialization errors are surfaced on explicit actions.
});
