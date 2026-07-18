const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 45_000;
const MODEL_FALLBACK_CHAIN = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];

const RUN_STATUS = {
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  MAX_STEPS_REACHED: "max_steps_reached",
  ERROR: "error"
};

/**
 * Safely parse JSON text without throwing.
 * @param {string} value
 * @returns {object|null}
 */
function safeJsonParse(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    const stripped = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    try {
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

/**
 * Truncate long text to control token growth.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function trimText(text, max = 2000) {
  if (!text || typeof text !== "string") {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...[truncated]`;
}

/**
 * Keep only compact DOM data needed for planning.
 * @param {object} domSummary
 * @returns {object}
 */
function trimDomSummary(domSummary) {
  if (!domSummary || typeof domSummary !== "object") {
    return {};
  }

  const take = (arr, n = 40) => (Array.isArray(arr) ? arr.slice(0, n) : []);

  return {
    title: trimText(domSummary.title || "", 200),
    url: trimText(domSummary.url || "", 500),
    visibleTextSnapshot: trimText(domSummary.visibleTextSnapshot || "", 2000),
    forms: take(domSummary.forms, 20),
    buttons: take(domSummary.buttons, 40),
    links: take(domSummary.links, 40),
    inputs: take(domSummary.inputs, 60),
    selects: take(domSummary.selects, 30),
    textareas: take(domSummary.textareas, 30)
  };
}

/**
 * Trim prior action history to avoid token overflow.
 * @param {Array<object>} history
 * @returns {Array<object>}
 */
function trimHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.slice(-16).map((entry) => ({
    step: entry.step,
    action: entry.action,
    success: Boolean(entry.success),
    note: trimText(entry.note || "", 300),
    extractedText: trimText(entry.extractedText || "", 800)
  }));
}

/**
 * Normalize planner status values.
 * @param {string} status
 * @param {boolean} done
 * @returns {string}
 */
function normalizeStatus(status, done) {
  if (
    status === RUN_STATUS.IN_PROGRESS ||
    status === RUN_STATUS.COMPLETED ||
    status === RUN_STATUS.MAX_STEPS_REACHED ||
    status === RUN_STATUS.ERROR
  ) {
    return status;
  }

  return done ? RUN_STATUS.COMPLETED : RUN_STATUS.IN_PROGRESS;
}

/**
 * Build the system instruction for deterministic JSON planning.
 * @returns {string}
 */
function buildSystemPrompt() {
  return [
    "You are an autonomous browser planning engine. You MUST respond with ONLY a valid JSON object - no markdown, no code fences, no prose.",
    "Return ONLY valid JSON matching the schema.",
    "Plan minimal safe actions grounded in provided DOM data.",
    "Use selector only for DOM actions. Use navigate/open_new_tab for URL-based moves.",
    "Set status='completed' only when instruction outcome is achieved.",
    "Set status='error' if impossible/blocked with a concrete reason in summary.",
    "Set status='in_progress' when more steps are needed.",
    "Do not repeat the same action/selector/URL in loops; switch strategy when two attempts fail.",
    "For subscription-cancel tasks, prioritize account settings, billing, plan management, and cancel controls.",
    "When remaining steps <= 2, avoid long exploration and focus on extracting final answer data.",
    "Use max 5 actions."
  ].join(" ");
}

/**
 * Build user payload for planner model.
 * @param {{instruction:string,currentUrl:string,domSummary:object,history:Array<object>,step:number,maxSteps:number}} args
 * @returns {string}
 */
function buildUserPrompt(args) {
  const remainingSteps = Math.max(0, (Number(args.maxSteps) || 0) - (Number(args.step) || 0));

  return JSON.stringify(
    {
      instruction: args.instruction,
      currentUrl: args.currentUrl,
      step: args.step,
      maxSteps: args.maxSteps,
      remainingSteps,
      history: trimHistory(args.history),
      domSummary: trimDomSummary(args.domSummary),
      executionRules: {
        allowedActionTypes: [
          "click",
          "type",
          "hover",
          "scroll",
          "wait",
          "navigate",
          "open_new_tab",
          "extract_text",
          "screenshot",
          "go_back"
        ],
        selectorPolicy: "Always provide selector for DOM-targeted actions. For non-DOM actions keep selector null.",
        finishPolicy: "Use status to indicate in_progress/completed/error; keep done aligned with status.",
        lowStepPolicy: "If remainingSteps<=2, prioritize extraction and finish."
      }
    },
    null,
    2
  );
}

/**
 * Build strict JSON schema planner request.
 * @param {string} model
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {object}
 */
function buildPlannerRequest(model, systemPrompt, userPrompt, screenshotDataUrl = "") {
  const nullableString = { type: ["string", "null"] };
  const nullableNumber = { type: ["number", "null"] };
  const nullableBoolean = { type: ["boolean", "null"] };

  return {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      screenshotDataUrl
        ? {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              {
                type: "image_url",
                image_url: {
                  url: screenshotDataUrl,
                  detail: "low"
                }
              }
            ]
          }
        : { role: "user", content: userPrompt }
    ]
  };
}

