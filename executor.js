(() => {
  if (window.__AI_AGENT_EXECUTOR_LOADED) {
    return;
  }
  window.__AI_AGENT_EXECUTOR_LOADED = true;

  const DEFAULT_RETRIES = 2;
  const RETRY_DELAY_MS = 120;
  const FEEDBACK_STYLE_ID = "ai-agent-action-feedback-style";
  const FEEDBACK_CLASS = "ai-agent-action-pulse";

  /**
   * Sleep helper for async waits.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Build a consistent action result object.
   * @param {boolean} success
   * @param {string} message
   * @param {object} extras
   * @returns {object}
   */
  function result(success, message, extras = {}) {
    return { success, message, ...extras };
  }

  /**
   * Inject one-time CSS for action pulse feedback.
   */
  function ensureFeedbackStyles() {
    if (document.getElementById(FEEDBACK_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = FEEDBACK_STYLE_ID;
    style.textContent = `
      .${FEEDBACK_CLASS} {
        outline: 2px solid #22d3ee !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(34, 211, 238, 0.24) !important;
        transition: box-shadow 0.18s ease, outline-color 0.18s ease !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  /**
   * Visually pulse element to show interaction.
   * @param {Element} element
   */
  function pulseElement(element) {
    if (!element) {
      return;
    }
    ensureFeedbackStyles();
    element.classList.add(FEEDBACK_CLASS);
    setTimeout(() => element.classList.remove(FEEDBACK_CLASS), 220);
  }

  /**
   * Dispatch realistic pointer/mouse down-up sequence.
   * @param {Element} element
   */
  function dispatchPressSequence(element) {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.max(2, rect.width / 2);
    const clientY = rect.top + Math.max(2, rect.height / 2);

    const pointerInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      pointerType: "mouse",
      isPrimary: true
    };
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0
    };

    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
    }
    element.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerup", pointerInit));
    }
    element.dispatchEvent(new MouseEvent("mouseup", mouseInit));
  }

  /**
   * Resolve a selector with retry attempts for dynamic pages.
   * @param {string} selector
   * @param {number} retries
   * @param {number} delay
   * @returns {Promise<Element|null>}
   */
  async function getElementWithRetry(selector, retries = DEFAULT_RETRIES, delay = RETRY_DELAY_MS) {
    if (!selector) {
      return null;
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
      if (attempt < retries) {
        await sleep(delay);
      }
    }

    return null;
  }

  /**
   * Set input value with native setter for React/Vue controlled fields.
   * @param {HTMLInputElement|HTMLTextAreaElement} element
   * @param {string} value
   */
  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  /**
   * Execute click action.
   * @param {string} selector
   * @returns {Promise<object>}
   */
  async function clickElement(selector) {
    const element = await getElementWithRetry(selector);
    if (!element) {
      return result(false, `Element not found: ${selector}`);
    }

    element.scrollIntoView({ behavior: "auto", block: "center" });
    await sleep(16);
    pulseElement(element);
    dispatchPressSequence(element);
    await sleep(12);
    element.click();

    return result(true, `Clicked ${selector}`);
  }

  /**
   * Execute type action.
   * @param {string} selector
   * @param {string} text
   * @returns {Promise<object>}
   */
  async function typeIntoElement(selector, text) {
    const element = await getElementWithRetry(selector);
    if (!element) {
      return result(false, `Element not found: ${selector}`);
    }

    const tag = element.tagName.toLowerCase();
    const supported = tag === "input" || tag === "textarea" || element.isContentEditable;
    if (!supported) {
      return result(false, `Element is not typable: ${selector}`);
    }

    element.focus();
    pulseElement(element);

    if (element.isContentEditable) {
      element.textContent = text || "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setNativeValue(element, text || "");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return result(true, `Typed into ${selector}`);
  }

  /**
   * Execute hover action.
   * @param {string} selector
   * @returns {Promise<object>}
   */
  async function hoverElement(selector) {
    const element = await getElementWithRetry(selector);
    if (!element) {
      return result(false, `Element not found: ${selector}`);
    }

    pulseElement(element);
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return result(true, `Hovered ${selector}`);
  }

  /**
   * Execute scroll action.
   * @param {"up"|"down"} direction
   * @param {number} amount
   * @returns {Promise<object>}
   */
  async function scrollPage(direction = "down", amount = 700) {
    const delta = direction === "up" ? -Math.abs(amount) : Math.abs(amount);
    window.scrollBy({ top: delta, behavior: "auto" });
    await sleep(80);
    return result(true, `Scrolled ${direction} by ${Math.abs(delta)}px`);
  }

  /**
   * Execute text extraction action.
   * @param {string} selector
   * @returns {Promise<object>}
   */
  async function extractText(selector) {
    if (selector) {
      const element = await getElementWithRetry(selector);
      if (!element) {
        return result(false, `Element not found: ${selector}`);
      }
      return result(true, `Extracted text from ${selector}`, {
        extractedText: (element.innerText || element.textContent || "").trim().slice(0, 5000)
      });
    }

    const bodyText = (document.body?.innerText || "").trim().slice(0, 5000);
    return result(true, "Extracted page text", { extractedText: bodyText });
  }

  /**
   * Execute wait action.
   * @param {number} milliseconds
   * @returns {Promise<object>}
   */
  async function waitFor(milliseconds = 1000) {
    const requestedMs = Number(milliseconds) || 1000;
    const acceleratedMs = Math.round(requestedMs * 0.55);
    const safeMs = Math.max(50, Math.min(acceleratedMs, 8000));
    await sleep(safeMs);
    return result(true, `Waited ${safeMs}ms`);
  }

  /**
   * Execute supported in-page actions.
   * @param {object} action
   * @returns {Promise<object>}
   */
  async function executeAction(action) {
    if (!action || typeof action !== "object") {
      return result(false, "Invalid action payload");
    }

    try {
      switch (action.type) {
        case "click":
          return clickElement(action.selector);
        case "type":
          return typeIntoElement(action.selector, action.text || "");
        case "hover":
          return hoverElement(action.selector);
        case "scroll":
          return scrollPage(action.direction || "down", action.amount || 700);
        case "wait":
          return waitFor(action.milliseconds || 1000);
        case "extract_text":
          return extractText(action.selector || "");
        default:
          return result(false, `Unsupported content action: ${action.type}`);
      }
    } catch (error) {
      return result(false, `Action execution error: ${error.message}`);
    }
  }

  window.AgentExecutor = {
    executeAction,
    sleep
  };
})();