/**
 * Build strict JSON schema finalizer request.
 * @param {string} model
 * @param {string} prompt
 * @returns {object}
 */
function buildFinalizerRequest(model, prompt) {
  return {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are the final summarizer for an autonomous browser agent. Produce the best possible final answer from partial progress. You MUST respond with ONLY a valid JSON object - no markdown, no code fences, no prose."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  };
}

/**
 * Execute OpenAI chat completion request with timeout.
 * @param {string} apiKey
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function callOpenAIChat(apiKey, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${trimText(errorBody, 800)}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Detect model-availability errors where fallback model should be tried.
 * @param {Error} error
 * @returns {boolean}
 */
function isModelAvailabilityError(error) {
  const msg = (error?.message || "").toLowerCase();
  return (
    (msg.includes("model") &&
      (msg.includes("not found") ||
        msg.includes("does not exist") ||
        msg.includes("unsupported") ||
        msg.includes("not available") ||
        msg.includes("permission") ||
        msg.includes("access"))) ||
    msg.includes("not a chat model") ||
    msg.includes("not supported in the v1/chat/completions endpoint") ||
    (msg.includes("v1/responses") && msg.includes("chat/completions"))
  );
}

/**
 * Build ordered candidate model list with deduplication.
 * @param {string} primary
 * @returns {Array<string>}
 */
function getModelCandidates(primary) {
  const merged = [primary, ...MODEL_FALLBACK_CHAIN].filter((v) => typeof v === "string" && v.trim());
  const unique = [];
  for (const model of merged) {
    if (!unique.includes(model)) {
      unique.push(model);
    }
  }
  return unique;
}

/**
 * Call OpenAI with model fallback chain for model-availability failures.
 * @param {string} apiKey
 * @param {string} model
 * @param {(candidateModel:string) => object} payloadBuilder
 * @returns {Promise<{raw:object, modelUsed:string}>}
 */
async function callWithModelFallback(apiKey, model, payloadBuilder) {
  const candidates = getModelCandidates(model);
  let lastError = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const raw = await callOpenAIChat(apiKey, payloadBuilder(candidate));
      return { raw, modelUsed: candidate };
    } catch (error) {
      lastError = error;
      const shouldFallback = isModelAvailabilityError(error) && i < candidates.length - 1;
      if (!shouldFallback) {
        throw error;
      }
    }
  }

  throw lastError || new Error("OpenAI call failed.");
}

/**
 * Parse JSON content string from chat response.
 * @param {object} raw
 * @returns {object}
 */
function parseJsonContent(raw) {
  const content = raw?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI response did not include JSON content.");
  }

  const parsed = safeJsonParse(content);
  if (!parsed) {
    throw new Error(`Failed to parse model JSON: ${trimText(content, 500)}`);
  }

  return parsed;
}

/**
 * Ask the model for next actions.
 * @param {{apiKey:string,model:string,instruction:string,currentUrl:string,domSummary:object,history:Array<object>,step:number,maxSteps:number}} params
 * @returns {Promise<{thought:string,summary:string,status:string,done:boolean,actions:Array<object>}>
 */
export async function planNextActions(params) {
  const userPrompt = buildUserPrompt(params);
  const { raw, modelUsed } = await callWithModelFallback(params.apiKey, params.model, (candidateModel) =>
    buildPlannerRequest(candidateModel, buildSystemPrompt(), userPrompt, params.screenshotDataUrl || "")
  );
  const parsed = parseJsonContent(raw);

  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const normalizedActions = actions.map((action) => {
    if (!action || typeof action !== "object") {
      return {
        type: "wait",
        selector: null,
        text: null,
        url: null,
        direction: null,
        amount: null,
        milliseconds: 600,
        label: null,
        requiresConfirmation: false,
        reason: null
      };
    }

    return {
      type: typeof action.type === "string" ? action.type : "wait",
      selector: typeof action.selector === "string" ? action.selector : null,
      text: typeof action.text === "string" ? action.text : null,
      url: typeof action.url === "string" ? action.url : null,
      direction: action.direction === "up" || action.direction === "down" ? action.direction : null,
      amount: Number.isFinite(action.amount) ? action.amount : null,
      milliseconds: Number.isFinite(action.milliseconds) ? action.milliseconds : null,
      label: typeof action.label === "string" ? action.label : null,
      requiresConfirmation: Boolean(action.requiresConfirmation),
      reason: typeof action.reason === "string" ? action.reason : null
    };
  });

  const done = Boolean(parsed.done);
  return {
    thought: typeof parsed.thought === "string" ? parsed.thought : "",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    status: normalizeStatus(parsed.status, done),
    done,
    actions: normalizedActions,
    modelUsed
  };
}

/**
 * Build finalizer prompt.
 * @param {{instruction:string,status:string,stepsExecuted:number,collectedData:object}} args
 * @returns {string}
 */
function buildFinalizerPrompt(args) {
  return JSON.stringify(
    {
      instruction: args.instruction,
      status: args.status,
      stepsExecuted: args.stepsExecuted,
      task: "Summarize results achieved so far and provide best possible final answer.",
      collectedData: {
        extractedTexts: (args.collectedData?.extractedTexts || []).slice(0, 12).map((t) => trimText(t, 1200)),
        collectedLinks: (args.collectedData?.collectedLinks || []).slice(0, 20),
        extractedData: (args.collectedData?.extractedData || []).slice(0, 20).map((t) => trimText(t, 500)),
        actionHistory: (args.collectedData?.actionHistory || []).slice(-30),
        logTail: (args.collectedData?.logTail || []).slice(-40)
      },
      requirements: {
        beHonestAboutMissingData: true,
        includeUsefulPartialOutput: true
      }
    },
    null,
    2
  );
}

/**
 * Build deterministic local fallback final result.
 * @param {{status:string,collectedData:object}} args
 * @returns {object}
 */
function buildFallbackFinalResult(args) {
  const links = Array.from(new Set(args.collectedData?.collectedLinks || [])).slice(0, 20);
  const extractedData = (args.collectedData?.extractedData || []).slice(0, 15);
  const extractedTexts = (args.collectedData?.extractedTexts || []).slice(0, 5).map((v) => trimText(v, 250));

  return {
    status: args.status,
    summary:
      args.status === RUN_STATUS.MAX_STEPS_REACHED
        ? "Reached max steps before full completion. Returning best partial result."
        : "Agent stopped with partial result due to runtime issue.",
    keyFindings: extractedTexts.length > 0 ? extractedTexts : ["No strong findings were extracted before stop."],
    collectedLinks: links,
    extractedData,
    nextBestActions: [
      "Increase task specificity in instruction.",
      "Re-run on a page with clearer target elements.",
      "Allow a higher max steps limit only if needed."
    ],
    confidence: extractedData.length > 0 || links.length > 0 ? "medium" : "low"
  };
}

/**
 * Finalize best-possible result from collected progress.
 * @param {{apiKey:string,model:string,instruction:string,status:string,stepsExecuted:number,collectedData:object}} params
 * @returns {Promise<object>}
 */
export async function finalizeResultWithOpenAI(params) {
  try {
    const prompt = buildFinalizerPrompt(params);
    const { raw, modelUsed } = await callWithModelFallback(params.apiKey, params.model, (candidateModel) =>
      buildFinalizerRequest(candidateModel, prompt)
    );
    const parsed = parseJsonContent(raw);

    return {
      status:
        parsed.status === RUN_STATUS.IN_PROGRESS ||
        parsed.status === RUN_STATUS.COMPLETED ||
        parsed.status === RUN_STATUS.MAX_STEPS_REACHED ||
        parsed.status === RUN_STATUS.ERROR
          ? parsed.status
          : params.status,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [],
      collectedLinks: Array.isArray(parsed.collectedLinks) ? parsed.collectedLinks : [],
      extractedData: Array.isArray(parsed.extractedData) ? parsed.extractedData : [],
      nextBestActions: Array.isArray(parsed.nextBestActions) ? parsed.nextBestActions : [],
      confidence:
        parsed.confidence === "low" || parsed.confidence === "medium" || parsed.confidence === "high"
          ? parsed.confidence
          : "low",
      modelUsed
    };
  } catch {
    return buildFallbackFinalResult(params);
  }
}

export { RUN_STATUS };
