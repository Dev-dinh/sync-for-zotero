/**
 * background.js — Service Worker (Manifest V3)
 *
 * Auto-polls the local server every 2s for pending queries.
 * When a query arrives, runs the full pipeline on the selected web chat.
 * Tracks the active chat tab so follow-up messages continue the same conversation.
 */

try {
  importScripts("webchat_shared.js", "reconcile.js");
} catch (_) {}

const shared = globalThis.SyncZoteroShared || {
  attemptToken: (seq, attempt) => `${Number(seq) || 0}:${Number(attempt) || 0}`,
  hasMeaningfulAssistantText: (text) => {
    const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized.length <= 1) return false;
    if (
      normalized === "thinking" ||
      normalized === "thinking..." ||
      normalized === "stopped thinking" ||
      normalized === "quick answer" ||
      normalized === "stopped thinking quick answer"
    ) return false;
    if (/^thought for .+$/.test(normalized)) return false;
    if (/^reading\s+documents?\.?$/i.test(normalized)) return false;
    if (/^searching(\s+the\s+web)?\.?$/i.test(normalized)) return false;
    if (/^analyzing\.?$/i.test(normalized)) return false;
    if (/^browsing\.?$/i.test(normalized)) return false;
    // Chinese equivalents (DeepSeek Chinese UI)
    const raw = String(text || "").trim().replace(/\s+/g, " ");
    if (raw === "思考中" || raw === "思考中..." || raw === "深度思考" || raw === "停止思考") return false;
    if (/^已深度思考/.test(raw) || /^已思考/.test(raw) || /^思考了/.test(raw)) return false;
    if (/^正在阅读/.test(raw) || /^正在搜索/.test(raw) ||
        /^正在分析/.test(raw) || /^正在浏览/.test(raw)) return false;
    return true;
  },
  canReuseReadyTranscriptForScrape: (siteId, ready) => {
    if (String(siteId || "").toLowerCase() !== "chatgpt") return false;
    const messages = Array.isArray(ready?.messages) ? ready.messages : [];
    return messages.some((message) => {
      if (!message || typeof message !== "object") return false;
      if (String(message.text || "").trim()) return true;
      if (String(message.thinking || "").trim()) return true;
      return Array.isArray(message.attachments) && message.attachments.length > 0;
    });
  },
  classifyContentScriptMessageError: (error) => ({
    code: "other",
    recoverable: false,
    message: String(error?.message || error || ""),
  }),
  isRecoverableContentScriptMessageError: () => false,
  isRetrySafeContentScriptMessage: () => false,
  retryRecoverableContentScriptMessage: async ({ sendAttempt }) =>
    sendAttempt(1),
  supportsDeliveryContract: (supportedVersions, requiredVersion) =>
    Number.isInteger(Number(requiredVersion)) &&
    Number(requiredVersion) > 0 &&
    (Array.isArray(supportedVersions) ? supportedVersions : []).some(
      (version) => Number(version) === Number(requiredVersion),
    ),
  WEBCHAT_PLUGIN_OUTDATED_MESSAGE:
    "The installed LLM for Zotero plugin is too old for this version of " +
    "the Sync for Zotero extension. Update the LLM for Zotero plugin in " +
    "Zotero (Tools → Plugins and Themes), then try again. " +
    "No prompt or PDF was sent.",
  unsupportedDeliveryContractMessage: (requestedVersion, supportedVersions) => {
    const supported = (Array.isArray(supportedVersions) ? supportedVersions : [])
      .map((version) => Number(version))
      .filter((version) => Number.isInteger(version) && version > 0);
    return (
      `This Zotero request uses WebChat delivery contract ` +
      `${Number(requestedVersion)}, but the installed Sync for Zotero ` +
      `extension only supports version ${supported.join(", ") || "none"}. ` +
      "Update the Sync for Zotero browser extension, then try again. " +
      "No prompt or PDF was sent."
    );
  },
  stopSignalMatchesActiveAttempt: (stopData, { seq, attempt } = {}) => {
    const stopSeq = Number(stopData?.seq) || 0;
    const stopAttempt = Number(stopData?.attempt) || 0;
    return (
      (stopSeq === 0 || stopSeq === Number(seq)) &&
      (stopAttempt === 0 || stopAttempt === Number(attempt))
    );
  },
  contentScriptMeetsDeliveryContractRequirement: (
    capabilityProbe,
    requiredVersion,
  ) => capabilityProbe?.pong === true && (
    requiredVersion === undefined ||
    requiredVersion === null ||
    Number(requiredVersion) === 0 ||
    (Number.isInteger(Number(requiredVersion)) &&
      (Array.isArray(capabilityProbe.supportedDeliveryContracts)
        ? capabilityProbe.supportedDeliveryContracts
        : []).some(
        (version) => Number(version) === Number(requiredVersion),
      ))
  ),
  buildExtensionStatusReport: ({
    chatTabAlive = false,
    chatUrl = null,
    targetSiteId = null,
    capabilityProbe = null,
    health = null,
  } = {}) => {
    const probeAlive = capabilityProbe?.pong === true;
    const supportedDeliveryContracts = probeAlive
      ? capabilityProbe.supportedDeliveryContracts
      : health?.supportedDeliveryContracts;
    return {
      chatTabAlive: Boolean(chatTabAlive),
      chatUrl: chatUrl || null,
      siteId: health?.siteId || targetSiteId || null,
      url: health?.url || chatUrl || null,
      contentScriptAlive:
        probeAlive || health?.contentScriptAlive === true,
      mainWorldInjected: health?.mainWorldInjected === true,
      composerFound: health?.composerFound === true,
      sendControlState: health?.sendControlState || null,
      uploadControlFound: health?.uploadControlFound === true,
      networkHookActive: health?.networkHookActive === true,
      supportedDeliveryContracts: Array.isArray(
        supportedDeliveryContracts,
      )
        ? supportedDeliveryContracts
        : [],
      lastRequestAt: health?.lastRequestAt || null,
      lastStreamAt: health?.lastStreamAt || null,
      lastDiagnostic: health?.lastDiagnostic || null,
    };
  },
  stopSubmittedProviderAttempt: async ({
    submitted,
    seq,
    attempt,
    sendStop,
  }) => {
    if (submitted !== true) {
      return { requested: false, acknowledged: false };
    }
    return new Promise((resolve) => {
      sendStop(
        {
          type: "STOP",
          seq: Number(seq) || 0,
          attempt: Number(attempt) || 0,
        },
        (response) =>
          resolve({
            requested: true,
            acknowledged: response?.ok === true,
          }),
      );
    });
  },
  tabNeedsActivation: (tab) => tab?.active === false,
  tabNeedsLifecycleReload: (tab) => Boolean(tab?.discarded),
};

let SERVER = "http://127.0.0.1:23119/llm-for-zotero/webchat";
const SUPPORTED_DELIVERY_CONTRACTS = Object.freeze([1]);
const MAX_PRE_SUBMIT_RELEASES = 3;
const MAX_CONTENT_SCRIPT_MESSAGE_ATTEMPTS = 3;
const CONTENT_SCRIPT_RECOVERY_TIMEOUT_MS = 30_000;
const RELAY_POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;
const TAB_LOAD_TIMEOUT_MS = 120_000;
const PIPELINE_TIMEOUT_MS = 60 * 60_000;
const RELAY_ATTEMPT_WATCHDOG_INTERVAL_MS = 2_000;
const RELAY_ATTEMPT_WATCHDOG_FAILURE_LIMIT = 3;
const RELAY_HOSTS = ["127.0.0.1", "localhost"];
const WEBCHAT_DEBUG = false;

// ---------------------------------------------------------------------------
// Site configuration — maps target IDs to their site details
// ---------------------------------------------------------------------------

const SITE_CONFIGS = {
  notebooklm: {
    siteId: "notebooklm", label: "NotebookLM",
    homeUrl: "https://notebooklm.google.com/",
    urlPattern: "https://notebooklm.google.com/*",
    urlPrefix: "https://notebooklm.google.com",
    conversationUrlPattern: /^https:\/\/notebooklm\.google\.com\/notebook\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?(?:[?#].*)?$/i,
  },

  gemini: {
    siteId: "gemini", label: "Google Gemini",
    homeUrl: "https://gemini.google.com/app",
    urlPattern: "https://gemini.google.com/*",
    urlPrefix: "https://gemini.google.com",
    conversationUrlPattern: /^https:\/\/gemini\.google\.com\/app\/[a-f0-9]{16}\/?(?:[?#].*)?$/,
  },
  chatgpt: {
    siteId: "chatgpt",
    label: "ChatGPT",
    homeUrl: "https://chatgpt.com/",
    urlPattern: "https://chatgpt.com/*",
    urlPrefix: "https://chatgpt.com",
    conversationUrlPattern: /\/c\//,
  },
  deepseek: {
    siteId: "deepseek",
    label: "DeepSeek",
    homeUrl: "https://chat.deepseek.com/",
    urlPattern: "https://chat.deepseek.com/*",
    urlPrefix: "https://chat.deepseek.com",
    conversationUrlPattern: /\/a\/chat\/s\//,
  },
};

const ALL_SITE_URL_PATTERNS = Object.values(SITE_CONFIGS).map(s => s.urlPattern);

/** Unknown targets must never route a prompt to another provider. */
function getSiteConfig(target) {
  if (!Object.hasOwn(SITE_CONFIGS, target)) throw new Error(`Unsupported WebChat target: ${target}`);
  return SITE_CONFIGS[target];
}

/** Determine which site config a URL belongs to. */
function getSiteConfigByUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return null;
    for (const config of Object.values(SITE_CONFIGS)) {
      if (parsed.origin === config.urlPrefix || (config.siteId === "notebooklm" && parsed.origin === "https://notebook.google.com")) return config;
    }
  } catch (_) {}
  return null;
}

function isSiteHomeUrl(url, config) {
  try {
    const parsed = new URL(String(url || ""));
    const expected = new URL(config.homeUrl);
    const parsedPath = parsed.pathname.replace(/\/+$/, "") || "/";
    const expectedPath = expected.pathname.replace(/\/+$/, "") || "/";
    return parsed.origin === expected.origin && parsedPath === expectedPath;
  } catch {
    return false;
  }
}

function findSiteHomeTab(tabs, config) {
  return tabs.find((tab) => isSiteHomeUrl(tab.url, config)) || null;
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return null;
  }
}

/** The currently active target — updated when a query specifies a target. */
let activeTarget = "chatgpt";

// Connection state tracking
let zoteroConnected = false;
let lastSuccessfulContact = 0;

function debugLog(event, payload) {
  if (!WEBCHAT_DEBUG) return;
  console.log("[sync-zotero][webchat]", event, payload || "");
}

function withZoteroAllowedRequest(init = {}) {
  const next = { ...(init || {}) };
  const headers = new Headers(next.headers || {});
  headers.set("Zotero-Allowed-Request", "1");
  next.headers = headers;
  return next;
}

function relayFetch(url, init) {
  return fetch(url, withZoteroAllowedRequest(init));
}

// Zotero's HTTP server port can vary (23119-23128). Discover the actual port.
let _portDiscoveryInFlight = false;
async function discoverZoteroPort() {
  if (_portDiscoveryInFlight) return;
  _portDiscoveryInFlight = true;
  try {
    const previousServer = SERVER;
    for (const host of RELAY_HOSTS) {
      for (let port = 23119; port <= 23128; port++) {
        try {
          const candidateServer = `http://${host}:${port}/llm-for-zotero/webchat`;
          const res = await relayFetch(`${candidateServer}/debug`);
          if (!res.ok) continue;
          const data = await res.json();
          // Verify this is actually our relay, not Zotero returning generic text
          if (data && typeof data.status === "string") {
            SERVER = candidateServer;
            lastSuccessfulContact = Date.now();

            const wasConnected = zoteroConnected;
            zoteroConnected = true;

            if (SERVER !== previousServer) {
              console.log(`[sync-zotero] Found Zotero server at ${host}:${port} (relay changed)`);
              resetExtensionState();
            } else if (!wasConnected) {
              console.log(`[sync-zotero] Reconnected to Zotero server at ${host}:${port}`);
              resetExtensionState();
            } else {
              console.log(`[sync-zotero] Found Zotero server at ${host}:${port}`);
            }
            // A Zotero restart clears the relay's in-memory capability status
            // even when it comes back on the same port. Publish a fresh status
            // immediately instead of waiting for an MV3 timer that may have
            // been suspended with the service worker.
            await heartbeat();
            return;
          }
        } catch { /* try next host/port */ }
      }
    }
    if (zoteroConnected) {
      zoteroConnected = false;
      console.warn("[sync-zotero] Lost connection to Zotero server");
      broadcastStatus("disconnected", "Lost connection to Zotero — will retry automatically");
    }
  } finally {
    _portDiscoveryInFlight = false;
  }
}

/** Reset stale extension state after Zotero reconnection. */
function resetExtensionState() {
  pipelineRunning = false;
  lastProcessedSeq = 0;
  lastProcessedAttempt = 0;
  if (activePort) {
    try { activePort.disconnect(); } catch (_) {}
    activePort = null;
  }
  broadcastStatus("idle", "Reconnected to Zotero — ready for queries");
  // Immediately pick up any pending query
  pollForQuery();
}

// Heartbeat: checks connectivity and triggers port rediscovery when needed
async function heartbeat() {
  try {
    const res = await relayFetch(`${SERVER}/heartbeat`);
    if (res.ok) {
      lastSuccessfulContact = Date.now();
      // Update activeTarget from relay if provided
      try {
        const hb = await res.clone().json();
        if (hb.active_target && SITE_CONFIGS[hb.active_target]) {
          if (activeTarget !== hb.active_target) {
            // Target changed — clear stale tab reference so SCRAPE_HISTORY
            // and other commands discover the correct tab for the new target.
            activeChatTabId = null;
            console.log(`[sync-zotero] Target changed: ${activeTarget} → ${hb.active_target}, cleared activeChatTabId`);
          }
          activeTarget = hb.active_target;
        }
      } catch { /* non-critical */ }
      if (!zoteroConnected) {
        zoteroConnected = true;
        console.log("[sync-zotero] Heartbeat: reconnected to Zotero");
        resetExtensionState();
      }

      // Report extension status (chat tab alive, URL) to the relay
      // Only report alive if a tab matching the ACTIVE TARGET is open
      try {
        let chatTabAlive = false;
        let chatUrl = null;
        let capabilityProbe = null;
        let health = null;
        const targetConfig = getSiteConfig(activeTarget);
        const tabs = await chrome.tabs.query({ url: targetConfig.urlPattern });
        if (tabs.length > 0) {
          chatTabAlive = true;
          const preferred = activeChatTabId !== null
            ? tabs.find(t => t.id === activeChatTabId) || tabs[0]
            : tabs[0];
          chatUrl = preferred?.url || null;
          if (preferred?.id !== undefined && preferred?.id !== null) {
            try {
              // PING is synchronous and is the authoritative capability
              // advertisement for the exact content-script instance. Rich
              // health is best-effort and must not erase a verified contract
              // if its asynchronous response channel closes during a SPA
              // navigation.
              capabilityProbe = await ensureContentScript(preferred.id);
              health = await sendContentScriptMessageOnce(preferred.id, {
                type: "HEALTH_CHECK",
              });
            } catch (err) {
              health = {
                ok: false,
                contentScriptAlive: capabilityProbe?.pong === true,
                siteId: targetConfig.siteId,
                url: chatUrl,
                mainWorldInjected: false,
                composerFound: false,
                sendControlState: null,
                uploadControlFound: false,
                networkHookActive: false,
                supportedDeliveryContracts:
                  capabilityProbe?.supportedDeliveryContracts || [],
                lastRequestAt: null,
                lastStreamAt: null,
                lastDiagnostic: {
                  reasonCode: "health_check_failed",
                  phase: "health_check",
                  siteId: targetConfig.siteId,
                  message: err?.message || String(err),
                },
              };
            }
          }
        }
        const extensionStatus = shared.buildExtensionStatusReport({
          chatTabAlive,
          chatUrl,
          targetSiteId: targetConfig.siteId,
          capabilityProbe,
          health,
        });
        relayFetch(`${SERVER}/extension_status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extensionStatus),
        }).catch(() => {});
      } catch { /* non-critical */ }

      return;
    }
  } catch { /* server unreachable — fall through to rediscovery */ }

  // Current SERVER URL is stale — try to find the new port
  await discoverZoteroPort();
}

// Discover port on startup and run heartbeat periodically
discoverZoteroPort();
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

// --- keepalive: keep the MV3 service worker warm ---------------------------
// An idle MV3 background worker is suspended after ~30s, which stops the 10s
// heartbeat and lets the Zotero-side freshness window for the extension
// status expire ("has not reported a fresh delivery-contract capability").
// Chat-tab content scripts ping SW_KEEPALIVE periodically; tab/focus events
// also refresh the status when the user returns to the browser.
const KEEPALIVE_DEBOUNCE_MS = 4000;
let lastHeartbeatKickAt = 0;
function kickHeartbeat() {
  const now = Date.now();
  if (now - lastHeartbeatKickAt < KEEPALIVE_DEBOUNCE_MS) return;
  lastHeartbeatKickAt = now;
  heartbeat().catch(() => {});
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "SW_KEEPALIVE") {
    kickHeartbeat();
    sendResponse({ ok: true, at: Date.now() });
    return true;
  }
});
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => kickHeartbeat());
}
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      kickHeartbeat();
    }
  });
}
// --- end keepalive ---------------------------------------------------------

// Auto-discover existing chat tabs on startup without opening new tabs.
(async () => {
  // Search all supported sites for an existing tab
  let foundTab = null;
  for (const config of Object.values(SITE_CONFIGS)) {
    const tabs = await chrome.tabs.query({ url: config.urlPattern });
    if (tabs.length > 0) {
      foundTab = tabs[0];
      activeTarget = config.siteId;
      break;
    }
  }
  if (foundTab && activeChatTabId === null) {
    activeChatTabId = foundTab.id;
    console.log(`[sync-zotero] Found existing chat tab: ${foundTab.id} (${activeTarget})`);
  }
})();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pipelineRunning  = false;
let activeChatTabId  = null;   // Chat tab used for the current conversation
let lastProcessedSeq = 0;
let lastProcessedAttempt = 0;
let activePort       = null;   // current port connection to content script
let activePipelineSeq = 0;
let activePipelineAttempt = 0;

// Persist critical state to chrome.storage.session so it survives SW restarts
function persistState() {
  chrome.storage.session.set({
    _syncState: {
      lastProcessedSeq,
      lastProcessedAttempt,
      activeChatTabId,
      server: SERVER,
    },
  });
}

// Restore state from storage on SW restart
async function loadPersistedState() {
  try {
    const data = await chrome.storage.session.get("_syncState");
    if (data._syncState) {
      lastProcessedSeq = data._syncState.lastProcessedSeq || 0;
      lastProcessedAttempt = data._syncState.lastProcessedAttempt || 0;
      activeChatTabId = data._syncState.activeChatTabId || null;
      if (data._syncState.server) SERVER = data._syncState.server;
      // Never restore pipelineRunning = true — relay's stale claim expiration handles it
      console.log("[sync-zotero] Restored persisted state", data._syncState);
    }
  } catch (_) {}
}

// Load persisted state on startup
loadPersistedState();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function serverGet(path) {
  let res;
  try {
    res = await relayFetch(`${SERVER}${path}`);
  } catch (err) {
    zoteroConnected = false;
    discoverZoteroPort();
    throw err;
  }
  lastSuccessfulContact = Date.now();
  zoteroConnected = true;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Server returned non-JSON: ${text.slice(0, 100)}`);
  }
  if (!res.ok) {
    throw new Error(data.error || data.reason || `Server returned HTTP ${res.status}`);
  }
  if (data.error) throw new Error(data.error);
  if (data.ok === false && (data.reason || data.message)) {
    throw new Error(data.reason || data.message);
  }
  return data;
}

async function serverPost(path, body) {
  let res;
  try {
    res = await relayFetch(`${SERVER}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    zoteroConnected = false;
    discoverZoteroPort();
    throw err;
  }
  lastSuccessfulContact = Date.now();
  zoteroConnected = true;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Server returned non-JSON: ${text.slice(0, 100)}`);
  }
  if (!res.ok) {
    throw new Error(data.error || data.reason || `Server returned HTTP ${res.status}`);
  }
  if (data.error) throw new Error(data.error);
  if (data.ok === false && (data.reason || data.message)) {
    throw new Error(data.reason || data.message);
  }
  return data;
}

async function claimQuery(seq) {
  return serverPost("/claim_query", { seq });
}

async function ackQueryPhase(seq, attempt, phase, diagnostic = null) {
  return serverPost("/ack_query_phase", {
    seq,
    attempt,
    phase,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

async function releaseQuery(seq, attempt) {
  return serverPost("/release_query", { seq, attempt });
}

async function reportTurnState(body) {
  return serverPost("/update_turn_state", body);
}

function formatDiagnosticError(message, diagnostic) {
  const base = String(message || "WebChat bridge error");
  if (!diagnostic || typeof diagnostic !== "object") return base;
  const details = [];
  if (diagnostic.reasonCode) details.push(String(diagnostic.reasonCode));
  if (diagnostic.phase) details.push(`phase=${diagnostic.phase}`);
  if (diagnostic.sendControlState) details.push(`send=${diagnostic.sendControlState}`);
  if (Number.isFinite(Number(diagnostic.clickAttempts))) {
    details.push(`clicks=${Number(diagnostic.clickAttempts)}`);
  }
  if (diagnostic.requestObserved === true) details.push("request_observed");
  if (diagnostic.streamObserved === true) details.push("stream_observed");
  if (Number.isFinite(Number(diagnostic.newMessages)) && diagnostic.newMessages != null) {
    details.push(`new=${Number(diagnostic.newMessages)}`);
  }
  if (Number.isFinite(Number(diagnostic.userCandidates)) && diagnostic.userCandidates != null) {
    details.push(`user_candidates=${Number(diagnostic.userCandidates)}`);
  }
  if (diagnostic.roleNodesVisible != null && diagnostic.roleNodesTotal != null) {
    details.push(`role_nodes=${Number(diagnostic.roleNodesVisible)}/${Number(diagnostic.roleNodesTotal)}`);
  }
  return details.length > 0 ? `${base} (${details.join(", ")})` : base;
}

async function waitForChatReadyInTab(tabId, expectedChatUrl = null, timeoutMs = 30_000) {
  const response = await sendToContentScript(tabId, {
    type: "WAIT_FOR_CHAT_READY",
    expectedChatUrl,
    timeoutMs,
  });
  if (!response?.ok) {
    const error = new Error(
      response?.error || "Chat did not become ready.",
    );
    error.diagnostic = response?.diagnostic || null;
    throw error;
  }
  return response;
}

async function resetNetworkCacheInTab(tabId, scope = "all") {
  try {
    await sendToContentScript(tabId, {
      type: "RESET_NETWORK_CACHE",
      scope,
    });
  } catch (_) {}
}

async function publishReadyConversationState(
  tabId,
  expectedChatUrl = null,
  { submitScraped = false, expectedChatId = null, minCapturedAt = 0 } = {},
) {
  const expectedSiteConfig = expectedChatUrl
    ? getSiteConfigByUrl(expectedChatUrl)
    : getSiteConfig(activeTarget);
  const allowNetworkReadyFallback =
    submitScraped && expectedSiteConfig?.siteId === "deepseek";
  const readyTimeoutMs = allowNetworkReadyFallback ? 8_000 : 30_000;
  const fallbackReady = {
    ok: false,
    ready: false,
    chatUrl: expectedChatUrl || null,
    chatId: expectedChatId || null,
    transcriptCount: 0,
    transcriptHash: null,
    messages: [],
  };
  const readyPromise = (async () => {
    try {
      return await waitForChatReadyInTab(tabId, expectedChatUrl, readyTimeoutMs);
    } catch (err) {
      if (!allowNetworkReadyFallback) {
        throw err;
      }
      debugLog("ready_fallback_network", {
        expectedChatUrl,
        expectedChatId,
        reason: err?.message || String(err),
      });
      return fallbackReady;
    }
  })();
  let ready = allowNetworkReadyFallback ? fallbackReady : await readyPromise;
  if (!allowNetworkReadyFallback) {
    debugLog("ready_ack", ready);
  }

  // If we got empty messages on a conversation page, retry once after a delay
  const convSiteConfig = expectedChatUrl ? getSiteConfigByUrl(expectedChatUrl) : null;
  const isConversationPage = expectedChatUrl && convSiteConfig?.conversationUrlPattern?.test(expectedChatUrl);
  if (
    submitScraped &&
    ready?.ok !== false &&
    isConversationPage &&
    (!ready.messages || ready.messages.length === 0) &&
    expectedSiteConfig?.siteId !== "deepseek"
  ) {
    debugLog("ready_retry", "empty messages on conversation page, retrying…");
    await new Promise(r => setTimeout(r, 2000));
    ready = await waitForChatReadyInTab(tabId, expectedChatUrl);
    debugLog("ready_retry_ack", ready);
  }

  if (submitScraped) {
    const scrapeTimeoutMs =
      expectedSiteConfig?.siteId === "deepseek" ? 20_000 : 15_000;
    const canonicalChatUrl =
      expectedSiteConfig?.siteId === "deepseek" && expectedChatUrl
        ? expectedChatUrl
        : null;
    const canonicalChatId =
      expectedSiteConfig?.siteId === "deepseek" && expectedChatId
        ? expectedChatId
        : null;
    // Use SCRAPE_MESSAGES for full scroll-and-collect (captures all messages
    // from virtual-scrolling sites like DeepSeek, not just the visible ones).
    let scrapedSnapshot = {
      messages: ready.messages || [],
      chatUrl: canonicalChatUrl || ready.chatUrl || expectedChatUrl || null,
      chatId: canonicalChatId || ready.chatId || expectedChatId || null,
      siteHostname:
        hostnameFromUrl(canonicalChatUrl || ready.chatUrl || expectedChatUrl),
      capturedAt: Date.now(),
      source: "dom",
    };
    const reuseReadyTranscript = shared.canReuseReadyTranscriptForScrape(
      expectedSiteConfig?.siteId,
      ready,
    );
    if (reuseReadyTranscript) {
      debugLog("ready_transcript_reused", {
        siteId: expectedSiteConfig?.siteId || null,
        count: Array.isArray(ready.messages) ? ready.messages.length : 0,
      });
    } else {
      try {
        const scrapeResult = await sendToContentScript(tabId, {
          type: "SCRAPE_MESSAGES",
          expectedChatUrl,
          expectedChatId,
          minCapturedAt,
          timeoutMs: scrapeTimeoutMs,
        });
        if (scrapeResult?.ok && Array.isArray(scrapeResult.messages)) {
          scrapedSnapshot = {
            messages: scrapeResult.messages,
            chatUrl:
              canonicalChatUrl ||
              scrapeResult.chatUrl ||
              ready.chatUrl ||
              expectedChatUrl ||
              null,
            chatId:
              canonicalChatId ||
              scrapeResult.chatId ||
              ready.chatId ||
              expectedChatId ||
              null,
            siteHostname:
              hostnameFromUrl(
                canonicalChatUrl ||
                scrapeResult.chatUrl ||
                ready.chatUrl ||
                expectedChatUrl,
              ) || scrapeResult.siteHostname || hostnameFromUrl(ready.chatUrl),
            capturedAt: Number(scrapeResult.capturedAt) || Date.now(),
            source: scrapeResult.source || "dom",
          };
        }
      } catch (_) { /* fall back to ready.messages */ }
    }
    if (allowNetworkReadyFallback) {
      try {
        ready = await readyPromise;
      } catch (err) {
        debugLog("ready_post_scrape_error", {
          expectedChatUrl,
          expectedChatId,
          reason: err?.message || String(err),
        });
        ready = fallbackReady;
      }
      debugLog("ready_ack", ready);
    }
    await serverPost("/chat_history", {
      action: "submit_scraped",
      messages: scrapedSnapshot.messages,
      chatUrl: scrapedSnapshot.chatUrl,
      chatId: scrapedSnapshot.chatId,
      siteHostname: scrapedSnapshot.siteHostname,
      capturedAt: scrapedSnapshot.capturedAt,
      source: scrapedSnapshot.source,
    });
  }

  await reportTurnState({
    remote_chat_url: ready.chatUrl || null,
    remote_chat_id: ready.chatId || null,
    baseline_transcript_count: ready.transcriptCount || 0,
    baseline_transcript_hash: ready.transcriptHash || null,
    turn_status: "ready",
  });

  return ready;
}

// ---------------------------------------------------------------------------
// Keep the service worker alive + auto-poll for pending queries
// ---------------------------------------------------------------------------

// MV3 service workers are killed after ~30s of inactivity.
// A Chrome API call every 25s prevents the idle timeout from triggering.
// Also persist state on each keepalive tick to survive SW restarts.
setInterval(() => {
  chrome.storage.session.set({ _keepalive: Date.now() });
  persistState();
}, 25_000);

// Backup: chrome.alarms wakes the service worker up even if it was killed.
// The SW module re-executes on restart, so setInterval below auto-resumes.
chrome.alarms.create("pollAlarm", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pollAlarm") {
    heartbeat();
    pollForQuery();
    pollForCommand();
  }
});

// Clean initialization after browser restart
chrome.runtime.onStartup.addListener(() => {
  loadPersistedState().then(() => discoverZoteroPort());
});

// Adaptive polling: 500ms when active, 2000ms when idle (saves CPU/network)
let lastQueryActivity = 0;
const IDLE_POLL_INTERVAL_MS = 2000;

function adaptivePoll() {
  const isActive = pipelineRunning || (Date.now() - lastQueryActivity < 30_000);
  const interval = isActive ? RELAY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
  pollForQuery();
  pollForCommand();
  pollForStop();
  setTimeout(adaptivePoll, interval);
}
setTimeout(adaptivePoll, RELAY_POLL_INTERVAL_MS);

// Poll for stop signal — runs even during active pipeline (unlike pollForCommand)
async function pollForStop() {
  if (!pipelineRunning) return; // only needed during active generation
  if (!zoteroConnected) return;
  try {
    const data = await relayFetch(`${SERVER}/poll_stop`).then(r => r.json());
    const stopMatchesActiveAttempt = shared.stopSignalMatchesActiveAttempt(
      data,
      { seq: activePipelineSeq, attempt: activePipelineAttempt },
    );
    if (data.stop && stopMatchesActiveAttempt && activeChatTabId !== null) {
      // Tell content script to click the stop button
      chrome.tabs.sendMessage(
        activeChatTabId,
        {
          type: "STOP",
          seq: activePipelineSeq,
          attempt: activePipelineAttempt,
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    }
  } catch (_) {}
}

/**
 * ChatGPT and Gemini: DOM-based history scrape.
 * Read the existing sidebar using each site's adapter.
 * Never reload — just scrape the existing page.
 */
async function scrapeChatGPTHistory(siteConfig, historyStartedAt) {
  const tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
  let tabId = tabs.length > 0 ? tabs[0].id : null;

  if (!tabId) {
    // No ChatGPT tab — create one and wait for page load
    const tab = await chrome.tabs.create({ url: siteConfig.homeUrl, active: false });
    await waitForTabLoad(tab.id);
    tabId = tab.id;
  }

  await ensureContentScript(tabId);
  return sendToContentScript(tabId, {
    type: "SCRAPE_HISTORY_NOW",
    force: true,
    minCapturedAt: historyStartedAt,
    timeoutMs: 15_000,
  });
}

/**
 * DeepSeek: Network-capture-based history scrape.
 * History is extracted from intercepted fetch/XHR responses during page load.
 * Must reload (or navigate to home) so the network bootstrap captures fresh data.
 */
async function scrapeDeepSeekHistory(siteConfig, historyStartedAt) {
  const tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
  let tabId = findSiteHomeTab(tabs, siteConfig)?.id || null;

  if (tabId) {
    // Home tab exists — reload to trigger fresh network capture
    await resetNetworkCacheInTab(tabId, "history");
    await reloadTab(tabId);
    await waitForTabLoad(tabId);
  } else if (tabs.length > 0) {
    // Site tab exists but not on home — navigate it to home
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { url: siteConfig.homeUrl });
    await waitForTabLoad(tabId);
  } else {
    // No tab — create one in background
    const tab = await chrome.tabs.create({ url: siteConfig.homeUrl, active: false });
    await waitForTabLoad(tab.id);
    tabId = tab.id;
  }

  await ensureContentScript(tabId);
  return sendToContentScript(tabId, {
    type: "SCRAPE_HISTORY_NOW",
    force: true,
    minCapturedAt: historyStartedAt,
    timeoutMs: 15_000,
  });
}

async function pollForCommand() {
  if (pipelineRunning) return;
  if (!zoteroConnected) return;
  try {
    const data = await relayFetch(`${SERVER}/poll_command`).then(r => r.json());
    // Update activeTarget from relay — clear stale tab if target changed
    if (data.active_target && SITE_CONFIGS[data.active_target]) {
      if (activeTarget !== data.active_target) {
        activeChatTabId = null;
        console.log(`[sync-zotero] poll_command: target changed ${activeTarget} → ${data.active_target}, cleared activeChatTabId`);
      }
      activeTarget = data.active_target;
    }
    if (!data.command) return;

    const cmd = data.command;
    if (cmd.type === "NEW_CHAT") {
      await reportTurnState({
        remote_chat_url: null,
        remote_chat_id: null,
        baseline_transcript_count: 0,
        baseline_transcript_hash: null,
        turn_status: "navigating",
      }).catch(() => {});

      // Navigate a chat tab to a fresh page
      const siteConfig = getSiteConfig(activeTarget);
      let tabId = activeChatTabId;

      // Find an existing chat tab if we don't have one tracked
      if (tabId === null) {
        const tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
        if (tabs.length > 0) tabId = tabs[0].id;
      }

      if (tabId !== null) {
        try {
          await chrome.tabs.update(tabId, { url: siteConfig.homeUrl });
          await waitForTabLoad(tabId);
        } catch (_) {}
      } else {
        const tab = await chrome.tabs.create({ url: siteConfig.homeUrl, active: false });
        await waitForTabLoad(tab.id);
        tabId = tab.id;
      }

      if (tabId !== null) {
        activeChatTabId = tabId;
        try {
          await publishReadyConversationState(tabId, null, { submitScraped: false });
        } catch (err) {
          broadcastStatus("error", err.message || "New chat did not become ready");
          return;
        }
      }
      broadcastStatus("idle", "New chat — ready for next query");
    } else if (cmd.type === "LOAD_CHAT" && cmd.chatUrl) {
      const loadStartedAt = Date.now();
      await reportTurnState({
        remote_chat_url: cmd.chatUrl,
        remote_chat_id: cmd.chatId || null,
        baseline_transcript_count: 0,
        baseline_transcript_hash: null,
        turn_status: "navigating",
      }).catch(() => {});

      // Navigate to a specific past chat URL
      let tabId = null;

      // Try to find an existing chat tab first
      const loadSiteConfig = getSiteConfigByUrl(cmd.chatUrl) || getSiteConfig(activeTarget);
      if (activeChatTabId !== null) {
        try {
          const existingTab = await chrome.tabs.get(activeChatTabId);
          if (existingTab?.url?.startsWith(loadSiteConfig.urlPrefix)) {
            tabId = activeChatTabId;
          }
        } catch (_) {
          activeChatTabId = null;
        }
      }
      if (!tabId) {
        const tabs = await chrome.tabs.query({ url: loadSiteConfig.urlPattern });
        if (tabs.length > 0) {
          tabId = tabs[0].id;
          activeChatTabId = tabId;
        }
      }

      if (tabId) {
        // SPA — navigating within it won't trigger a full page load.
        // Use the content script to navigate via window.location for a clean reload.
        try {
          await ensureContentScript(tabId);
          await resetNetworkCacheInTab(tabId, "all");
          await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { type: "NAVIGATE", url: cmd.chatUrl }, () => {
              void chrome.runtime.lastError;
              resolve();
            });
          });
        } catch (_) {
          // Fallback: direct tab update
          await chrome.tabs.update(tabId, { url: cmd.chatUrl });
        }
        await waitForTabLoad(tabId);
      } else {
        // No existing chat tab — create a new one
        const tab = await chrome.tabs.create({ url: cmd.chatUrl, active: false });
        await waitForTabLoad(tab.id);
        activeChatTabId = tab.id;
        tabId = tab.id;
      }

      broadcastStatus("idle", "Loaded past chat — scraping messages…");

      try {
        await publishReadyConversationState(tabId, cmd.chatUrl, {
          submitScraped: true,
          expectedChatId: cmd.chatId || null,
          minCapturedAt: loadStartedAt,
        });
      } catch (err) {
        console.warn("[sync-zotero] Scraping error:", err);
        await reportTurnState({
          remote_chat_url: cmd.chatUrl,
          remote_chat_id: cmd.chatId || null,
          turn_status: "error",
        }).catch(() => {});
        broadcastStatus(
          "error",
          err.message || "Failed to load the selected conversation",
        );
        return;
      }

      broadcastStatus("idle", "Loaded past chat — ready for follow-up");
    } else if (cmd.type === "SCRAPE_HISTORY") {
      const historyStartedAt = Date.now();
      const scrapeSiteConfig = getSiteConfig(activeTarget);

      let scrapeResult = null;
      try {
        const scrape = (scrapeSiteConfig.siteId === "chatgpt" || scrapeSiteConfig.siteId === "gemini" || scrapeSiteConfig.siteId === "notebooklm")
          ? scrapeChatGPTHistory
          : scrapeDeepSeekHistory;
        scrapeResult = await scrape(scrapeSiteConfig, historyStartedAt);
      } catch (_) {
        // Communication failure — content script never ran.
        // Post timeout metadata so the plugin's polling loop can exit.
        await serverPost("/update_chat_history", {
          sessions: [],
          siteHostname: hostnameFromUrl(scrapeSiteConfig.homeUrl),
          scrapedAt: Date.now(),
          source: null,
          status: "timeout",
        }).catch(() => {});
      }
      // If scrapeResult came back but !ok, the content script already posted
      // its own HISTORY_UPDATE — no duplicate post needed from here.
    } else if (cmd.type === "ENSURE_TAB") {
      // Open the target site tab if none is currently open (auto-open on preload)
      const ensureConfig = getSiteConfig(activeTarget);
      const existingTabs = await chrome.tabs.query({ url: ensureConfig.urlPattern });
      if (existingTabs.length === 0) {
        const tab = await chrome.tabs.create({ url: ensureConfig.homeUrl, active: false });
        await waitForTabLoad(tab.id);
        activeChatTabId = tab.id;
        console.log(`[sync-zotero] ENSURE_TAB: opened ${ensureConfig.homeUrl} (tab ${tab.id})`);
      } else {
        activeChatTabId = existingTabs[0].id;
      }
    } else if (cmd.type === "DELETE_CHAT" && cmd.chatId) {
      if (activeChatTabId !== null) {
        chrome.tabs.sendMessage(activeChatTabId, { type: "DELETE_CHAT", chatId: cmd.chatId }, (response) => {
          if (response && !response.success) {
            broadcastStatus("error", `Failed to delete chat: ${response.error}`);
          }
        });
      }
    }
  } catch (_) {
    // Server not running — ignore
  }
}

// ---------------------------------------------------------------------------
// History Mirroring Logic
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HISTORY_UPDATE") {
    // Forward the scraped history to the relay server.
    // Include siteHostname so the relay can merge per-site (e.g. empty
    // DeepSeek scrape clears only DeepSeek entries, not ChatGPT's).
    const siteHostname = message.siteHostname || null;
    const scrapedAt = Number(message.scrapedAt) || Date.now();
    serverPost("/update_chat_history", {
      sessions: message.history,
      siteHostname,
      scrapedAt,
      source: message.source || null,
      status: message.status || null,
    })
      .then(() => console.log(`[sync-zotero] History updated: ${message.history?.length} sessions`))
      .catch((err) => console.warn("[sync-zotero] History update failed:", err.message));
  }
});
async function pollForQuery() {
  if (pipelineRunning) return;
  if (!zoteroConnected) return;

  try {
    const data = await serverGet("/poll_query");

    if (data.status !== "pending") return;
    if (!data.query?.seq) return;

    const claimed = await claimQuery(data.query.seq);
    if (!claimed?.ok || !claimed.query) return;

    const token = shared.attemptToken(claimed.query.seq, claimed.query.attempt);
    const lastToken = shared.attemptToken(lastProcessedSeq, lastProcessedAttempt);
    if (token === lastToken) return;

    lastProcessedSeq = claimed.query.seq;
    lastProcessedAttempt = claimed.query.attempt || 0;
    lastQueryActivity = Date.now();
    await ackQueryPhase(claimed.query.seq, claimed.query.attempt || 0, "claimed").catch(() => {});
    await runPipeline(claimed.query);
  } catch (err) {
    // Server not running — silently skip (expected when server is off)
    if (!err.message.includes("Failed to fetch") && !err.message.includes("NetworkError")) {
      broadcastStatus("error", err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(query) {
  pipelineRunning  = true;
  const seq        = query.seq;
  const attempt    = query.attempt || 0;
  activePipelineSeq = seq;
  activePipelineAttempt = attempt;
  const startsFresh = query.force_new_chat === true;
  const isFollowup = !startsFresh;

  // Determine which site to use from the query target (defaults to active/chatgpt)
  const queryTarget = query.target || activeTarget || "chatgpt";
  try {
    const siteConfig = getSiteConfig(queryTarget);
    const siteLabel = siteConfig.label;
    const expectedBinding = shared.resolveExpectedConversationBinding(query, queryTarget);
    activeTarget = queryTarget;

    broadcastStatus("running", isFollowup
      ? (query.pdf_base64 ? `Attaching PDF to conversation…` : `Sending follow-up to ${siteLabel}…`)
      : (query.pdf_base64 ? `Starting fresh chat with PDF: ${query.pdf_filename}…` : `Starting fresh ${siteLabel} chat…`)
    );

    // ── Delivery-contract gate ─────────────────────────────────────
    // Decided once here, before any tab work, so a mismatched
    // extension/plugin pair fails with the update remedy instead of a
    // cryptic error deep in the pipeline.
    const requestedContract = query.delivery_contract_version;
    if (
      requestedContract === undefined ||
      requestedContract === null ||
      Number(requestedContract) === 0
    ) {
      throw new Error(shared.WEBCHAT_PLUGIN_OUTDATED_MESSAGE);
    }
    if (
      !shared.supportsDeliveryContract(
        SUPPORTED_DELIVERY_CONTRACTS,
        requestedContract,
      )
    ) {
      throw new Error(
        shared.unsupportedDeliveryContractMessage(
          requestedContract,
          SUPPORTED_DELIVERY_CONTRACTS,
        ),
      );
    }

    // ── Drain stale NEW_CHAT command ────────────────────────────────
    // If this query starts fresh, consume any pending NEW_CHAT command
    // so it doesn't fire after the pipeline and navigate away.
    if (startsFresh) {
      try {
        await relayFetch(`${SERVER}/poll_command`).then(r => r.json());
      } catch (_) { /* server not running — ignore */ }
    }

    // ── Get the right chat tab ─────────────────────────────────────
    let tab = null;

    if (activeChatTabId !== null) {
      try {
        const existing = await chrome.tabs.get(activeChatTabId);
        if (getSiteConfigByUrl(existing?.url)?.siteId === siteConfig.siteId) {
          tab = existing;
        }
      } catch (_) {
        activeChatTabId = null;
      }
    }

    if (!tab) {
      tab = await getChatTab(queryTarget);
      activeChatTabId = tab.id;
    }

    // ChatGPT defers parts of its client-side text rendering in inactive tabs.
    // Select the target tab within its Chrome window before navigation and
    // submission so a throttled prefix cannot look terminal to the bridge.
    tab = await ensureTabActive(tab.id);

    const shouldNavigateFresh = startsFresh;

    if (shouldNavigateFresh && queryTarget === "gemini") {
      // Reload even a home shell: a draft/stale transcript must not leak into
      // a force-new-chat request.
      await chrome.tabs.update(tab.id, { url: siteConfig.homeUrl });
      await waitForTabLoad(tab.id);
      tab = await chrome.tabs.get(tab.id);
    } else if (shouldNavigateFresh) {
      // Skip navigation if tab is already on the site's home/new-chat URL
      const currentUrl = tab.url || "";
      const isAlreadyHome = (
        currentUrl === siteConfig.homeUrl ||
        currentUrl === siteConfig.homeUrl.slice(0, -1) ||
        currentUrl === siteConfig.urlPrefix
      );
      if (!isAlreadyHome) {
        await chrome.tabs.update(tab.id, { url: siteConfig.homeUrl });
        await waitForTabLoad(tab.id);
        tab = await chrome.tabs.get(tab.id);
      }
    } else if (expectedBinding.chatUrl && !shared.conversationUrlsMatch(tab.url, expectedBinding.chatUrl)) {
      await chrome.tabs.update(tab.id, { url: expectedBinding.chatUrl });
      await waitForTabLoad(tab.id);
      tab = await chrome.tabs.get(tab.id);
    }

    // ── Ensure content script is ready ────────────────────────────
    await ensureTabReady(tab.id);
    await ensureContentScript(
      tab.id,
      query.delivery_contract_version,
    );
    activeChatTabId = tab.id;

    const readyState = await publishReadyConversationState(
      tab.id,
      shouldNavigateFresh ? siteConfig.homeUrl : (expectedBinding.chatUrl || tab.url || null),
      { submitScraped: false },
    );

    if (expectedBinding.chatUrl && !shared.conversationUrlsMatch(readyState?.chatUrl, expectedBinding.chatUrl)) {
      throw new Error("The ready conversation does not match the expected conversation binding.");
    }
    if (shouldNavigateFresh && queryTarget === "gemini" &&
        (!isSiteHomeUrl(readyState?.chatUrl, siteConfig) || Number(readyState?.transcriptCount || 0) > 0 || readyState?.messages?.length > 0)) {
      throw new Error("Gemini did not confirm a fresh empty conversation.");
    }

    broadcastStatus(
      "running",
      isFollowup
        ? "Sending follow-up…"
        : "Preparing fresh chat and prompt…",
    );
    debugLog("pipeline_ready", {
      seq,
      attempt,
      startsFresh,
      readyState,
    });

    // ── Stream via port connection ─────────────────────────────────
    const {
      text: responseText,
      thinking: thinkingText,
      answerAnchorId,
      answerRevision,
      thinkingRevision,
      runState,
      completionReason,
      finalTranscriptHash,
      verifiedAt,
      remoteChatUrl,
      remoteChatId,
      userTurnKey,
      assistantTurnKey,
      baselineTranscriptCount,
      baselineTranscriptHash,
      turnStatus,
      diagnostic,
    } = await streamPipeline(tab.id, {
      pdfBase64:    query.pdf_base64 || null,
      pdfFilename:  query.pdf_base64 ? (query.pdf_filename || "document.pdf") : null,
      prompt:       query.prompt,
      images:       query.images || null,
      chatgptMode:  query.chatgpt_mode || null,
      deliveryContractVersion: query.delivery_contract_version,
      expectedChatUrl: expectedBinding.chatUrl || (shouldNavigateFresh ? siteConfig.homeUrl : null),
      forceNewChat: shouldNavigateFresh,
      seq,
      attempt,
    });

    let finalRunState = runState;
    let finalCompletionReason = completionReason || null;
    if (finalRunState === "done" && !shared.hasMeaningfulAssistantText(responseText)) {
      const hasPartialContext =
        Boolean((thinkingText || "").trim()) ||
        Number(answerRevision || 0) > 0 ||
        Number(thinkingRevision || 0) > 0;
      if (hasPartialContext) {
        finalRunState = "incomplete";
        finalCompletionReason = finalCompletionReason || "error";
      } else {
        throw new Error(`${siteLabel} did not produce a visible final answer.`);
      }
    }

    await serverPost("/submit_response", {
      seq,
      attempt,
      response: responseText || null,
      thinking: thinkingText ?? null,
      error:    null,
      answer_anchor_id: answerAnchorId || null,
      answer_revision: answerRevision || 0,
      thinking_revision: thinkingRevision || 0,
      run_state: finalRunState,
      completion_reason: finalCompletionReason,
      final_transcript_hash: finalTranscriptHash || null,
      verified_at: verifiedAt || null,
      remote_chat_url: remoteChatUrl || null,
      remote_chat_id: remoteChatId || null,
      user_turn_key: userTurnKey || null,
      assistant_turn_key: assistantTurnKey || null,
      baseline_transcript_count: baselineTranscriptCount || 0,
      baseline_transcript_hash: baselineTranscriptHash || null,
      turn_status:
        turnStatus ||
        (finalRunState === "incomplete" ? "incomplete" : "done"),
      diagnostic: diagnostic || null,
    });

    // Capture the conversation URL for history persistence (works for all sites)
    try {
      const currentTab = await chrome.tabs.get(activeChatTabId);
      const tabSiteConfig = currentTab.url ? getSiteConfigByUrl(currentTab.url) : null;
      if (tabSiteConfig && currentTab.url !== tabSiteConfig.homeUrl) {
        await serverPost("/update_chat_url", { chat_url: currentTab.url });
      }
    } catch (_) {}

    broadcastStatus(
      finalRunState === "incomplete" ? "error" : "done",
      finalRunState === "incomplete"
        ? "Captured partial response — final answer not verified"
        : "Response sent to GUI",
    );

  } catch (err) {
    if (
      (
        err?.name === "PreSubmitDisconnect" ||
        err?.name === "ContentScriptMessageUnavailable"
      ) &&
      attempt < MAX_PRE_SUBMIT_RELEASES
    ) {
      try {
        await releaseQuery(seq, attempt);
        broadcastStatus(
          "running",
          "Reconnecting to the chat tab before prompt delivery…",
        );
        return;
      } catch (_) {
        // Fall through to surfacing a real error if the release itself failed.
      }
    }

    if (err?.name !== "RelayAttemptEnded") {
      await submitError(seq, err.message, attempt, err.diagnostic || null);
    }

    const msg = err.message.includes("Failed to fetch")
      ? "Cannot reach local server. Is gui.py running?"
      : err.message;
    broadcastStatus("error", msg);

  } finally {
    if (
      activePipelineSeq === seq &&
      activePipelineAttempt === attempt
    ) {
      activePipelineSeq = 0;
      activePipelineAttempt = 0;
    }
    pipelineRunning = false;
  }
}

async function submitError(seq, errorMsg, attempt, diagnostic = null) {
  try {
    await serverPost("/submit_response", {
      seq,
      attempt,
      response: null,
      error: errorMsg,
      diagnostic,
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

async function getChatTab(target) {
  const config = getSiteConfig(target || activeTarget);
  const tabs = await chrome.tabs.query({ url: config.urlPattern });
  if (tabs.length > 0) return tabs[0];  // reuse silently, no focus change
  // Open a new tab in the background (active: false keeps user's focus)
  const tab = await chrome.tabs.create({ url: config.homeUrl, active: false });
  await waitForTabLoad(tab.id);
  return tab;
}

// Backward compat alias
async function getChatGPTTab() {
  return getChatTab(activeTarget);
}

function waitForTabLoad(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish();
        return;
      }
      if (tab && tab.status === "complete") {
        finish();
      }
    });
  });
}

// Clear activeChatTabId if the user closes the chat tab
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeChatTabId) {
    activeChatTabId = null;
    broadcastStatus("idle", "Chat tab closed — next query will open a new conversation");
  }
});

// ---------------------------------------------------------------------------
// Content script messaging (with retry)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Port-based streaming pipeline
// ---------------------------------------------------------------------------

function streamPipeline(tabId, payload) {
  // Disconnect any stale port from a previous pipeline
  if (activePort) {
    try { activePort.disconnect(); } catch (_) {}
    activePort = null;
  }

  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "sync-zotero" });
    activePort = port;
    let resolved = false;
    let submitted = false;
    let streamingAcked = false;
    let relayPostFailureCount = 0;
    let timeoutId = null;
    let relayWatchdogId = null;
    let relayWatchdogInFlight = false;
    let relayWatchdogFailureCount = 0;
    let terminating = false;

    const disconnectPort = () => {
      if (activePort === port) activePort = null;
      try { port.disconnect(); } catch (_) {}
    };

    const finish = (callback, value) => {
      if (resolved) return;
      resolved = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (relayWatchdogId !== null) clearInterval(relayWatchdogId);
      disconnectPort();
      callback(value);
    };

    const requestProviderStop = () =>
      shared.stopSubmittedProviderAttempt({
        submitted,
        seq: payload.seq,
        attempt: payload.attempt,
        sendStop: (message, complete) => {
          chrome.tabs.sendMessage(tabId, message, (response) => {
            const sendError = chrome.runtime.lastError;
            complete(sendError ? { ok: false } : response);
          });
        },
      });

    const failPipeline = async (error) => {
      if (resolved || terminating) return;
      terminating = true;
      await requestProviderStop();
      finish(reject, error);
    };

    const handleRelayUpdateError = async (err, context, diagnostic = null) => {
      const reason = err?.message || String(err);
      relayPostFailureCount += 1;
      const isContractMismatch = /(?:^|\b)(seq_mismatch|attempt_mismatch)(?:\b|$)/i.test(reason);
      if (isContractMismatch || relayPostFailureCount >= 3) {
        const error = new Error(`Relay update failed during ${context}: ${reason}`);
        error.diagnostic = diagnostic || null;
        await failPipeline(error);
        return false;
      }
      console.warn(`[sync-zotero] Relay update failed during ${context}: ${reason}`);
      return true;
    };

    const postRelayUpdate = async (context, diagnostic, fn) => {
      if (resolved || terminating) return false;
      try {
        await fn();
        relayPostFailureCount = 0;
        return true;
      } catch (err) {
        return await handleRelayUpdateError(err, context, diagnostic);
      }
    };

    timeoutId = setTimeout(() => {
      void failPipeline(new Error("Pipeline timed out after 60 minutes"));
    }, PIPELINE_TIMEOUT_MS);

    const checkRelayAttempt = async () => {
      if (resolved || terminating || relayWatchdogInFlight) return;
      relayWatchdogInFlight = true;
      try {
        const state = await serverGet("/poll_response?since=0");
        relayWatchdogFailureCount = 0;
        const attemptState = shared.classifyRelayAttemptState(state, {
          seq: payload.seq,
          attempt: payload.attempt,
        });
        if (!attemptState.active) {
          const error = new Error(
            attemptState.error ||
              `Relay ended WebChat attempt (${attemptState.reason}).`,
          );
          error.name = "RelayAttemptEnded";
          await failPipeline(error);
        }
      } catch (err) {
        relayWatchdogFailureCount += 1;
        if (
          relayWatchdogFailureCount >=
          RELAY_ATTEMPT_WATCHDOG_FAILURE_LIMIT
        ) {
          await failPipeline(
            new Error(
              `Lost contact with the Zotero relay during the active WebChat attempt: ${err?.message || String(err)}`,
            ),
          );
        }
      } finally {
        relayWatchdogInFlight = false;
      }
    };
    relayWatchdogId = setInterval(
      () => void checkRelayAttempt(),
      RELAY_ATTEMPT_WATCHDOG_INTERVAL_MS,
    );

    port.onMessage.addListener(async (msg) => {
      if (msg.seq !== undefined && msg.seq !== payload.seq) return;
      if (msg.attempt !== undefined && msg.attempt !== payload.attempt) return;

      if (msg.type === "phase") {
        const requiresDurableAck =
          msg.phase === "prompt_applied" || msg.phase === "submit_started";
        if (
          msg.phase === "submit_started" ||
          msg.phase === "submitted" ||
          msg.phase === "streaming"
        ) {
          submitted = true;
        }
        if (requiresDurableAck) {
          try {
            await ackQueryPhase(
              payload.seq,
              payload.attempt,
              msg.phase,
              msg.diagnostic || null,
            );
            relayPostFailureCount = 0;
            port.postMessage({
              type: "phase_ack",
              seq: payload.seq,
              attempt: payload.attempt,
              phase: msg.phase,
            });
          } catch (err) {
            const reason = err?.message || String(err);
            const error = new Error(
              `Relay update failed during phase:${msg.phase}: ${reason}`,
            );
            error.diagnostic = msg.diagnostic || null;
            await failPipeline(error);
          }
          return;
        }
        if (
          !(await postRelayUpdate(
            `phase:${msg.phase}`,
            msg.diagnostic || null,
            () =>
              ackQueryPhase(
                payload.seq,
                payload.attempt,
                msg.phase,
                msg.diagnostic || null,
              ),
          ))
        )
          return;
      } else if (msg.type === "turn_state") {
        if (!(await postRelayUpdate(
          `turn_state:${msg.turnStatus || "unknown"}`,
          msg.diagnostic || null,
          () => reportTurnState({
            seq: payload.seq,
            attempt: payload.attempt,
            remote_chat_url: msg.remoteChatUrl ?? null,
            remote_chat_id: msg.remoteChatId ?? null,
            user_turn_key: msg.userTurnKey ?? null,
            assistant_turn_key: msg.assistantTurnKey ?? null,
            baseline_transcript_count: msg.baselineTranscriptCount ?? 0,
            baseline_transcript_hash: msg.baselineTranscriptHash ?? null,
            turn_status: msg.turnStatus ?? null,
            diagnostic: msg.diagnostic ?? null,
          }),
        ))) return;
      } else if (msg.type === "snapshot") {
        if (!streamingAcked) {
          streamingAcked = true;
          submitted = true;
          if (!(await postRelayUpdate(
            "phase:streaming",
            msg.diagnostic || null,
            () => ackQueryPhase(payload.seq, payload.attempt, "streaming", msg.diagnostic || null),
          ))) return;
        }
        broadcastStatus(
          "running",
          msg.runState === "settling"
            ? "Settling visible response…"
            : (msg.thinking ? "Thinking…" : "Streaming response…"),
        );
        if (!(await postRelayUpdate(
          "snapshot",
          msg.diagnostic || null,
          () => serverPost("/update_partial", {
            seq:     payload.seq,
            attempt: payload.attempt,
            answer_snapshot: msg.answerSnapshot ?? msg.text ?? null,
            thinking_snapshot: msg.thinkingSnapshot ?? msg.thinking ?? null,
            text:    msg.text    ?? null,
            thinking: msg.thinking ?? null,
            answer_anchor_id: msg.answerAnchorId ?? null,
            answer_revision: msg.answerRevision ?? 0,
            thinking_revision: msg.thinkingRevision ?? 0,
            run_state: msg.runState ?? null,
            completion_reason: msg.completionReason ?? null,
            remote_chat_url: msg.remoteChatUrl ?? null,
            remote_chat_id: msg.remoteChatId ?? null,
            user_turn_key: msg.userTurnKey ?? null,
            assistant_turn_key: msg.assistantTurnKey ?? null,
            baseline_transcript_count: msg.baselineTranscriptCount ?? 0,
            baseline_transcript_hash: msg.baselineTranscriptHash ?? null,
            turn_status: msg.turnStatus ?? null,
            diagnostic: msg.diagnostic ?? null,
          }),
        ))) return;
      } else if (msg.type === "mode_report") {
        // Forward ChatGPT's actual mode back to the plugin relay
        serverPost("/update_mode", { seq: payload.seq, mode: msg.mode }).catch(() => {});
      } else if (msg.type === "terminal") {
        finish(resolve, {
          text: msg.text || "",
          thinking: msg.thinking ?? null,
          answerAnchorId: msg.answerAnchorId ?? null,
          answerRevision: msg.answerRevision ?? 0,
          thinkingRevision: msg.thinkingRevision ?? 0,
          runState: msg.runState || "done",
          completionReason: msg.completionReason ?? null,
          finalTranscriptHash: msg.finalTranscriptHash ?? null,
          verifiedAt: msg.verifiedAt ?? null,
          remoteChatUrl: msg.remoteChatUrl ?? null,
          remoteChatId: msg.remoteChatId ?? null,
          userTurnKey: msg.userTurnKey ?? null,
          assistantTurnKey: msg.assistantTurnKey ?? null,
          baselineTranscriptCount: msg.baselineTranscriptCount ?? 0,
          baselineTranscriptHash: msg.baselineTranscriptHash ?? null,
          turnStatus: msg.turnStatus ?? null,
          diagnostic: msg.diagnostic ?? null,
        });
      } else if (msg.type === "error") {
        const error = new Error(formatDiagnosticError(msg.error, msg.diagnostic || null));
        error.diagnostic = msg.diagnostic || null;
        await failPipeline(error);
      }
    });

    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
      if (!resolved) {
        if (timeoutId !== null) clearTimeout(timeoutId);
        const err = chrome.runtime.lastError;
        const error = new Error("Port disconnected unexpectedly" + (err ? ": " + err.message : ""));
        error.name = submitted ? "PipelineDisconnect" : "PreSubmitDisconnect";
        void failPipeline(error);
      }
    });

    port.postMessage({ type: "START", ...payload });
  });
}

// ---------------------------------------------------------------------------
// Idempotent one-shot content-script messaging
// ---------------------------------------------------------------------------

function sendContentScriptMessageOnce(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function recoverContentScriptMessage(
  tabId,
  { delayMs, classification, nextAttempt },
) {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const tab = await chrome.tabs.get(tabId);
  if (shared.tabNeedsLifecycleReload(tab)) {
    await reloadTab(tabId);
    await waitForTabLoad(tabId, CONTENT_SCRIPT_RECOVERY_TIMEOUT_MS);
  }
  console.warn(
    `[sync-zotero] Recovering content-script message after ${classification.code}; retry ${nextAttempt}/${MAX_CONTENT_SCRIPT_MESSAGE_ATTEMPTS}`,
  );
  await ensureContentScript(tabId);
}

async function sendToContentScript(tabId, message) {
  const retrySafe = shared.isRetrySafeContentScriptMessage(message);
  const maxAttempts = retrySafe
    ? MAX_CONTENT_SCRIPT_MESSAGE_ATTEMPTS
    : 1;
  try {
    return await shared.retryRecoverableContentScriptMessage({
      maxAttempts,
      sendAttempt: async () => {
        await ensureTabReady(tabId);
        await ensureContentScript(tabId);
        return sendContentScriptMessageOnce(tabId, message);
      },
      recover: (context) => recoverContentScriptMessage(tabId, context),
    });
  } catch (error) {
    const classification =
      shared.classifyContentScriptMessageError(error);
    if (classification.recoverable) {
      error.name = "ContentScriptMessageUnavailable";
      error.code = classification.code;
    }
    throw error;
  }
}

async function ensureTabReady(
  tabId,
  timeoutMs = CONTENT_SCRIPT_RECOVERY_TIMEOUT_MS,
) {
  // A discarded tab can still report status=complete even though its document
  // and content-script context no longer exist.
  let tab = await chrome.tabs.get(tabId);
  if (shared.tabNeedsLifecycleReload(tab)) {
    await reloadTab(tabId);
    await waitForTabLoad(tabId, timeoutMs);
    tab = await chrome.tabs.get(tabId);
  }

  // Chrome's status is a coarse navigation signal and can remain "loading"
  // after the target document is interactive. Content-script PING/injection
  // below is the authoritative readiness probe, so do not fail solely because
  // this status has not caught up.
  return tab;
}

async function ensureTabActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!shared.tabNeedsActivation(tab)) return tab;
  return chrome.tabs.update(tabId, { active: true });
}

async function reloadTab(tabId) {
  await new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function ensureContentScript(tabId, requiredDeliveryContractVersion) {
  const tab = await chrome.tabs.get(tabId);
  const siteConfig = getSiteConfigByUrl(tab.url);
  if (!siteConfig) throw new Error("Unsupported WebChat tab URL.");
  const domCapture = siteConfig.siteId === "gemini" || siteConfig.siteId === "notebooklm";
  const pingContentScript = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
        resolve(chrome.runtime.lastError ? null : (res || null));
      });
    });
  const hasRequiredContract = (health) =>
    (!domCapture || (health?.answerCapture === "dom" && health?.supportedTargets?.includes(siteConfig.siteId))) && shared.contentScriptMeetsDeliveryContractRequirement(
      health,
      requiredDeliveryContractVersion,
    );
  const injectMainWorld = async () => {
    if (domCapture) return;
    try {
      await chrome.scripting.executeScript({
    target: { tabId },
    files: siteConfig.siteId === "notebooklm"
      ? ["webchat_shared.js", "notebooklm_adapter.js", "content_script.js"]
      : (siteConfig.siteId === "gemini"
          ? ["webchat_shared.js", "gemini_adapter.js", "content_script.js"]
          : ["webchat_shared.js", "content_script.js"]),
  });
    } catch (_) {}
  };

  // Network-backed providers require the MAIN world SSE interceptor.
  // It has its own __syncZoteroFetchPatched guard to avoid double-patching,
  // but after full page reloads the guard resets and re-injection is needed.
  await injectMainWorld();

  // Try pinging the content script
  let health = await pingContentScript();

  if (hasRequiredContract(health)) return health;
  if (health?.pong === true) {
    // A responsive but incompatible script can otherwise perform the
    // irreversible click during an extension hot-upgrade race.
    await reloadTab(tabId);
    await waitForTabLoad(tabId, CONTENT_SCRIPT_RECOVERY_TIMEOUT_MS);
    await injectMainWorld();
    health = await pingContentScript();
    if (hasRequiredContract(health)) return health;
  }

  // Content script not responsive — inject the shared helpers and listener in
  // manifest order. This also repairs tabs whose old extension context became
  // stale after an extension reload.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: siteConfig.siteId === "gemini" ? ["webchat_shared.js", "gemini_adapter.js", "content_script.js"] : (siteConfig.siteId === "notebooklm" ? ["webchat_shared.js", "notebooklm_adapter.js", "content_script.js"] : ["webchat_shared.js", "content_script.js"]),
  });

  // Poll briefly instead of always paying a fixed 1s delay after injection.
  for (let attempt = 0; attempt < 10; attempt++) {
    health = await pingContentScript();
    if (hasRequiredContract(health)) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const error = new Error(
    `Content script did not advertise WebChat delivery contract ${String(
      requiredDeliveryContractVersion,
    )} after recovery.`,
  );
  error.code = Number(requiredDeliveryContractVersion) > 0
    ? "delivery_contract_unsupported"
    : "content_script_unresponsive";
  throw error;
}

// ---------------------------------------------------------------------------
// Status broadcasting
// ---------------------------------------------------------------------------

function broadcastStatus(state, message) {
  chrome.storage.session.set({ pipelineStatus: { state, message } });
  chrome.runtime.sendMessage({
    type: "STATUS_UPDATE",
    state,
    message,
    relayAlive: zoteroConnected,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Message listener (popup status requests only)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    chrome.storage.session.get("pipelineStatus", (data) => {
      sendResponse(data.pipelineStatus || { state: "idle", message: "Ready" });
    });
    return true;
  }

  if (msg.type === "GET_FULL_STATUS") {
    (async () => {
      // Check embedded relay
      let relayAlive = false;
      try {
        const res = await relayFetch(`${SERVER}/poll_response?since=0`);
        relayAlive = res.ok;
      } catch { /* offline */ }

      // Check chat tabs — look for ANY open supported chat tab
      let chatTabAlive = false;
      let chatUrl = null;
      let activeSiteLabel = "Chat Site";
      try {
        const siteConfig = getSiteConfig(activeTarget);
        activeSiteLabel = getSiteConfig(activeTarget).label || "Chat";

        // Check the active target's site first
        let tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
        // Fall back to checking all supported sites
        if (tabs.length === 0) {
          for (const pattern of ALL_SITE_URL_PATTERNS) {
            tabs = await chrome.tabs.query({ url: pattern });
            if (tabs.length > 0) {
              const foundConfig = getSiteConfigByUrl(tabs[0].url);
              if (foundConfig) activeSiteLabel = foundConfig.label || "Chat";
              break;
            }
          }
        }
        if (tabs.length > 0) {
          chatTabAlive = true;
          const preferred = activeChatTabId !== null
            ? tabs.find(t => t.id === activeChatTabId) || tabs[0]
            : tabs[0];
          chatUrl = preferred.url || null;
        }
      } catch { /* no tabs */ }

      // Pipeline status
      const stored = await chrome.storage.session.get("pipelineStatus");
      const ps = stored.pipelineStatus || { state: "idle", message: "Ready" };

      sendResponse({
        relayAlive,
        zoteroConnected,
        chatTabAlive,
        chatUrl,
        activeSiteLabel,
        pipelineState: ps.state,
        pipelineMessage: ps.message,
      });
    })();
    return true; // async sendResponse
  }
});


// ============================================================================
// NZBridge Integration — Bidirectional Collection & Note Sync
// ============================================================================

/**
 * n2z Browser Extension — Background Service Worker
 *
 * Orchestrates bidirectional sync between Zotero and NotebookLM:
 * - Forward sync: Zotero collections → NotebookLM notebooks (via URL/file injection)
 * - Backward sync: NotebookLM notes → Zotero collections (via DOM scraping)
 */

// Pure prune/match helpers (shared with test/reconcile.check.cjs).
// (reconcile.js loaded at worker start)

const ZOTERO_BASE = "http://localhost:23119";

// Prevents overlapping syncs on the same NotebookLM tab from colliding on
// chrome.debugger.attach, interleaving CDP commands, or writing duplicate
// syncedItemHashes. Keyed by tabId.
const activeSyncs = new Set();

// Tabs whose in-progress forward sync the user asked to cancel. The sync loop
// checks this at safe checkpoints (before each file batch / the URL phase) and
// stops cleanly, leaving already-uploaded sources in place. Keyed by tabId.
const cancelledSyncs = new Set();

// Stores the last known progress/result for each tabId so the popup can
// poll for updates without a long-lived message channel.
// Shape: { phase, current, total, currentTitle, done, result }
const syncProgress = new Map();

// Gemini Notebook now uses notebook.google.com. Keep the legacy NotebookLM
// host during the rollout because existing accounts and links may use either.
const NOTEBOOK_URL_PATTERNS = [
  "https://notebook.google.com/*",
  "https://notebooklm.google.com/*",
];

function isNotebookUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      ["notebook.google.com", "notebooklm.google.com"].includes(
        parsed.hostname,
      ) && parsed.pathname.startsWith("/notebook/")
    );
  } catch {
    return false;
  }
}
const AMBIGUOUS_TAB_ERROR =
  "Multiple NotebookLM tabs are open. Please switch to the notebook you want to sync into and try again.";

// ─── File-upload tuning ──────────────────────────────────────────────
// Files are uploaded in batches (one Add-sources dialog cycle per batch).
// Each batch is dropped exactly ONCE; we then wait for NotebookLM to finish
// processing it (source count grows and the spinner clears) before opening the
// next dialog. We never re-drop a batch — re-dropping while the first upload is
// still in flight is what caused duplicate sources.
const FILE_BATCH_SIZE = 4; // files per dialog open/drop/close cycle
const SETTLE_TIMEOUT_MS = 45000; // max wait for a batch to finish processing
const SETTLE_POLL_MS = 500; // poll cadence while waiting to settle
const SETTLE_QUIET_MS = 1200; // require the count stable + not busy this long
const SETTLE_FALLBACK_SLEEP_MS = 4000; // used only when the panel is unreadable

// The "Upload files" button click can transiently miss when the dialog UI isn't
// fully interactive yet (button not hit-testable, or rendered a frame late), so
// the file chooser never opens. Rather than fail the whole batch on a single
// miss, we re-read fresh coords and re-fire the trusted click a few times, each
// with a short chooser timeout so a miss is detected fast instead of burning a
// long budget. If every drop attempt still misses, the batch is retried wholesale
// (a fresh dialog cycle), which is what a manual re-sync did by hand.
const UPLOAD_CLICK_ATTEMPTS = 3; // trusted-click → file-chooser retries per drop
const CHOOSER_ATTEMPT_TIMEOUT_MS = 5000; // per-attempt wait for Page.fileChooserOpened
const BATCH_UPLOAD_ATTEMPTS = 3; // full drop+settle retries before giving up on a batch

// ─── Zotero API helpers ──────────────────────────────────────────────

// Chrome/Edge 142+ "Local Network Access" classifies the extension service
// worker as a "public" origin and blocks requests to loopback targets
// (localhost:23119) unless the user grants the "Local network access"
// permission. A service worker cannot trigger that prompt itself, so the
// fetch fails/hangs. We surface this guidance whenever a connection can't be
// established so the user (or IT) knows the exact toggle to flip.
const LNA_HINT =
  "If Zotero is running, Chrome/Edge may be blocking the local connection. " +
  "Open chrome://extensions → NZBridge → Details → Site settings, and set " +
  '"Local network access" to Allow, then try again. (Edge: edge://extensions)';

// Default timeout for normal API calls. Short so connection/collection checks
// fail fast instead of hanging until the popup's message timeout.
const ZOTERO_TIMEOUT_MS = 8000;
// File transfers (/n2z/file) return base64 PDFs and can be large; give them
// a much longer budget.
const ZOTERO_FILE_TIMEOUT_MS = 60000;

async function zoteroRequest(
  path,
  body = null,
  { timeoutMs = ZOTERO_TIMEOUT_MS } = {},
) {
  const options = {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "Zotero-Allowed-Request": "true",
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${ZOTERO_BASE}${path}`, options);
  } catch (e) {
    // AbortSignal.timeout() throws TimeoutError; a network/LNA block throws
    // TypeError ("Failed to fetch"). Both mean "couldn't reach Zotero" — tag
    // with a code so callers can render the right guidance.
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const err = new Error(
      (timedOut
        ? "Connection to Zotero timed out. "
        : "Could not reach Zotero on localhost:23119. ") + LNA_HINT,
    );
    err.code = timedOut ? "timeout" : "blocked-or-down";
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Zotero returned HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(
      "Zotero returned a non-JSON response (plugin may have crashed).",
    );
  }
}

async function checkZoteroConnection() {
  try {
    const res = await zoteroRequest("/n2z/status");
    return { connected: res.success === true, reason: "ok" };
  } catch (e) {
    return { connected: false, reason: e?.code || "blocked-or-down" };
  }
}

async function getLibraries() {
  return zoteroRequest("/n2z/libraries", {});
}

async function getCollections(libraryId) {
  return zoteroRequest("/n2z/collections", { libraryId });
}

async function getTags(libraryId) {
  console.log(`[n2z] getTags(libraryId=${libraryId})`);
  const result = await zoteroRequest("/n2z/tags", { libraryId });
  console.log(`[n2z] getTags result:`, result);
  return result;
}

async function getExportableItems({ collectionId, libraryId, tag } = {}) {
  if (tag != null && libraryId != null) {
    return zoteroRequest("/n2z/list", { libraryId, tag });
  }
  return zoteroRequest("/n2z/list", { collectionId });
}

async function getFile(attachmentId) {
  return zoteroRequest(
    "/n2z/file",
    { attachmentId },
    { timeoutMs: ZOTERO_FILE_TIMEOUT_MS },
  );
}

async function getMappings() {
  return zoteroRequest("/n2z/mapping", { action: "getAll" });
}

async function setMapping(mapping) {
  return zoteroRequest("/n2z/mapping", { action: "set", mapping });
}

async function removeMapping(collectionId) {
  return zoteroRequest("/n2z/mapping", { action: "remove", collectionId });
}

async function importNotesToZotero(notes) {
  return zoteroRequest("/n2z/import-notes", notes);
}

// ─── NotebookLM tab helpers ──────────────────────────────────────────

/**
 * Resolves which NotebookLM tab a sync operation should target.
 *
 * Strategy order:
 *   1. "active"     — active tab of the last-focused window is NotebookLM
 *   2. "preferred"  — a NotebookLM tab whose URL matches preferredNotebookId
 *   3. "sole"       — exactly one NotebookLM tab is open anywhere
 *   4. "none"       — no NotebookLM tab open
 *   5. "ambiguous"  — multiple NotebookLM tabs open and none match
 */
async function resolveNotebookLMTab(preferredNotebookId = null) {
  const activeTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const active = activeTabs[0];
  if (isNotebookUrl(active?.url)) {
    return { tab: active, reason: "active" };
  }

  const candidateTabs = await chrome.tabs.query({
    url: NOTEBOOK_URL_PATTERNS,
  });
  const allNotebookLMTabs = candidateTabs.filter((tab) =>
    isNotebookUrl(tab.url),
  );

  if (preferredNotebookId) {
    const match = allNotebookLMTabs.find((t) =>
      t.url?.includes(`/notebook/${preferredNotebookId}`),
    );
    if (match) return { tab: match, reason: "preferred" };
  }

  if (allNotebookLMTabs.length === 1) {
    return { tab: allNotebookLMTabs[0], reason: "sole" };
  }
  if (allNotebookLMTabs.length === 0) {
    return { tab: null, reason: "none" };
  }
  return { tab: null, reason: "ambiguous" };
}

async function findNotebookLMTab() {
  const { tab } = await resolveNotebookLMTab();
  return tab;
}

function extractNotebookIdFromUrl(url) {
  const match = url.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// chrome.storage.local key for cached extracted notes of a notebook.
function notesCacheKey(notebookId) {
  return `extractedNotes_${notebookId}`;
}

// ─── Forward Sync ────────────────────────────────────────────────────

/**
 * Normalizes an item (new plugin with `units`, or legacy shape) into a unit
 * list. Legacy items get a single default unit synthesized from their
 * top-level fields. Must stay in sync with the popup's copy.
 */
function ensureUnits(item) {
  if (Array.isArray(item.units) && item.units.length > 0) return item.units;
  return item.exportType === "file"
    ? [
        {
          unitId: "att-" + item.attachmentId,
          kind: "file",
          attachmentId: item.attachmentId,
          title: item.attachmentTitle || item.title,
          contentType: item.contentType,
          filename: item.filename,
          fileSize: item.fileSize,
          isDefault: true,
        },
      ]
    : [
        {
          unitId: "item-url",
          kind: "url",
          attachmentId: 0,
          title: item.title || item.url,
          contentType: "text/url",
          filename: "",
          fileSize: 0,
          url: item.url,
          isDefault: true,
        },
      ];
}

/**
 * Canonical marker/selection key for one unit. The default unit keeps the
 * bare itemKey so historical per-item markers stay valid.
 */
function unitKey(item, unit) {
  return unit.isDefault ? item.itemKey : item.itemKey + "::" + unit.unitId;
}

/** Display title for progress and failure lists. */
function unitTitle(p) {
  return p.unit.filename || p.unit.title || p.item.title;
}

/** Display/marker name for a URL unit (item context for defaults). */
function urlUnitName(p) {
  return p.unit.isDefault
    ? p.item.title || p.unit.url || ""
    : p.unit.title || p.item.title || p.unit.url || "";
}

/**
 * Performs forward sync: gets items from Zotero and returns them
 * so the popup can display what will be synced. Actual injection
 * happens per-item via addUrlSource or file injection.
 */
async function forwardSync(
  collectionId,
  collectionName,
  selectedItemKeys,
  libraryId,
  libraryName,
  tag,
  selectedUnits,
) {
  // 1. Resolve which NotebookLM tab to target
  const { tab, reason } = await resolveNotebookLMTab();
  if (!tab) {
    return {
      success: false,
      error:
        reason === "ambiguous"
          ? AMBIGUOUS_TAB_ERROR
          : "No NotebookLM tab found. Please open NotebookLM first.",
    };
  }

  const notebookId = extractNotebookIdFromUrl(tab.url);
  if (!notebookId) {
    return {
      success: false,
      error: "Please navigate to a specific notebook in NotebookLM.",
    };
  }

  // Concurrency lock — prevent overlapping syncs on the same tab
  if (activeSyncs.has(tab.id)) {
    return {
      success: false,
      error: "A sync is already running on this NotebookLM tab.",
    };
  }
  activeSyncs.add(tab.id);

  // Reset progress state for this tab
  syncProgress.set(tab.id, {
    phase: "starting",
    current: 0,
    total: 0,
    currentTitle: "",
    done: false,
    result: null,
  });

  // Run the sync in the background — do NOT await it here.
  // The popup polls for progress via n2z-sync-status.
  forwardSyncImpl(
    tab,
    notebookId,
    collectionId,
    collectionName,
    selectedItemKeys,
    libraryId,
    libraryName,
    tag,
    selectedUnits,
  )
    .then((result) => {
      // Release the sync lock BEFORE broadcasting "done" so the popup's
      // post-sync re-render can reconcile against the tab (the reconcile
      // handler refuses to run while the tab is still in activeSyncs).
      activeSyncs.delete(tab.id);
      cancelledSyncs.delete(tab.id);
      syncProgress.set(tab.id, {
        ...syncProgress.get(tab.id),
        done: true,
        result,
      });
      broadcastProgress({ tabId: tab.id, done: true, result });
    })
    .catch((e) => {
      activeSyncs.delete(tab.id);
      cancelledSyncs.delete(tab.id);
      const result = { success: false, error: e.message };
      syncProgress.set(tab.id, {
        ...syncProgress.get(tab.id),
        done: true,
        result,
      });
      broadcastProgress({ tabId: tab.id, done: true, result });
    });

  return { success: true, started: true, tabId: tab.id };
}

async function forwardSyncImpl(
  tab,
  notebookId,
  collectionId,
  collectionName,
  selectedItemKeys,
  libraryId,
  libraryName,
  tag,
  selectedUnits,
) {
  // 1b. Set notebook title to the collection/tag name (user can change it later)
  if (collectionName) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [collectionName],
      func: (name) => {
        // NotebookLM's notebook title is typically an editable input/textarea
        // at the top of the page, or a contenteditable heading
        const candidates = document.querySelectorAll(
          'input, textarea, [contenteditable="true"], [contenteditable=""]',
        );
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          // Title is near the top of the page and reasonably wide
          if (rect.top > 200 || rect.width < 100 || rect.height === 0) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === "input" || tag === "textarea") {
            // Only set if it's a default/untitled notebook name
            const val = el.value || "";
            if (
              !val ||
              /^untitled/i.test(val) ||
              /^new notebook/i.test(val) ||
              val.length < 3
            ) {
              const setter =
                tag === "textarea"
                  ? Object.getOwnPropertyDescriptor(
                      window.HTMLTextAreaElement.prototype,
                      "value",
                    )?.set
                  : Object.getOwnPropertyDescriptor(
                      window.HTMLInputElement.prototype,
                      "value",
                    )?.set;
              if (setter) setter.call(el, name);
              else el.value = name;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              el.dispatchEvent(new Event("blur", { bubbles: true }));
              return { success: true, method: "input" };
            }
            return {
              success: false,
              reason: "notebook-already-named",
              current: val,
            };
          }
          if (el.getAttribute("contenteditable") !== null) {
            const text = el.textContent?.trim() || "";
            if (
              !text ||
              /^untitled/i.test(text) ||
              /^new notebook/i.test(text) ||
              text.length < 3
            ) {
              el.textContent = name;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("blur", { bubbles: true }));
              return { success: true, method: "contenteditable" };
            }
            return {
              success: false,
              reason: "notebook-already-named",
              current: text,
            };
          }
        }
        return { success: false, reason: "no-title-field-found" };
      },
    });
    await sleep(500);
  }

  // 1c. Ensure the "Sources" tab is active (may be on Chat or Studio)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const isIconElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = el.tagName?.toLowerCase() || "";
        const cls = (el.className || "").toString().toLowerCase();
        return (
          tag === "mat-icon" ||
          cls.includes("material-icons") ||
          cls.includes("mat-icon")
        );
      };
      const getCleanText = (node) => {
        let result = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
              continue;
            if (isIconElement(child)) continue;
            result += getCleanText(child);
          }
        }
        return result;
      };
      const clickables = document.querySelectorAll(
        '[role="tab"], button, [role="button"], a, [class*="tab"]',
      );
      const sourceTabLabels = [
        "sources",
        "source",
        "来源",
        "來源",
        "ソース",
        "情報源",
        "소스",
        "출처",
        "fuentes",
        "sources",
        "quellen",
        "fontes",
        "fonti",
        "bronnen",
        "sumber",
      ];
      for (const el of clickables) {
        const text = getCleanText(el).trim().toLowerCase();
        if (sourceTabLabels.includes(text)) {
          el.click();
          return true;
        }
      }
      return false;
    },
  });
  await sleep(1000);

  // 2. Get exportable items from Zotero (by collection or by tag across a library)
  const itemsRes = tag
    ? await getExportableItems({ libraryId, tag })
    : await getExportableItems({ collectionId });
  if (!itemsRes.success) {
    return {
      success: false,
      error: itemsRes.error || "Failed to get items from Zotero",
    };
  }

  const items = itemsRes.data;
  if (!items || items.length === 0) {
    return {
      success: false,
      error:
        "No exportable items found in this collection. Items need either a local PDF/file or a URL/DOI.",
    };
  }

  // Note: NotebookLM Pro users can exceed 50 sources. We no longer block here;
  // free-tier users will see failures from NotebookLM itself for sources beyond the limit.

  // 3. Check for already-synced items. The durable record is the Zotero
  // mapping (survives reopen, shown in the Mappings tab); the local copy is a
  // cache. Seed from the mapping when it matches this notebook, then merge the
  // local cache so nothing is lost either way.
  const syncKey = `sync_${collectionId}_${notebookId}`;
  const syncState = await chrome.storage.local.get(syncKey);
  let syncedHashes = { ...(syncState[syncKey] || {}) };
  try {
    const existingMapping = await zoteroRequest("/n2z/mapping", {
      action: "get",
      collectionId,
    });
    if (
      existingMapping?.success &&
      existingMapping.data?.notebookId === notebookId
    ) {
      syncedHashes = {
        ...(existingMapping.data.syncedItemHashes || {}),
        ...syncedHashes,
      };
    }
  } catch {
    /* mapping fetch is best-effort; fall back to local cache */
  }

  // Selection: EXPLICIT unit keys ("itemKey::unitId") from the popup, pinning
  // the exact attachment the user ticked at render time. The background
  // re-fetches /n2z/list HERE, and Zotero's best attachment can settle
  // differently in between for freshly added items — the old bare-itemKey
  // form meant "whatever is default NOW", which could upload a different
  // file than the one the UI showed as Main. A legacy `selectedItemKeys`
  // list (bare item keys, old callers) is still honored and maps to the
  // CURRENT default unit only, so old callers never get surprise extras.
  // null selection = all defaults.
  const selectedUnitSet = selectedUnits
    ? new Set(selectedUnits)
    : selectedItemKeys
      ? new Set(selectedItemKeys)
      : null;

  // Pending upload units: every not-yet-synced selected unit of every item.
  // Per-unit granularity means an item already synced for its main PDF still
  // exposes its other attachments for upload.
  const pending = [];
  for (const item of items) {
    for (const unit of ensureUnits(item)) {
      const key = unitKey(item, unit);
      if (syncedHashes[key]) continue;
      if (selectedUnitSet) {
        const explicit = item.itemKey + "::" + unit.unitId;
        const selected =
          selectedUnitSet.has(explicit) ||
          (unit.isDefault && selectedUnitSet.has(item.itemKey));
        if (!selected) continue;
      }
      pending.push({ item, unit, key });
      console.log(
        `[n2z] queued "${unit.kind === "file" ? unit.filename || unit.title : unit.url || unit.title}" ` +
          `(attachment ${unit.attachmentId}) for item ${item.itemKey} "${item.title}"`,
      );
    }
  }

  if (pending.length === 0) {
    const mapping = {
      collectionId,
      collectionName,
      libraryId,
      libraryName,
      notebookId,
      notebookUrl: tab.url,
      lastSyncForward: new Date().toISOString(),
      lastSyncBackward: null,
      syncedItemHashes: syncedHashes,
      importedNoteIds: [],
    };
    await setMapping(mapping);
    return {
      success: true,
      message: `All selected sources are already synced to this notebook.`,
      synced: 0,
      total: items.length,
      mapping,
    };
  }

  // 4. Separate by type
  const urlUnits = pending.filter((p) => p.unit.kind === "url");
  const fileUnits = pending.filter((p) => p.unit.kind === "file");
  const allResults = [];
  const totalUnits = pending.length;
  let doneCount = 0;

  const emitProgress = (phase, currentTitle, files) => {
    const state = {
      phase,
      current: doneCount,
      total: totalUnits,
      currentTitle: currentTitle || "",
      files: files || null,
      done: false,
      result: null,
    };
    syncProgress.set(tab.id, state);
    broadcastProgress({ tabId: tab.id, ...state });
  };

  // 5a. Add ALL URL sources at once (NotebookLM supports multiple URLs
  // separated by newlines in a single paste)
  if (urlUnits.length > 0) {
    emitProgress(
      "urls",
      `Adding ${urlUnits.length} URL${urlUnits.length > 1 ? "s" : ""}...`,
    );
    try {
      const urls = urlUnits.map((p) => p.unit.url);
      const result = await addUrlSourcesBatch(tab.id, urls);
      const confirmed = result.success;

      // Build detailed error from step info
      let errorDetail = result.error || "";
      if (!confirmed && result.steps) {
        const failedStep = Object.entries(result.steps).find(
          ([, v]) => !v?.success,
        );
        if (failedStep) {
          errorDetail = `Step ${failedStep[0]}: ${failedStep[1]?.error || "failed"}`;
        }
      }

      for (const p of urlUnits) {
        allResults.push({
          title: urlUnitName(p),
          success: confirmed,
          error: errorDetail,
          type: "url",
          __unitKey: p.key,
        });
        // Provisional marker; the real NotebookLM label is bound after the sync
        // settles (step 6). `name`/`url` are fallbacks if label capture fails.
        if (confirmed) {
          syncedHashes[p.key] = {
            at: Date.now(),
            name: urlUnitName(p) || "",
            url: p.unit.url || "",
          };
        }
        doneCount++;
      }
    } catch (e) {
      for (const p of urlUnits) {
        allResults.push({
          title: urlUnitName(p),
          success: false,
          error: e.message,
          type: "url",
        });
        doneCount++;
      }
    }
  }

  // 5b. Add file sources via CDP — upload in batches of FILE_BATCH_SIZE
  // (NotebookLM's file input accepts multiple files at once). Each batch is
  // dropped once, then we wait for it to finish processing before the next.
  // See FILE_BATCH_SIZE / SETTLE_* constants.

  if (fileUnits.length > 0 && urlUnits.length > 0) {
    await sleep(2000);
  }

  if (fileUnits.length > 0) {
    let debuggerAttached = false;
    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
      debuggerAttached = true;
    } catch (e) {
      for (const p of fileUnits) {
        allResults.push({
          title: unitTitle(p),
          success: false,
          error: `Debugger failed: ${e.message}`,
          type: "file",
        });
        doneCount++;
      }
    }

    if (debuggerAttached) {
      try {
        // Fetch file data (base64) from Zotero for each file unit
        const resolvedFiles = [];
        for (const p of fileUnits) {
          let fileRes;
          try {
            fileRes = await getFile(p.unit.attachmentId);
          } catch (e) {
            // Connection/LNA failure or timeout — e.message carries the
            // chrome://extensions guidance. Record per-unit and keep going.
            allResults.push({
              title: unitTitle(p),
              success: false,
              error: e.message,
              type: "file",
            });
            doneCount++;
            continue;
          }
          if (!fileRes.success || !fileRes.data) {
            allResults.push({
              title: unitTitle(p),
              success: false,
              error: "Could not fetch file from Zotero",
              type: "file",
            });
            doneCount++;
          } else {
            resolvedFiles.push({ ...p, fileData: fileRes.data });
          }
        }

        // Upload in batches via base64 drop. Each batch is dropped exactly
        // ONCE, then we wait for NotebookLM to finish ingesting it (source
        // count grows + spinner clears, held stable briefly) before opening
        // the next dialog. We never re-drop a batch — that was the cause of
        // duplicate sources. Already-synced items are skipped on the next sync
        // via syncedHashes, so a rare genuine miss is recovered then.
        for (let bi = 0; bi < resolvedFiles.length; bi += FILE_BATCH_SIZE) {
          // Cancel checkpoint: stop before starting a new batch (never mid-drop,
          // which would corrupt NotebookLM's dialog). Files already uploaded keep
          // their markers; remaining ones are recorded as cancelled.
          if (cancelledSyncs.has(tab.id)) {
            for (let j = bi; j < resolvedFiles.length; j++) {
              allResults.push({
                title: unitTitle(resolvedFiles[j]),
                success: false,
                error: "Cancelled",
                type: "file",
                __unitKey: resolvedFiles[j].key,
              });
            }
            break;
          }
          const batch = resolvedFiles.slice(bi, bi + FILE_BATCH_SIZE);
          const t0 = Date.now();

          const batchFileData = batch.map((p) => ({
            base64: p.fileData.base64,
            filename: p.fileData.filename,
            contentType: p.fileData.contentType || "application/pdf",
          }));

          // Show every file in this batch as a bulleted list in the popup.
          const batchTitles = batch.map((p) => unitTitle(p));
          const batchLabel =
            batch.length > 1
              ? `Uploading ${batch.length} files`
              : "Uploading 1 file";
          emitProgress("files", batchLabel, batchTitles);

          // Drop the batch and wait for it to land. We retry the whole cycle ONLY
          // when the drop itself failed (res.success === false) — i.e. the click
          // missed and the file chooser never opened, so provably ZERO files were
          // added and re-dropping is safe. This is the reported bug, and re-opening
          // a fresh dialog is exactly what a manual re-sync did by hand.
          //
          // We deliberately do NOT re-drop when the drop succeeded but the count
          // didn't confirm in time (slow ingestion): re-dropping there could
          // double-add files that were merely slow to land. Those are left
          // "Upload not confirmed" and recovered on the next sync via syncedHashes
          // (which only re-adds items NOT already marked synced). The Step-0
          // stale-dialog cleanup in injectFilesBatchViaCDP closes any dialog a
          // failed click attempt left open, so retries can't duplicate.
          let ok = false;
          let res = { success: false };
          let before = { count: null };
          let after = { count: null, busy: false, method: null };
          let landed = false;
          let attempts = 0;
          for (let a = 1; a <= BATCH_UPLOAD_ATTEMPTS; a++) {
            // Cancel checkpoint between attempts (never mid-drop).
            if (a > 1 && cancelledSyncs.has(tab.id)) break;
            attempts = a;

            before = await getSourceState(tab.id);
            res = await injectFilesBatchViaCDP(tab.id, batchFileData);

            // Only wait for the count to climb if the drop actually reported
            // success — otherwise no files were added and a 45s wait is wasted.
            landed = false;
            if (res.success) {
              if (before.count == null) {
                await sleep(SETTLE_FALLBACK_SLEEP_MS);
                landed = true; // best effort: panel unreadable, trust the drop
              } else {
                const target = before.count + batch.length;
                const deadline = Date.now() + SETTLE_TIMEOUT_MS;
                let reachedSince = null;
                while (Date.now() < deadline) {
                  const st = await getSourceState(tab.id);
                  const reached = st.count != null && st.count >= target;
                  if (reached) {
                    reachedSince = reachedSince ?? Date.now();
                    if (Date.now() - reachedSince >= SETTLE_QUIET_MS) {
                      landed = true;
                      break;
                    }
                  } else {
                    reachedSince = null;
                  }
                  await sleep(SETTLE_POLL_MS);
                }
              }
            }

            after = await getSourceState(tab.id);
            // Confirmed only when the full batch landed (count reached target) or
            // the panel was unreadable and the drop reported success. We don't
            // mark synced on a partial — better to re-sync the whole batch later
            // (a re-sync only re-adds items NOT in syncedHashes) than to falsely
            // skip a missing file.
            const fullTarget =
              before.count != null ? before.count + batch.length : null;
            ok =
              (before.count == null && landed) ||
              (fullTarget != null &&
                after.count != null &&
                after.count >= fullTarget);
            if (ok) break;
            // Re-drop only on a failed drop (zero files added). A successful drop
            // that didn't confirm is left for next-sync recovery — never re-dropped.
            if (res.success) break;
            if (a < BATCH_UPLOAD_ATTEMPTS)
              console.log(
                `[n2z] batch@${bi}: drop attempt ${a}/${BATCH_UPLOAD_ATTEMPTS} failed ` +
                  `(${res.error || "unknown"}); retrying`,
              );
          }

          for (const p of batch) {
            allResults.push({
              title: unitTitle(p),
              success: ok,
              error: ok ? undefined : "Upload not confirmed",
              type: "file",
              __unitKey: p.key,
            });
            // Provisional marker; the real NotebookLM label is bound after the
            // sync settles (step 6). `name` is a fallback if capture fails.
            if (ok)
              syncedHashes[p.key] = {
                at: Date.now(),
                name: p.fileData.filename || p.item.title || "",
              };
            doneCount++;
          }

          console.log(
            `[n2z] batch@${bi}: dropped ${batch.length}, ok=${ok}, attempts=${attempts}, ` +
              `before=${before.count}, after=${after.count}, landed=${landed}, busy=${after.busy}, ` +
              `drop=${res.success}, method=${after.method}, ${Date.now() - t0}ms`,
          );
        }
      } finally {
        try {
          await chrome.debugger.detach({ tabId: tab.id });
        } catch {}
      }
    }
  }

  // 6. Bind each just-synced item to its ACTUAL NotebookLM source, so reconcile
  // can later tell precisely whether that source still exists. The debugger is
  // detached and uploads are done, so the panel is safe to read.
  //   - URL items: matched to a live source by FAVICON DOMAIN (the source URL
  //     NotebookLM encodes in the favicon) — exact and order-independent.
  //   - PDF items: no favicon URL, so matched positionally to the remaining
  //     (non-URL) live sources, which appear in upload order.
  // We persist `label` (exact untruncated name) and `faviconDomain` per item;
  // reconcile checks those against the live list with no fuzzy matching.
  try {
    for (let i = 0; i < 6; i++) {
      const st = await getSourceState(tab.id);
      if (st && !st.busy) break;
      await sleep(1000);
    }
    const liveSources = await getSourceNames(tab.id); // [{label, faviconDomain}]
    if (liveSources && liveSources.length) {
      const norm = (u) => normalizeSourceUrl(u);

      // Match URL items by favicon domain.
      const remaining = [...liveSources];
      for (const r of allResults) {
        if (!r.success || r.type !== "url" || !r.__unitKey) continue;
        const marker = syncedHashes[r.__unitKey];
        if (!marker || typeof marker !== "object") continue;
        const wantUrl = norm(marker.url);
        const hitIdx = remaining.findIndex(
          (s) =>
            s.faviconDomain && wantUrl && norm(s.faviconDomain) === wantUrl,
        );
        if (hitIdx !== -1) {
          marker.label = remaining[hitIdx].label || marker.name;
          marker.faviconDomain = remaining[hitIdx].faviconDomain;
          remaining.splice(hitIdx, 1); // consume so duplicates map 1:1
        }
      }

      // Match file (PDF) items by filename against the live source labels.
      // NotebookLM may label a PDF from its metadata title (≈ filename minus
      // ".pdf"), so match exact, then normalized, then an explicit "…"
      // truncation. Each live source binds at most ONE marker, and a marker
      // with no confident match stays unbound — a positional guess used to
      // swap labels between same-paper siblings (NotebookLM sorts sources
      // alphabetically, not in upload order), which made reconcile keep
      // deleted siblings alive.
      const fileLeftovers = remaining
        .filter((s) => !s.faviconDomain)
        .map((s) => ({
          label: String(s.label || "").trim(),
          norm: normalizeSourceName(s.label),
        }));
      for (const r of allResults) {
        if (!r.success || r.type !== "file" || !r.__unitKey) continue;
        const marker = syncedHashes[r.__unitKey];
        if (!marker || typeof marker !== "object") continue;
        const want = String(marker.name || "").trim();
        if (!want || fileLeftovers.length === 0) continue;
        const wantNorm = normalizeSourceName(want);
        let hitIdx = fileLeftovers.findIndex((s) => s.label === want);
        if (hitIdx === -1 && wantNorm) {
          hitIdx = fileLeftovers.findIndex(
            (s) => s.norm && s.norm === wantNorm,
          );
        }
        if (hitIdx === -1 && wantNorm) {
          // Real truncation only — a prefix match on full labels would swap
          // "paper 1.pdf" and "paper.pdf".
          hitIdx = fileLeftovers.findIndex(
            (s) =>
              s.norm &&
              s.label.includes("…") &&
              wantNorm.length >= 6 &&
              (s.norm.startsWith(wantNorm) || wantNorm.startsWith(s.norm)),
          );
        }
        if (hitIdx === -1) continue; // no confident match — leave unbound
        marker.label = fileLeftovers[hitIdx].label;
        fileLeftovers.splice(hitIdx, 1);
      }
    }
  } catch (e) {
    console.warn("[n2z] Could not capture source mapping:", e);
  }

  // 6b. Save sync state (keyed by collection+notebook pair)
  await chrome.storage.local.set({
    [syncKey]: syncedHashes,
  });

  // 7. Update mapping in Zotero
  const mapping = {
    collectionId,
    collectionName,
    libraryId,
    libraryName,
    notebookId,
    notebookUrl: tab.url,
    lastSyncForward: new Date().toISOString(),
    lastSyncBackward: null,
    syncedItemHashes: syncedHashes,
    importedNoteIds: [],
  };
  await setMapping(mapping);

  const successCount = allResults.filter((r) => r.success).length;
  const failCount = allResults.filter((r) => !r.success).length;
  const wasCancelled = cancelledSyncs.has(tab.id);

  let message = wasCancelled
    ? `Sync cancelled — ${successCount} of ${pending.length} uploaded before stopping.`
    : `Synced ${successCount}/${pending.length} sources (${urlUnits.length} URLs, ${fileUnits.length} files).`;
  if (failCount > 0 && !wasCancelled) {
    const failed = allResults.filter((r) => !r.success);
    const titlePreview = failed
      .slice(0, 5)
      .map((r) => `"${r.title}"`)
      .join(", ");
    const remaining = failed.length - 5;
    const titleSuffix = remaining > 0 ? `, +${remaining} more` : "";
    message += ` ${failCount} failed: ${titlePreview}${titleSuffix}.`;

    const errorCounts = new Map();
    for (const r of failed) {
      const key = r.error || "Unknown error";
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    }
    const grouped = Array.from(errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([err, count]) => `${count}x "${err}"`)
      .join("; ");
    message += ` Errors: ${grouped}`;
  }

  return {
    success: successCount > 0 || failCount === 0,
    cancelled: wasCancelled,
    message,
    synced: successCount,
    failed: failCount,
    total: items.length,
    results: allResults,
    mapping,
  };
}

/**
 * Adds multiple URLs as sources in NotebookLM in a single batch.
 * NotebookLM's "Websites" dialog accepts multiple URLs separated by newlines.
 * Flow: Click "Add sources" → Click "Websites" → Paste all URLs → Click "Insert"
 */
async function addUrlSourcesBatch(tabId, urls) {
  // Shared helper injected into each step
  const getCleanTextFn = `
    const getCleanText = (el) => {
      let text = "";
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName?.toLowerCase() || "";
          const cls = (child.className || "").toString().toLowerCase();
          if (tag === "mat-icon" || cls.includes("material-icons") || cls.includes("mat-icon")) continue;
          text += getCleanText(child);
        }
      }
      return text.trim();
    };
  `;

  const steps = {};

  // Step 0: Close any dialog left open by a previous phase (e.g. the PDF
  // upload), so Step 1 opens a fresh Add-sources chooser rather than acting on
  // a stale one. Ignores the hidden 0×0 emoji-keyboard dialog.
  const staleOpen = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const dlgs = [
        ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
      ];
      return dlgs.some((d) => {
        const s = window.getComputedStyle(d);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = d.getBoundingClientRect();
        return r.width > 50 && r.height > 50;
      });
    },
  });
  if (staleOpen?.[0]?.result) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        ),
    });
    await sleep(600);
  }

  // Step 1: Click "Add sources" button
  const step1 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      const hasAny = (text, labels) =>
        labels.some((label) => text.includes(label));
      const addSourceLabels = [
        "add source",
        "add sources",
        "add a source",
        "添加来源",
        "添加源",
        "新增来源",
        "加入来源",
        "添加來源",
        "新增來源",
        "加入來源",
        "ソースを追加",
        "情報源を追加",
        "소스 추가",
        "출처 추가",
        "añadir fuente",
        "añadir fuentes",
        "agregar fuente",
        "agregar fuentes",
        "ajouter une source",
        "ajouter des sources",
        "quelle hinzufügen",
        "quellen hinzufügen",
        "adicionar fonte",
        "adicionar fontes",
        "aggiungi fonte",
        "aggiungi fonti",
        "bron toevoegen",
        "bronnen toevoegen",
        "tambahkan sumber",
      ];

      const candidates = document.querySelectorAll(
        'button, [role="button"], a, [tabindex="0"]',
      );
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (hasAny(clean, addSourceLabels) || hasAny(aria, addSourceLabels)) {
          el.click();
          return { success: true, clicked: clean || aria };
        }
      }
      const visible = Array.from(candidates)
        .filter((e) => {
          const s = window.getComputedStyle(e);
          return s.display !== "none" && s.visibility !== "hidden";
        })
        .map((e) => getCleanText(e))
        .filter((t) => t && t.length < 40)
        .slice(0, 10);
      return {
        success: false,
        error: "No Add sources button found. Visible: " + visible.join(", "),
      };
    },
  });
  steps.step1 = step1?.[0]?.result;
  if (!steps.step1?.success) return { ...steps.step1, steps };

  await sleep(2000);

  // Step 2: Click the "Website"/link option INSIDE the Add-sources dialog.
  // Critically scoped to the dialog: NotebookLM's left panel has its own
  // "Search the web" box with a "Web" control and a textarea — if we search
  // page-wide we paste URLs there instead of importing them as sources.
  const step2 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog)
        return { success: false, error: "Add-sources dialog not open" };

      // The dialog has TWO text areas: a "Search the web" box (always visible)
      // and the URL-paste box that only appears after clicking "Website". Only
      // treat the dialog as ready if a PASTE/LINK/URL field is present — never
      // the search box (else we'd type URLs into web-search).
      const pasteHints = [
        "paste",
        "link",
        "url",
        "粘贴",
        "貼上",
        "链接",
        "連結",
        "网址",
        "網址",
        "リンク",
        "링크",
        "enlace",
        "lien",
        "tautan",
      ];
      const searchHints = [
        "search",
        "搜索",
        "搜尋",
        "検索",
        "검색",
        "buscar",
        "rechercher",
        "suche",
        "pesquisar",
        "cerca",
        "zoek",
        "cari",
      ];
      const fieldLooksLikePaste = (f) => {
        const ph = (
          (f.getAttribute("placeholder") || "") +
          " " +
          (f.getAttribute("aria-label") || "")
        ).toLowerCase();
        if (searchHints.some((h) => ph.includes(h))) return false;
        return pasteHints.some((h) => ph.includes(h));
      };
      const hasPasteField = [
        ...dialog.querySelectorAll(
          "textarea, input[type='text'], input[type='url']",
        ),
      ].some((f) => {
        const s = window.getComputedStyle(f);
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          fieldLooksLikePaste(f)
        );
      });
      if (hasPasteField)
        return {
          success: true,
          clicked: "(url paste field already present)",
          method: "already-open",
        };

      const websiteLabels = [
        "website",
        "websites",
        "link",
        "links",
        "url",
        "urls",
        "网站",
        "网页",
        "链接",
        "網址",
        "網站",
        "網頁",
        "連結",
        "ウェブサイト",
        "リンク",
        "웹사이트",
        "링크",
        "sitio web",
        "sitios web",
        "enlace",
        "site web",
        "sites web",
        "lien",
        "webseite",
        "webseiten",
        "site",
        "sites",
        "sito web",
        "siti web",
        "website",
        "webpagina",
        "situs web",
        "tautan",
      ];
      // Only consider clickables INSIDE the dialog.
      const clickables = dialog.querySelectorAll(
        'button, [role="button"], [role="menuitem"], [role="option"], [tabindex="0"], a, mat-chip, [class*="chip"]',
      );
      for (const el of clickables) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        if (
          websiteLabels.includes(clean) &&
          (el.textContent || "").length < 100
        ) {
          el.click();
          return { success: true, clicked: clean, tag: el.tagName };
        }
      }
      // Fallback: contains a website/link label.
      for (const el of clickables) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const raw = (el.textContent || "").trim().toLowerCase();
        if (
          raw.length < 100 &&
          websiteLabels.some((label) => raw.includes(label))
        ) {
          el.click();
          return {
            success: true,
            clicked: raw.substring(0, 50),
            tag: el.tagName,
            method: "contains",
          };
        }
      }
      const visible = Array.from(clickables)
        .filter((e) => {
          const s = window.getComputedStyle(e);
          return s.display !== "none" && s.visibility !== "hidden";
        })
        .map((e) => getCleanText(e))
        .filter((t) => t && t.length < 40)
        .slice(0, 15);
      return {
        success: false,
        error: "No Website option in dialog. Visible: " + visible.join(", "),
      };
    },
  });
  steps.step2 = step2?.[0]?.result;
  if (!steps.step2?.success) return { ...steps.step2, steps };

  await sleep(2000);

  // Step 3: Paste all URLs into the textarea
  // The dialog shows a textarea with placeholder "Paste any links"
  // Multiple URLs can be separated by newlines
  const urlsText = urls.join("\n");
  const step3 = await chrome.scripting.executeScript({
    target: { tabId },
    args: [urlsText],
    func: (urlsText) => {
      const urlFieldLabels = [
        "paste",
        "link",
        "url",
        "粘贴",
        "貼上",
        "链接",
        "連結",
        "网址",
        "網址",
        "貼り付け",
        "リンク",
        "url",
        "붙여넣",
        "링크",
        "pegar",
        "enlace",
        "url",
        "coller",
        "lien",
        "einfügen",
        "link",
        "colar",
        "link",
        "incolla",
        "link",
        "plakken",
        "link",
        "tempel",
        "tautan",
      ];
      // Scope to the Add-sources dialog so we never type into the left-side
      // "Search the web" box (which has its own textarea).
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog)
        return {
          success: false,
          error: "Add-sources dialog not open (URL field step)",
        };

      const searchHints = [
        "search",
        "搜索",
        "搜尋",
        "検索",
        "검색",
        "buscar",
        "rechercher",
        "suche",
        "pesquisar",
        "cerca",
        "zoek",
        "cari",
      ];
      const fieldMeta = (f) =>
        (
          (f.getAttribute("placeholder") || "") +
          " " +
          (f.getAttribute("aria-label") || "")
        ).toLowerCase();
      const isSearchField = (f) =>
        searchHints.some((h) => fieldMeta(f).includes(h));
      const isVisible = (f) => {
        const s = window.getComputedStyle(f);
        return s.display !== "none" && s.visibility !== "hidden";
      };

      // Priority 1: field whose placeholder/aria looks like paste/link/url
      // (and NOT search), inside the dialog.
      let field = null;
      const allFieldsList = [
        ...dialog.querySelectorAll(
          "textarea, input[type='text'], input[type='url']",
        ),
      ];
      for (const f of allFieldsList) {
        if (!isVisible(f) || isSearchField(f)) continue;
        if (urlFieldLabels.some((label) => fieldMeta(f).includes(label))) {
          field = f;
          break;
        }
      }
      // Priority 2: any visible textarea that is NOT the search box.
      if (!field) {
        for (const ta of dialog.querySelectorAll("textarea")) {
          if (!isVisible(ta) || isSearchField(ta)) continue;
          field = ta;
          break;
        }
      }
      // Priority 3: any visible text/url input that is NOT the search box.
      if (!field) {
        for (const inp of dialog.querySelectorAll(
          'input[type="text"], input[type="url"]',
        )) {
          if (!isVisible(inp) || isSearchField(inp)) continue;
          field = inp;
          break;
        }
      }

      if (!field) {
        const allFields = Array.from(dialog.querySelectorAll("input, textarea"))
          .map(
            (i) => `${i.tagName}:${i.type || ""}:ph="${i.placeholder || ""}"`,
          )
          .slice(0, 8);
        return {
          success: false,
          error: "No URL field in dialog. Fields: " + allFields.join(", "),
        };
      }

      // Focus and set value
      field.focus();

      // Use native setter for Angular compatibility
      const setter =
        field.tagName === "TEXTAREA"
          ? Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              "value",
            )?.set
          : Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value",
            )?.set;

      if (setter) {
        setter.call(field, urlsText);
      } else {
        field.value = urlsText;
      }

      // Dispatch events for Angular/React change detection
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        success: true,
        placeholder: field.placeholder || "",
        tag: field.tagName,
        urlCount: urlsText.split("\n").length,
        valueSet: field.value.length > 0,
      };
    },
  });
  steps.step3 = step3?.[0]?.result;
  if (!steps.step3?.success) return { ...steps.step3, steps };

  await sleep(1500);

  // Step 4: Submit the URLs. NotebookLM's submit control may be a text button
  // ("Insert"/"Add") OR an icon-only round arrow button (→) next to the URL
  // field. We try text labels first, then arrow/send icons, then the enabled
  // button positioned nearest-right of the URL textarea.
  const step4 = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      const hasAny = (text, labels) =>
        labels.some((label) => text.includes(label));
      const isVisible = (el) => {
        const s = window.getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden";
      };
      const isDisabled = (el) =>
        el.disabled === true ||
        el.getAttribute("disabled") !== null ||
        el.getAttribute("aria-disabled") === "true";
      const insertLabels = [
        "insert",
        "submit",
        "add source",
        "add sources",
        "插入",
        "提交",
        "添加来源",
        "新增來源",
        "挿入",
        "追加",
        "삽입",
        "추가",
        "insertar",
        "añadir",
        "agregar",
        "insérer",
        "ajouter",
        "einfügen",
        "hinzufügen",
        "inserir",
        "adicionar",
        "inserisci",
        "aggiungi",
        "invoegen",
        "toevoegen",
        "masukkan",
        "tambahkan",
      ];
      // Material icon ligatures used for "submit/continue" arrows.
      const iconNames = [
        "arrow_forward",
        "arrow_upward",
        "arrow_right_alt",
        "send",
        "subdirectory_arrow_left",
        "keyboard_return",
        "north",
        "east",
      ];
      const iconText = (el) => {
        const mi = el.querySelector(
          "mat-icon, .material-icons, .material-icons-extended, .google-symbols, [class*='material-symbols']",
        );
        return (mi?.textContent || "").trim().toLowerCase();
      };

      // Scope to the Add-sources dialog so we don't click the left panel's
      // web-search arrow button.
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog)
        return {
          success: false,
          error: "Add-sources dialog not open (submit step)",
        };
      const allClickable = [
        ...dialog.querySelectorAll(
          "button, [role='button'], [tabindex='0'], a",
        ),
      ].filter(isVisible);

      // Pass 1: exact text match (e.g. "Insert").
      for (const el of allClickable) {
        if (isDisabled(el)) continue;
        const clean = getCleanText(el).trim().toLowerCase();
        if (insertLabels.includes(clean)) {
          el.click();
          return { success: true, clicked: clean, method: "text-exact" };
        }
      }
      // Pass 2: text/aria contains an insert label.
      for (const el of allClickable) {
        if (isDisabled(el)) continue;
        const clean = getCleanText(el).trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (
          (hasAny(clean, insertLabels) && clean.length < 30) ||
          hasAny(aria, insertLabels)
        ) {
          el.click();
          return {
            success: true,
            clicked: clean || aria,
            method: "text-contains",
          };
        }
      }
      // Pass 3: arrow/send icon, or aria-label referencing such an icon.
      for (const el of allClickable) {
        if (isDisabled(el)) continue;
        const icon = iconText(el);
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (
          iconNames.includes(icon) ||
          iconNames.some((n) => aria.includes(n.replace(/_/g, " ")))
        ) {
          el.click();
          return {
            success: true,
            clicked: icon || aria || "(icon)",
            method: "icon",
          };
        }
      }
      // Pass 4: proximity — the enabled icon-only button nearest to the RIGHT
      // of (and vertically aligned with) the URL paste field. Skip the
      // "Search the web" box so we don't click its arrow.
      const searchHints4 = [
        "search",
        "搜索",
        "搜尋",
        "検索",
        "검색",
        "buscar",
        "rechercher",
        "suche",
        "pesquisar",
        "cerca",
        "zoek",
        "cari",
      ];
      const isSearchField4 = (f) => {
        const m = (
          (f.getAttribute("placeholder") || "") +
          " " +
          (f.getAttribute("aria-label") || "")
        ).toLowerCase();
        return searchHints4.some((h) => m.includes(h));
      };
      let field = null;
      for (const ta of dialog.querySelectorAll(
        "textarea, input[type='text'], input[type='url']",
      )) {
        if (isVisible(ta) && !isSearchField4(ta)) {
          field = ta;
          break;
        }
      }
      if (field) {
        const fr = field.getBoundingClientRect();
        let best = null,
          bestDist = Infinity;
        for (const el of allClickable) {
          if (isDisabled(el)) continue;
          const txt = getCleanText(el).trim();
          if (txt.length > 3) continue; // submit affordance here is icon-only
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const verticallyNear =
            r.top < fr.bottom + 40 && r.bottom > fr.top - 40;
          const toRight = r.left >= fr.left; // same row, at/after the field
          if (!verticallyNear || !toRight) continue;
          const dist = Math.hypot(
            r.left - fr.right,
            r.top + r.height / 2 - (fr.top + fr.height / 2),
          );
          if (dist < bestDist) {
            bestDist = dist;
            best = el;
          }
        }
        if (best) {
          best.click();
          return {
            success: true,
            clicked: "(nearest-to-field)",
            method: "proximity",
          };
        }
      }

      // Debug: list visible clickable elements with their icon, if any.
      const visible = allClickable
        .map((e) => {
          const c = getCleanText(e).trim();
          const ic = iconText(e);
          const lbl =
            c ||
            (ic ? `[icon:${ic}]` : "") ||
            e.getAttribute("aria-label") ||
            "";
          return lbl && lbl.length < 50
            ? `${e.tagName}:"${lbl}"${isDisabled(e) ? "(disabled)" : ""}`
            : "";
        })
        .filter((t) => t.length > 0)
        .slice(0, 20);
      return {
        success: false,
        error:
          "No submit/Insert control found. Elements: " + visible.join(", "),
      };
    },
  });
  steps.step4 = step4?.[0]?.result;
  if (!steps.step4?.success) return { ...steps.step4, steps };

  // Verify the submit actually took: on success NotebookLM clears the URL
  // field / closes the dialog. If the URLs are still sitting in the field
  // after the wait, the submit did not register — report failure so the user
  // isn't told it worked when the URLs stayed in the box.
  const submitted = await waitForInTab(
    tabId,
    () => {
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      if (!dialog) return true; // dialog closed → submitted
      const fields = [
        ...dialog.querySelectorAll(
          "textarea, input[type='text'], input[type='url']",
        ),
      ].filter((f) => {
        const s = window.getComputedStyle(f);
        return s.display !== "none" && s.visibility !== "hidden";
      });
      if (fields.length === 0) return true; // field gone → submitted
      // Submitted only if every visible field is now empty.
      return fields.every((f) => !f.value || f.value.trim().length === 0);
    },
    { timeoutMs: 8000, intervalMs: 300 },
  );

  if (!submitted) {
    return {
      success: false,
      error:
        "URLs were entered but the submit button did not register (they stayed in the box).",
      steps,
    };
  }

  // Wait for NotebookLM to process
  await sleep(3000);

  // Close any remaining dialog by pressing Escape
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      );
    },
  });

  await sleep(500);

  return { ...steps.step4, steps };
}

/**
 * Uploads a batch of files into NotebookLM by constructing real File objects
 * from base64 data inside the page and dispatching a drop event on the drop zone.
 *
 * This approach works on both Chrome and Edge and avoids all CDP file path issues:
 * - DOM.setFileInputFiles requires native OS paths which fail silently on Windows
 * - Page.fileChooserOpened never fires because "Upload files" is a nav button, not a picker
 * - Drop events with a real DataTransfer populated from base64 bytes work reliably
 *
 * All files in `filesData` are dropped in a single open/drop/close cycle (one
 * DataTransfer with every file). This function only performs the drop and
 * returns whether the file input was set; the CALLER waits for NotebookLM to
 * finish ingesting the batch (and never re-drops it).
 */
async function injectFilesBatchViaCDP(tabId, filesData) {
  if (!filesData?.length) {
    return { success: false, error: "No files provided" };
  }

  // Step 0: If a prior dialog is still open (stale from a previous iteration),
  // close it first so we start from a clean state. Without this, Step 1's
  // "already-open" branch may use a stale dialog whose buttons have since
  // been torn down, causing the upload-button query to miss.
  const stalePresent = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
      // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
      // not grab the first match — choose the largest visible one.
      const dialog = (() => {
        const all = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        const visible = all.filter((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(),
            rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return visible[0] || null;
      })();
      return !!dialog;
    },
  });
  if (stalePresent?.[0]?.result) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        ),
    });
    await waitForInTab(
      tabId,
      () => {
        // Consider only visible dialogs — a stray 0×0 emoji-keyboard dialog
        // may linger in the DOM and would otherwise never "close".
        const dlgs = [
          ...document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
        ];
        return !dlgs.some((d) => {
          const s = window.getComputedStyle(d);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = d.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
      },
      { timeoutMs: 3000, intervalMs: 150 },
    );
  }

  // Step 1: Ensure "Add sources" dialog is open. Poll up to 8s.
  const dialogOpened = await waitForInTab(
    tabId,
    () => {
      const getCleanText = (el) => {
        let t = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) t += c.textContent;
          else if (c.nodeType === 1) {
            const tag = c.tagName?.toLowerCase() || "";
            const cls = (c.className || "").toString().toLowerCase();
            if (
              tag === "mat-icon" ||
              cls.includes("material-icons") ||
              cls.includes("mat-icon")
            )
              continue;
            t += getCleanText(c);
          }
        }
        return t.trim();
      };
      const hasAny = (text, labels) =>
        labels.some((label) => text.includes(label));
      const addSourceLabels = [
        "add source",
        "add sources",
        "add a source",
        "添加来源",
        "添加源",
        "新增来源",
        "加入来源",
        "添加來源",
        "新增來源",
        "加入來源",
        "ソースを追加",
        "情報源を追加",
        "소스 추가",
        "출처 추가",
        "añadir fuente",
        "añadir fuentes",
        "agregar fuente",
        "agregar fuentes",
        "ajouter une source",
        "ajouter des sources",
        "quelle hinzufügen",
        "quellen hinzufügen",
        "adicionar fonte",
        "adicionar fontes",
        "aggiungi fonte",
        "aggiungi fonti",
        "bron toevoegen",
        "bronnen toevoegen",
        "tambahkan sumber",
      ];
      const body = document.body.textContent || "";
      if (
        /drop your files|upload files|drag.*files|拖放文件|拖拽文件|上传文件|上傳檔案|上傳文件|ファイルをアップロード|파일 업로드|subir archivos|téléverser|dateien hochladen|carregar arquivos|carica file|bestanden uploaden|unggah file/i.test(
          body,
        )
      ) {
        return { success: true, method: "already-open" };
      }
      const candidates = document.querySelectorAll(
        'button, [role="button"], a, [tabindex="0"]',
      );
      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clean = getCleanText(el).toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (hasAny(clean, addSourceLabels) || hasAny(aria, addSourceLabels)) {
          el.click();
          return { success: true, method: "clicked" };
        }
      }
      return null;
    },
    { timeoutMs: 8000, intervalMs: 300 },
  );

  if (!dialogOpened?.success) {
    return { success: false, error: "Could not open Add sources dialog" };
  }

  if (dialogOpened.method !== "already-open") {
    const ready = await waitForInTab(
      tabId,
      () =>
        /drop your files|upload files|drag.*files|拖放文件|拖拽文件|上传文件|上傳檔案|上傳文件|ファイルをアップロード|파일 업로드|subir archivos|téléverser|dateien hochladen|carregar arquivos|carica file|bestanden uploaden|unggah file/i.test(
          document.body.textContent || "",
        ),
      { timeoutMs: 5000, intervalMs: 100 },
    );
    if (!ready)
      return { success: false, error: "Upload dialog did not appear" };
  }

  // Step 2: Find the "Upload files" button coordinates and use a trusted CDP
  // mouse click to open the file sub-panel. A scripted .click() doesn't create
  // a user activation, but CDP Input.dispatchMouseEvent does — this allows the
  // file chooser to open, which we then intercept.
  //
  // The lookup runs in-page and returns coords only once the button is VISIBLE
  // with a non-zero rect. We poll it (via waitForInTab) so a dialog that hasn't
  // finished rendering doesn't cause a "button not found" miss, and we re-run it
  // before every click attempt below in case the dialog reflowed.
  const findUploadBtn = () => {
    const getCleanText = (el) => {
      let t = "";
      for (const c of el.childNodes) {
        if (c.nodeType === 3) t += c.textContent;
        else if (c.nodeType === 1) {
          const tag = c.tagName?.toLowerCase() || "";
          const cls = (c.className || "").toString().toLowerCase();
          if (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          )
            continue;
          t += getCleanText(c);
        }
      }
      return t.trim();
    };
    const hasAny = (text, labels) =>
      labels.some((label) => text.includes(label));
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const coordsOf = (el, clean) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: clean,
      };
    };
    const uploadLabels = [
      "upload files",
      "upload file",
      "upload",
      "上传文件",
      "上传",
      "上傳檔案",
      "上傳文件",
      "上傳",
      "ファイルをアップロード",
      "アップロード",
      "파일 업로드",
      "업로드",
      "subir archivos",
      "subir archivo",
      "subir",
      "téléverser des fichiers",
      "téléverser",
      "importer des fichiers",
      "dateien hochladen",
      "datei hochladen",
      "hochladen",
      "carregar arquivos",
      "carregar ficheiros",
      "carregar",
      "carica file",
      "carica",
      "bestanden uploaden",
      "uploaden",
      "unggah file",
      "unggah",
    ];
    const all = document.querySelectorAll(
      'button, [role="button"], [tabindex="0"], a, label, div, span',
    );
    for (const el of all) {
      if (!isVisible(el)) continue;
      const clean = getCleanText(el).toLowerCase();
      if (uploadLabels.includes(clean)) return coordsOf(el, clean);
    }
    // Loose fallback
    for (const el of all) {
      if (!isVisible(el)) continue;
      const clean = getCleanText(el).toLowerCase();
      if (hasAny(clean, uploadLabels) && clean.length < 40)
        return coordsOf(el, clean);
    }
    return null;
  };

  const btnCoords = await waitForInTab(tabId, findUploadBtn, {
    timeoutMs: 5000,
    intervalMs: 150,
  });
  if (!btnCoords) {
    return { success: false, error: "Upload files button not found in dialog" };
  }

  // Enable file chooser interception before the trusted click
  let interceptionEnabled = false;
  let listenerAttached = false;
  let onEvent = null;

  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    await chrome.debugger.sendCommand(
      { tabId },
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
    );
    interceptionEnabled = true;

    // A single listener routes every Page.fileChooserOpened to whichever click
    // attempt is currently waiting. Re-armed per attempt via `chooserResolve`.
    let chooserResolve = null;
    onEvent = (source, method, params) => {
      if (
        source.tabId === tabId &&
        method === "Page.fileChooserOpened" &&
        chooserResolve
      ) {
        const r = chooserResolve;
        chooserResolve = null;
        r(params);
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    listenerAttached = true;

    // Step 3-4: Fire a trusted CDP click and wait for the file chooser. The
    // click can transiently miss (button not yet hit-testable), so retry with a
    // short per-attempt timeout, re-reading fresh coords each time in case the
    // dialog reflowed. A user activation only comes from CDP Input events, not a
    // scripted .click(), so this trusted dispatch is required to open the chooser.
    let chooserEvent = null;
    let lastBtnText = btnCoords.text;
    for (let attempt = 1; attempt <= UPLOAD_CLICK_ATTEMPTS; attempt++) {
      // Re-read coords on retries; the first attempt reuses the coords we already
      // polled for above.
      const coords =
        attempt === 1
          ? btnCoords
          : await waitForInTab(tabId, findUploadBtn, {
              timeoutMs: 2000,
              intervalMs: 150,
            });
      if (!coords) continue;
      lastBtnText = coords.text;

      let resolveChooser;
      const chooserPromise = new Promise((r) => {
        resolveChooser = r;
      });
      const chooserTimeout = setTimeout(
        () => resolveChooser(null),
        CHOOSER_ATTEMPT_TIMEOUT_MS,
      );
      chooserResolve = resolveChooser;

      const x = Math.round(coords.x);
      const y = Math.round(coords.y);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });

      chooserEvent = await chooserPromise;
      clearTimeout(chooserTimeout);
      chooserResolve = null;
      if (chooserEvent) break;
      console.log(
        `[n2z] upload-click attempt ${attempt}/${UPLOAD_CLICK_ATTEMPTS} missed; retrying`,
      );
    }

    if (!chooserEvent) {
      return {
        success: false,
        error: `Trusted click on "${lastBtnText}" did not open file chooser`,
      };
    }

    // Step 5: Set ALL files in this batch via a single DataTransfer. NotebookLM's
    // file input accepts multiple files at once, so one open/drop/close cycle
    // ingests the whole batch. Bytes are built from base64 in-page (avoids the
    // Windows native-path issues of DOM.setFileInputFiles).
    const filesPayload = JSON.stringify(
      filesData.map((f) => ({
        base64: f.base64,
        filename: f.filename,
        type: f.contentType || "application/pdf",
      })),
    );
    const setResult = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: `
        (async () => {
          try {
            const files = ${filesPayload};
            const dt = new DataTransfer();
            for (const f of files) {
              const bin = atob(f.base64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              dt.items.add(new File([bytes], f.filename, { type: f.type }));
            }
            // Find the file input that was just opened
            const inp = document.querySelector('input[type="file"]');
            if (!inp) return { ok: false, reason: 'no-input' };
            Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            return { ok: true, files: dt.files.length };
          } catch(e) { return { ok: false, reason: e.message }; }
        })()
      `,
        returnByValue: true,
        awaitPromise: true,
      },
    );

    const setInfo = setResult?.result?.value;
    if (!setInfo?.ok) {
      return {
        success: false,
        error: `Could not set files on input: ${setInfo?.reason}`,
      };
    }

    // Step 6: Close the dialog, then wait for it to actually disappear.
    // A short settle lets the input's change handler start the upload before
    // we Escape, so a fast close can't cancel an in-flight upload. The caller
    // then waits for the batch to finish ingesting.
    await sleep(300);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        ),
    });
    await waitForInTab(
      tabId,
      () => {
        // Prefer the dialog element — body text can match "upload files" in
        // toasts or the sources list after upload completes.
        // Pick the real, VISIBLE Add-sources dialog. NotebookLM may keep a stray
        // hidden emoji-keyboard dialog ([role=dialog], 0×0) in the DOM, so we must
        // not grab the first match — choose the largest visible one.
        const dialog = (() => {
          const all = [
            ...document.querySelectorAll(
              'mat-dialog-container, [role="dialog"]',
            ),
          ];
          const visible = all.filter((d) => {
            const s = window.getComputedStyle(d);
            if (s.display === "none" || s.visibility === "hidden") return false;
            const r = d.getBoundingClientRect();
            return r.width > 50 && r.height > 50;
          });
          visible.sort((a, b) => {
            const ra = a.getBoundingClientRect(),
              rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
          });
          return visible[0] || null;
        })();
        if (dialog) return false;
        return !/drop your files|upload files|drag.*files|拖放文件|拖拽文件|上传文件|上傳檔案|上傳文件|ファイルをアップロード|파일 업로드|subir archivos|téléverser|dateien hochladen|carregar arquivos|carica file|bestanden uploaden|unggah file/i.test(
          document.body.textContent || "",
        );
      },
      { timeoutMs: 10000, intervalMs: 200 },
    );

    return { success: true, count: filesData.length };
  } catch (e) {
    return { success: false, error: `File inject: ${e.message}` };
  } finally {
    if (listenerAttached && onEvent) {
      try {
        chrome.debugger.onEvent.removeListener(onEvent);
      } catch {}
    }
    if (interceptionEnabled) {
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          "Page.setInterceptFileChooserDialog",
          { enabled: false },
        );
      } catch {}
    }
  }
}

async function cdpEval(tabId, expression) {
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
  );
  return result?.result?.value;
}

// ─── Backward Sync: Note Extraction ─────────────────────────────────

/**
 * Extracts notes from NotebookLM using scripting API.
 * Step 1: Find all note cards in the right panel.
 * Step 2: Click each card to open it and scrape the full content.
 */
// Ensures the "Studio" tab/panel (which holds the saved notes) is visible.
// On narrow/vertical monitors the 3-column layout collapses and Studio becomes
// a tab that must be clicked first. Idempotent — if the note cards are already
// present it does nothing. Injected into the page; must be self-contained.
function ensureStudioVisibleFn() {
  const isIconElement = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName?.toLowerCase() || "";
    const cls = (el.className || "").toString().toLowerCase();
    return (
      tag === "mat-icon" ||
      cls.includes("material-icons") ||
      cls.includes("mat-icon")
    );
  };
  const getCleanText = (node) => {
    let result = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
        if (isIconElement(child)) continue;
        result += getCleanText(child);
      }
    }
    return result;
  };
  // Already showing note cards / the Studio panel? Nothing to do.
  if (document.querySelector(".artifact-title, [class*='artifact-title']"))
    return true;

  // Look for a tab/button labeled "Studio" / localized equivalent and open it.
  const clickables = document.querySelectorAll(
    '[role="tab"], button, [role="button"], a, [class*="tab"]',
  );
  const studioLabels = [
    "studio",
    "工作室",
    "工作區",
    "スタジオ",
    "스튜디오",
    "estudio",
    "atelier",
    "labor",
    "estúdio",
  ];
  for (const el of clickables) {
    const text = getCleanText(el).trim().toLowerCase();
    if (studioLabels.includes(text)) {
      el.click();
      return true;
    }
  }
  return false;
}

async function extractNotesFromTab(tabId) {
  // Step 0: Ensure the Studio panel (which holds the note cards) is visible
  // before scanning. In the collapsed/tab layout Studio is a tab that must be
  // clicked, and Angular may take a moment to render the note cards — so we
  // click Studio and poll until `.artifact-title` cards appear (up to ~4s).
  for (let attempt = 0; attempt < 8; attempt++) {
    const ready = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        !!document.querySelector(".artifact-title, [class*='artifact-title']"),
    });
    if (ready?.[0]?.result) break;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: ensureStudioVisibleFn,
    });
    await sleep(500);
  }

  // Step 1: Scan for note card titles (just collect metadata, no tagging)
  const scanResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const isIconElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const cls = (el.className || "").toString().toLowerCase();
        const tag = el.tagName?.toLowerCase() || "";
        return (
          tag === "mat-icon" ||
          cls.includes("material-icons") ||
          cls.includes("mat-icon")
        );
      };
      const getCleanText = (node) => {
        let result = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
              continue;
            if (isIconElement(child)) continue;
            result += getCleanText(child);
          }
        }
        return result;
      };

      const normalize = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();
      const relativeTimeRe =
        /(\d+\s*[mhd]\s*ago|\d+\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(分钟|小時|小时|天|日|周|週|星期|个月|個月|月|年)前|\d+\s*(分|時間|日|週間|か月|ヶ月|年)前|\d+\s*(분|시간|일|주|개월|년)\s*전|hace\s+\d+\s*(min|hora|horas|día|dias|días|semana|mes|año|años)|il y a\s+\d+\s*(min|heure|heures|jour|jours|semaine|mois|an|ans)|vor\s+\d+\s*(min|minute|stunden?|tage?|wochen?|monate?|jahre?)|昨天|前天|昨日|一昨日|어제)/i;

      // Generator tiles (Slide Deck, Mind Map, Quiz, Reports, Audio/Video
      // Overview, Flashcards, Infographic, Data Table) describe themselves with a
      // "Generate …" tooltip. Saved text notes never do. We use this as a guard so
      // a tile can never be picked even if it ever borrows the note CSS class.
      const generatorRe =
        /^(generate |创建|新增|生成|작성|générer |erstellen |criar |crear |genera )/i;

      // Resolve the full, untruncated title for an artifact title element. The
      // visible <span> text is ellipsized; the complete title lives in the cdk
      // tooltip referenced by aria-describedby. Fall back to visible text.
      const fullTitleFor = (titleEl) => {
        const adId = (titleEl.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .filter(Boolean)[0];
        if (adId) {
          const tip = document.getElementById(adId);
          const tipText = (tip?.textContent || "").trim();
          if (tipText) return tipText;
        }
        return getCleanText(titleEl).trim();
      };

      // PRIMARY STRATEGY — structural anchor.
      // Saved text notes render their title as `span.artifact-title`, which is a
      // tooltip trigger inside a `.artifact-item-button` card. This class is used
      // ONLY by saved notes (not by the Studio generator tiles) and exists in both
      // the collapsed/tab layout and the expanded three-column layout, so it is a
      // reliable, language-independent anchor.
      const foundNotes = [];
      const seenTitles = [];
      const titleEls = document.querySelectorAll(
        ".artifact-title, [class*='artifact-title']",
      );
      for (const titleEl of titleEls) {
        const title = fullTitleFor(titleEl).replace(/\s+/g, " ").trim();
        if (!title || title.length < 3) continue;
        if (generatorRe.test(title)) continue; // never a generator tile

        const normTitle = normalize(title);
        if (seenTitles.some((s) => s === normTitle)) continue;
        seenTitles.push(normTitle);

        // Pull the timestamp from the surrounding card, if present (best-effort).
        const card =
          titleEl.closest(".artifact-item-button") || titleEl.parentElement;
        const cardText = card ? getCleanText(card).trim() : "";
        const tsMatch = cardText.match(relativeTimeRe);

        foundNotes.push({
          title: title.substring(0, 200),
          type: "saved-note",
          timestamp: tsMatch ? tsMatch[0] : "",
        });
      }

      if (foundNotes.length > 0) return foundNotes;

      // FALLBACK STRATEGY — legacy timestamp heuristic.
      // Kept for older NotebookLM layouts that predate the artifact-* markup.
      const allElements = document.querySelectorAll(
        "*:not(style):not(script):not(link):not(meta):not(head)",
      );
      const seenCards = new Set();

      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;

        const rawText = el.textContent?.trim() || "";
        if (
          rawText.length > 2000 ||
          rawText.length < 8 ||
          el.children.length > 20
        )
          continue;
        if (!relativeTimeRe.test(rawText)) continue;

        let card = el;
        for (let i = 0; i < 3; i++) {
          if (!card.parentElement) break;
          if (card.parentElement.children.length > 5) break;
          if (
            card.parentElement.tagName === "MAIN" ||
            card.parentElement.tagName === "BODY"
          )
            break;
          card = card.parentElement;
        }

        if (seenCards.has(card)) continue;
        seenCards.add(card);

        const cleanText = getCleanText(card).trim();
        if (cleanText.length < 8 || /\{[^}]*:[^}]*\}/.test(cleanText)) continue;

        const lines = cleanText
          .split(/\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        let title = "";
        let noteType = "saved-note";
        const typePattern =
          /^(Explainer|Deep Dive|Study Guide|Briefing|FAQ|Timeline|Outline|Report|Audio Overview|New Note|说明|深度解析|学习指南|简报|常见问题|时间轴|大纲|报告|音频概览|新笔记)$/i;

        for (const line of lines) {
          if (line.length <= 2) continue;
          if (relativeTimeRe.test(line)) continue;
          if (/^(\d+\s*sources?|\d+\s*个?来源|\d+\s*個?來源)$/i.test(line))
            continue;
          if (/^[·•\-–—\s]+$/.test(line)) continue;
          if (typePattern.test(line)) {
            noteType = line;
            continue;
          }
          if (!title) title = line;
        }

        if (!title || title.length < 3) continue;

        // Clean trailing junk from title: timestamps, "Add note", other note names
        title = title
          .replace(
            /\s*(\d+\s*[mhd]\s*ago|\d+\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(分钟|小時|小时|天|日|周|週|星期|个月|個月|月|年)前|\d+\s*(分|時間|日|週間|か月|ヶ月|年)前|\d+\s*(분|시간|일|주|개월|년)\s*전|hace\s+\d+\s*(min|hora|horas|día|dias|días|semana|mes|año|años)|il y a\s+\d+\s*(min|heure|heures|jour|jours|semaine|mois|an|ans)|vor\s+\d+\s*(min|minute|stunden?|tage?|wochen?|monate?|jahre?)|昨天|前天|昨日|一昨日|어제).*/i,
            "",
          ) // timestamp and everything after
          .replace(/\s*(Add\s+note|添加笔记).*/i, "") // "Add note" and everything after
          .replace(/\s*(\d+\s*sources?|\d+\s*个?来源|\d+\s*個?來源).*/i, "") // source count and everything after
          .trim();

        if (!title || title.length < 3) continue;
        const lower = title.toLowerCase();
        if (
          /^(sources?|chat|studio|notes?|settings?|share|help|add\s|create\s|来源|聊天|工作室|笔记|设置|分享|帮助|添加|创建)$/i.test(
            lower,
          )
        )
          continue;

        // Early dedup: skip if we already found a note with this title
        const normTitle = normalize(title);
        if (
          seenTitles.some(
            (s) =>
              s === normTitle ||
              normTitle.startsWith(s) ||
              s.startsWith(normTitle),
          )
        )
          continue;
        seenTitles.push(normTitle);

        if (noteType === "saved-note") {
          const m = cleanText.match(
            /(Explainer|Deep Dive|Study Guide|Briefing|FAQ|Timeline|Outline|Report|Audio Overview|说明|深度解析|学习指南|简报|常见问题|时间轴|大纲|报告|音频概览)/i,
          );
          if (m) noteType = m[1];
        }

        const lt = noteType.toLowerCase();
        if (
          lt.includes("audio") ||
          lt.includes("deep dive") ||
          lt.includes("音频") ||
          lt.includes("深度解析")
        )
          continue;

        const tsMatch = cleanText.match(relativeTimeRe);

        foundNotes.push({
          title: title.substring(0, 200),
          type: noteType.toLowerCase().replace(/\s+/g, "-"),
          timestamp: tsMatch ? tsMatch[0] : "",
        });
      }

      // Final dedup safety net (early dedup above should catch most)
      const seen = [];
      return foundNotes.filter((n) => {
        const norm = normalize(n.title);
        const isDup = seen.some(
          (s) => s === norm || norm.startsWith(s) || s.startsWith(norm),
        );
        if (isDup) return false;
        seen.push(norm);
        return true;
      });
    },
  });

  const noteCards = scanResult?.[0]?.result || [];
  if (noteCards.length === 0) {
    return [];
  }

  // Step 2: For each note, re-find its card in the DOM (by title),
  // click it, scrape content, then navigate back.
  // We re-find each time because Angular re-renders the DOM on back-navigation.
  const notes = [];
  const urlBefore = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.location.href,
  });
  const baseUrl = urlBefore?.[0]?.result || "";

  for (const card of noteCards) {
    // In the collapsed/tab layout, back-navigation may land on Chat/Sources, so
    // re-show the Studio panel and wait for the note cards before re-finding.
    for (let attempt = 0; attempt < 8; attempt++) {
      const ready = await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
          !!document.querySelector(
            ".artifact-title, [class*='artifact-title']",
          ),
      });
      if (ready?.[0]?.result) break;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: ensureStudioVisibleFn,
      });
      await sleep(500);
    }

    // Re-find and click the card by matching its title in the current DOM
    const clickResult = await chrome.scripting.executeScript({
      target: { tabId },
      args: [card.title],
      func: (targetTitle) => {
        const isIconElement = (el) => {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = el.tagName?.toLowerCase() || "";
          const cls = (el.className || "").toString().toLowerCase();
          return (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          );
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
                continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };

        // Resolve the full title for an artifact title element (tooltip first).
        const fullTitleFor = (titleEl) => {
          const adId = (titleEl.getAttribute("aria-describedby") || "")
            .split(/\s+/)
            .filter(Boolean)[0];
          if (adId) {
            const tip = document.getElementById(adId);
            const tipText = (tip?.textContent || "").trim();
            if (tipText) return tipText;
          }
          return getCleanText(titleEl).trim();
        };
        const generatorRe =
          /^(generate |创建|新增|生成|작성|générer |erstellen |criar |crear |genera )/i;
        const norm = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
        const wantNorm = norm(targetTitle);

        let card = null;
        let artifactBtn = null;

        // PRIMARY: match a saved-note card via its `.artifact-title` anchor.
        // This guarantees we never click a Studio generator tile (Slide Deck,
        // Mind Map, etc.) — those do not use `.artifact-title` and, defensively,
        // carry a "Generate …" tooltip we exclude. Works collapsed or expanded.
        const titleEls = document.querySelectorAll(
          ".artifact-title, [class*='artifact-title']",
        );
        for (const titleEl of titleEls) {
          const full = fullTitleFor(titleEl);
          if (!full || generatorRe.test(full)) continue;
          const n = norm(full);
          if (
            n === wantNorm ||
            n.startsWith(wantNorm) ||
            wantNorm.startsWith(n)
          ) {
            card =
              titleEl.closest("artifact-library-note") ||
              titleEl.closest(".artifact-item-button") ||
              titleEl.parentElement;
            // The element that actually opens the note is the full-width
            // `.artifact-stretched-button` (a real <button>). Its sibling
            // `.artifact-actions` button is the 3-dot overflow menu — avoid it.
            artifactBtn =
              (card && card.querySelector(".artifact-stretched-button")) ||
              titleEl
                .closest(".artifact-button-content")
                ?.querySelector(".artifact-stretched-button") ||
              null;
            break;
          }
        }

        // If we found the dedicated open-button, click it natively and return.
        if (artifactBtn) {
          const rect = artifactBtn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            artifactBtn.focus?.();
            artifactBtn.click();
            return { success: true, method: "artifact-stretched-button" };
          }
        }

        // FALLBACK: legacy text + timestamp heuristic for older layouts.
        if (!card) {
          const allElements = document.querySelectorAll(
            "*:not(style):not(script):not(link):not(meta):not(head)",
          );
          let bestCard = null;
          let bestSize = Infinity;
          const relativeTimeRe =
            /(\d+\s*[mhd]\s*ago|\d+\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(分钟|小時|小时|天|日|周|週|星期|个月|個月|月|年)前|\d+\s*(分|時間|日|週間|か月|ヶ月|年)前|\d+\s*(분|시간|일|주|개월|년)\s*전|hace\s+\d+\s*(min|hora|horas|día|dias|días|semana|mes|año|años)|il y a\s+\d+\s*(min|heure|heures|jour|jours|semaine|mois|an|ans)|vor\s+\d+\s*(min|minute|stunden?|tage?|wochen?|monate?|jahre?)|昨天|前天|昨日|一昨日|어제)/i;

          for (const el of allElements) {
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              continue;
            const rawText = el.textContent?.trim() || "";
            if (rawText.length > 2000 || rawText.length < 8) continue;
            // Must contain the title and a timestamp pattern (card indicator)
            if (
              !rawText.includes(targetTitle.substring(0, 30)) ||
              !relativeTimeRe.test(rawText)
            )
              continue;

            // Prefer the smallest element that contains the full title
            // (most specific = the actual card, not a parent container)
            if (rawText.length < bestSize) {
              bestSize = rawText.length;
              bestCard = el;
            }
          }

          if (!bestCard)
            return { success: false, error: "card-not-found-by-title" };

          // Walk up a bit to get the actual card container
          card = bestCard;
          for (let i = 0; i < 3; i++) {
            if (!card.parentElement) break;
            if (card.parentElement.children.length > 5) break;
            if (
              card.parentElement.tagName === "MAIN" ||
              card.parentElement.tagName === "BODY"
            )
              break;
            card = card.parentElement;
          }
        }

        // Click strategy 0: if we matched an artifact card, click it directly.
        // Clicking the card itself (rather than searching its descendants) avoids
        // accidentally hitting the note's overflow (3-dot) menu button.
        if (card.classList && card.classList.contains("artifact-item-button")) {
          const rect = card.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const opts = {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              button: 0,
            };
            card.dispatchEvent(new PointerEvent("pointerdown", opts));
            card.dispatchEvent(new MouseEvent("mousedown", opts));
            card.dispatchEvent(new PointerEvent("pointerup", opts));
            card.dispatchEvent(new MouseEvent("mouseup", opts));
            card.dispatchEvent(new MouseEvent("click", opts));
            card.click?.();
            return { success: true, method: "artifact-card-click" };
          }
        }

        // Click strategy 1: Find <a> inside card
        const anchors = card.querySelectorAll("a");
        for (const a of anchors) {
          const rect = a.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            a.click();
            return { success: true, method: "anchor-click" };
          }
        }

        // Click strategy 2: Interactive child
        const interactives = card.querySelectorAll(
          'button, [role="button"], [role="link"], [tabindex="0"]',
        );
        for (const btn of interactives) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return { success: true, method: "interactive-child" };
          }
        }

        // Click strategy 3: Full mouse event sequence
        const rect = card.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
        };
        card.dispatchEvent(new PointerEvent("pointerdown", opts));
        card.dispatchEvent(new MouseEvent("mousedown", opts));
        card.dispatchEvent(new PointerEvent("pointerup", opts));
        card.dispatchEvent(new MouseEvent("mouseup", opts));
        card.dispatchEvent(new MouseEvent("click", opts));
        return { success: true, method: "mouse-event-sequence" };
      },
    });

    if (!clickResult?.[0]?.result?.success) {
      let hash = 0;
      for (let i = 0; i < card.title.length; i++) {
        hash = (hash << 5) - hash + card.title.charCodeAt(i);
        hash |= 0;
      }
      notes.push({
        id: "note-" + Math.abs(hash).toString(36),
        title: card.title,
        content: "",
        type: card.type,
        timestamp: card.timestamp || new Date().toISOString(),
        _method:
          "click-failed:" + (clickResult?.[0]?.result?.error || "unknown"),
      });
      continue;
    }

    // Wait for the detail view — poll frequently (up to ~4s) for signals.
    // The note editor (.ProseMirror) appearing is the fastest, most direct
    // signal; banner/convert/breadcrumb/url-change are backups.
    let detailOpened = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(400);
      const check = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyText = document.body.textContent || "";
          // The open note renders as a `labs-tailwind-doc-viewer` in the Studio
          // panel (not inside chat-panel). Its presence on-screen is the most
          // direct "note opened" signal.
          const vh =
            window.innerHeight || document.documentElement.clientHeight;
          const editorEls = [
            ...document.querySelectorAll(
              "labs-tailwind-doc-viewer, note-editor .ProseMirror, .ProseMirror, rich-text-editor.note-editor",
            ),
          ];
          const editorVisible = editorEls.some((el) => {
            if (el.closest("chat-panel")) return false;
            const r = el.getBoundingClientRect();
            return r.height > 30 && r.bottom > 0 && r.top < vh;
          });
          return {
            hasEditor: !!editorVisible,
            hasBanner:
              /saved\s+(responses?|notes?)\s+are\s+(view|read)|已保存.*(只读|查看)|已儲存.*(唯讀|查看)|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt|somente leitura|sola lettura|alleen-lezen/i.test(
                bodyText,
              ),
            hasBreadcrumb:
              /(Studio|工作室|工作區|スタジオ|스튜디오|Estudio|Atelier|Labor|Estúdio)\s*[>›»]\s/i.test(
                bodyText,
              ),
            hasConvertBtn:
              /convert to source|转换为来源|轉換為來源|ソースに変換|소스로 변환|convertir en fuente|convertir en source|in quelle umwandeln|converter em fonte|converti in fonte/i.test(
                bodyText,
              ),
            url: window.location.href,
          };
        },
      });
      const st = check?.[0]?.result || {};
      if (
        st.hasEditor ||
        st.hasBanner ||
        st.hasBreadcrumb ||
        st.hasConvertBtn ||
        st.url !== baseUrl
      ) {
        detailOpened = true;
        break;
      }
    }

    // Scrape the opened note content using multiple strategies
    const contentResult = await chrome.scripting.executeScript({
      target: { tabId },
      args: [card.title, detailOpened],
      func: (noteTitle, detailOpened) => {
        const isIconElement = (el) => {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = el.tagName?.toLowerCase() || "";
          const cls = (el.className || "").toString().toLowerCase();
          return (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          );
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
                continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };
        // Replace NotebookLM inline citation chips with readable "(N)" markers.
        // Each citation is `<button class="xap-inline-dialog"><span>N</span></button>`
        // (the span's aria-label holds the full source). When several citations
        // are adjacent they are merged into one "(20,21)". Operates on a clone so
        // the live page is untouched. Plain-text years are never inside these
        // buttons, so they are left alone — this is robust where regex is not.
        const normalizeCitations = (clone) => {
          const buttons = Array.from(
            clone.querySelectorAll(
              "button.xap-inline-dialog, button[class*='xap-inline-dialog']",
            ),
          );
          const visited = new Set();
          for (const btn of buttons) {
            if (visited.has(btn)) continue;
            // Gather this citation plus any immediately-adjacent citation buttons
            // (ignoring whitespace-only text nodes between them).
            const group = [btn];
            visited.add(btn);
            let sib = btn.nextSibling;
            while (sib) {
              if (sib.nodeType === Node.TEXT_NODE && !sib.textContent.trim()) {
                sib = sib.nextSibling;
                continue;
              }
              if (
                sib.nodeType === Node.ELEMENT_NODE &&
                sib.matches?.(
                  "button.xap-inline-dialog, button[class*='xap-inline-dialog']",
                )
              ) {
                group.push(sib);
                visited.add(sib);
                sib = sib.nextSibling;
                continue;
              }
              break;
            }
            const nums = group
              .map((b) => (b.textContent || "").trim())
              .filter((t) => /^\d{1,4}$/.test(t));
            // Add a leading space so citations don't fuse onto the preceding word
            // ("signaling" -> "signaling (20,21)"), but skip it if the text before
            // already ends in whitespace to avoid a double space.
            const prev = btn.previousSibling;
            const prevEndsWS =
              prev &&
              prev.nodeType === Node.TEXT_NODE &&
              /\s$/.test(prev.textContent || "");
            const lead = prevEndsWS ? "" : " ";
            const replacement = document.createTextNode(
              nums.length ? `${lead}(${nums.join(",")})` : "",
            );
            btn.parentNode.insertBefore(replacement, btn);
            for (const b of group) b.remove();
          }
        };
        const getCleanHtml = (node) => {
          const clone = node.cloneNode(true);
          clone
            .querySelectorAll("style, script, mat-icon, .material-icons")
            .forEach((s) => s.remove());
          normalizeCitations(clone);
          return clone.innerHTML;
        };
        // Text variant that also normalizes citations (clones first).
        const getCleanTextWithCitations = (node) => {
          const clone = node.cloneNode(true);
          clone
            .querySelectorAll("style, script, mat-icon, .material-icons")
            .forEach((s) => s.remove());
          normalizeCitations(clone);
          return getCleanText(clone);
        };
        const isChrome = (text) => {
          if (
            /convert to source|转换为来源|轉換為來源|ソースに変換|소스로 변환|convertir en fuente|convertir en source|in quelle umwandeln|converter em fonte|converti in fonte/i.test(
              text,
            ) &&
            text.length < 80
          )
            return true;
          if (
            /saved\s+(responses?|notes?)\s+are|已保存.*(只读|查看)|已儲存.*(唯讀|查看)|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt|somente leitura|sola lettura|alleen-lezen/i.test(
              text,
            ) &&
            text.length < 80
          )
            return true;
          if (
            /^(Studio|工作室|工作區|スタジオ|스튜디오|Estudio|Atelier|Labor|Estúdio)\s*[>›»]/i.test(
              text,
            ) &&
            text.length < 40
          )
            return true;
          if (/^(\d+\s*sources?|\d+\s*个?来源|\d+\s*個?來源)$/i.test(text))
            return true;
          return false;
        };

        const debug = {
          detailOpened,
          url: window.location.href,
          bodyLen: (document.body.textContent || "").length,
        };

        // === STRATEGY 0: Note body container ===
        // The opened note's body renders inside the Studio panel as a
        // `labs-tailwind-doc-viewer` (the note document viewer), within
        // `<studio-panel>` / `note-editor`. This is the SAME element in both the
        // expanded (3-column) and collapsed (tab) layouts.
        //
        // CRITICAL: the Chat conversation reuses similar message markup and the
        // chat history is also in the DOM. If we scraped document-wide (or just
        // "largest .message-content") we'd grab chat and return identical content
        // for every note. So we anchor on the Studio note viewer and explicitly
        // exclude anything inside `chat-panel`. Among matches, prefer the one
        // that is on-screen (the open note) and has the most text.
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const isOnScreen = (r) =>
          r.width > 100 &&
          r.height > 30 &&
          r.bottom > 0 &&
          r.top < vh &&
          r.right > 0 &&
          r.left < vw;
        const bodySelectors = [
          // Studio note viewer (read-only saved responses AND notes).
          "studio-panel labs-tailwind-doc-viewer.note-editor",
          "studio-panel labs-tailwind-doc-viewer",
          "labs-tailwind-doc-viewer.note-editor",
          "labs-tailwind-doc-viewer",
          // Editable rich-text notes.
          "note-editor .ProseMirror",
          ".ProseMirror",
          ".prosemirror-editor",
          "rich-text-editor.note-editor .ProseMirror",
        ];
        const pickBody = (requireOnScreen) => {
          for (const sel of bodySelectors) {
            let best = null;
            document.querySelectorAll(sel).forEach((el) => {
              if (el.closest("chat-panel")) return; // never the Chat conversation
              const r = el.getBoundingClientRect();
              if (requireOnScreen && !isOnScreen(r)) return;
              const text = getCleanText(el).trim();
              if (text.length < 5 || isChrome(text)) return;
              if (!best || text.length > getCleanText(best).trim().length)
                best = el;
            });
            if (best) {
              const text = getCleanTextWithCitations(best).trim();
              if (text.length > 5) {
                debug.editorFound = sel + (requireOnScreen ? "" : " (any)");
                return {
                  content: text,
                  html: getCleanHtml(best),
                  method: "note-body:" + sel,
                  debug,
                };
              }
            }
          }
          return null;
        };
        // Prefer the on-screen note body; fall back to any non-chat note body.
        const body0 = pickBody(true) || pickBody(false);
        if (body0) return body0;

        // === STRATEGY 1: Banner-anchored ===
        // Find "Saved responses are view only" or similar banner
        let bannerEl = null;
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          null,
        );
        let wNode;
        while ((wNode = walker.nextNode())) {
          const t = wNode.textContent?.trim() || "";
          if (t.length > 200 || t.length < 5) continue;
          if (
            /saved\s+(responses?|notes?)\s+are\s+(view|read)|已保存.*(只读|查看)|已儲存.*(唯讀|查看)|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt|somente leitura|sola lettura|alleen-lezen/i.test(
              t,
            ) ||
            (t.length < 60 &&
              /view[\-\s]*only|只读|唯讀|読み取り専用|읽기 전용|solo lectura|lecture seule|schreibgeschützt/i.test(
                t,
              ) &&
              !/chat|source|聊天|來源|来源/i.test(t))
          ) {
            if (!bannerEl || t.length < bannerEl.textContent.length) {
              bannerEl = wNode;
            }
          }
        }

        if (bannerEl) {
          debug.bannerFound = true;

          // Walk up from the banner to find the tightest ancestor that has a
          // sibling child with substantial text content (the actual note body).
          // We walk all the way to STUDIO-PANEL / app-body level (up to 10 steps)
          // and pick the best candidate rather than stopping at the first >= 2 children.
          let contentParent = null;
          let candidate = bannerEl.parentElement;
          for (let i = 0; i < 10; i++) {
            if (!candidate?.parentElement) break;
            const children = Array.from(candidate.children);
            // Check if any sibling of the banner-containing child has real text
            const bannerChild = children.find(
              (c) => c === bannerEl || c.contains(bannerEl),
            );
            if (bannerChild) {
              const siblings = children.filter((c) => c !== bannerChild);
              const hasContent = siblings.some((c) => {
                const t = getCleanText(c).trim();
                return t.length > 50 && !isChrome(t);
              });
              if (hasContent) {
                contentParent = candidate;
                break;
              }
            }
            candidate = candidate.parentElement;
          }
          // Fallback to old behaviour if nothing better found
          if (!contentParent) {
            contentParent = bannerEl.parentElement;
            for (let i = 0; i < 5; i++) {
              if (!contentParent?.parentElement) break;
              if (contentParent.children.length >= 2) break;
              contentParent = contentParent.parentElement;
            }
          }

          // Collect all sibling children that are NOT the banner container
          const directChildren = Array.from(contentParent.children);
          const bannerChild = directChildren.find(
            (c) => c === bannerEl || c.contains(bannerEl),
          );
          let contentParts = [];
          let htmlParts = [];
          for (const child of directChildren) {
            if (child === bannerChild) continue;
            const text = getCleanText(child).trim();
            if (isChrome(text)) continue;
            if (text.length < 5) continue;
            contentParts.push(text);
            htmlParts.push(getCleanHtml(child));
          }
          if (contentParts.length > 0 && contentParts.join("").length > 20) {
            return {
              content: contentParts.join("\n\n"),
              html: htmlParts.join(""),
              method: "after-banner-siblings",
              debug,
            };
          }

          // Deeper search — largest block anywhere in contentParent excluding banner
          const blocksAfter = [];
          contentParent
            .querySelectorAll("div, p, section, article")
            .forEach((el) => {
              if (
                bannerEl === el ||
                bannerEl.contains(el) ||
                el.contains(bannerEl)
              )
                return;
              const text = getCleanText(el).trim();
              if (text.length < 30 || isChrome(text)) return;
              blocksAfter.push({
                text,
                html: getCleanHtml(el),
                len: text.length,
              });
            });
          if (blocksAfter.length > 0) {
            blocksAfter.sort((a, b) => b.len - a.len);
            return {
              content: blocksAfter[0].text,
              html: blocksAfter[0].html,
              method: "after-banner-largest",
              debug,
            };
          }

          // Strip parent
          const clone = contentParent.cloneNode(true);
          clone
            .querySelectorAll("style, script, mat-icon, .material-icons")
            .forEach((s) => s.remove());
          const toRemove = [];
          clone.querySelectorAll("*").forEach((el) => {
            const t = el.textContent?.trim() || "";
            if (isChrome(t)) toRemove.push(el);
          });
          toRemove.forEach((el) => {
            try {
              el.remove();
            } catch {}
          });
          const text = getCleanText(clone).trim();
          if (text.length > 30) {
            return {
              content: text,
              html: clone.innerHTML.trim(),
              method: "banner-parent-stripped",
              debug,
            };
          }
        }

        // === STRATEGY 2: Breadcrumb-anchored ===
        // Find "Studio > Note" or "Studio > ..." breadcrumb
        let breadcrumbEl = null;
        const allEls2 = document.querySelectorAll("*");
        for (const el of allEls2) {
          const t = getCleanText(el).trim();
          if (t.length > 60) continue;
          if (
            /^(Studio|工作室|工作區|スタジオ|스튜디오|Estudio|Atelier|Labor|Estúdio)\s*[>›»]\s*(Note|Saved|笔记|筆記|已保存|已儲存|メモ|保存済み|노트|저장됨|Nota|Guardado)/i.test(
              t,
            )
          ) {
            breadcrumbEl = el;
            break;
          }
        }

        if (breadcrumbEl) {
          debug.breadcrumbFound = true;
          // Walk up to the note panel
          let panel = breadcrumbEl;
          for (let i = 0; i < 8; i++) {
            if (!panel.parentElement) break;
            panel = panel.parentElement;
            const rect = panel.getBoundingClientRect();
            if (rect.height > 300 && rect.width > 200 && rect.width < 900)
              break;
          }

          // Find note title then content after it
          const headings = panel.querySelectorAll(
            "h1, h2, h3, [role='heading']",
          );
          let titleEl = null;
          for (const h of headings) {
            const ht = getCleanText(h).trim();
            if (ht.length < 3) continue;
            if (
              ht === noteTitle ||
              noteTitle.startsWith(ht) ||
              ht.startsWith(noteTitle.substring(0, 20))
            ) {
              titleEl = h;
              break;
            }
          }

          // Extract content blocks from panel
          const blocks = [];
          panel.querySelectorAll("div, p, section, article").forEach((el) => {
            if (
              titleEl &&
              (el === titleEl || el.contains(titleEl) || titleEl.contains(el))
            )
              return;
            if (el.contains(breadcrumbEl)) return;
            const text = getCleanText(el).trim();
            if (text.length < 30 || isChrome(text)) return;
            blocks.push({ text, html: getCleanHtml(el), len: text.length });
          });
          if (blocks.length > 0) {
            blocks.sort((a, b) => b.len - a.len);
            return {
              content: blocks[0].text,
              html: blocks[0].html,
              method: "breadcrumb-panel",
              debug,
            };
          }
        }

        // === STRATEGY 3: Title-anchored ===
        // Find the note title heading in the detail view and grab adjacent content
        if (noteTitle && noteTitle.length > 3) {
          const headings = document.querySelectorAll(
            "h1, h2, h3, h4, [role='heading']",
          );
          let titleEl = null;
          for (const h of headings) {
            const ht = getCleanText(h).trim();
            if (!ht || ht.length < 3) continue;
            const rect = h.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (
              ht === noteTitle ||
              noteTitle.startsWith(ht) ||
              ht.startsWith(noteTitle.substring(0, 15))
            ) {
              titleEl = h; // prefer last match (detail usually rendered after list)
            }
          }

          if (titleEl) {
            debug.titleFound = getCleanText(titleEl).trim().substring(0, 60);
            let container = titleEl.parentElement;
            for (let i = 0; i < 6; i++) {
              if (!container?.parentElement) break;
              const rect = container.getBoundingClientRect();
              if (rect.height > 200 && rect.width > 200) break;
              container = container.parentElement;
            }

            const blocks = [];
            container
              .querySelectorAll("div, p, section, article")
              .forEach((el) => {
                if (
                  el === titleEl ||
                  el.contains(titleEl) ||
                  titleEl.contains(el)
                )
                  return;
                const text = getCleanText(el).trim();
                if (text.length < 30 || isChrome(text)) return;
                blocks.push({ text, html: getCleanHtml(el), len: text.length });
              });
            if (blocks.length > 0) {
              blocks.sort((a, b) => b.len - a.len);
              return {
                content: blocks[0].text,
                html: blocks[0].html,
                method: "title-anchored",
                debug,
              };
            }
          }
        }

        return { content: "", html: "", method: "no-content-found", debug };
      },
    });

    const scraped = contentResult?.[0]?.result || {};

    let hash = 0;
    for (let i = 0; i < card.title.length; i++) {
      hash = (hash << 5) - hash + card.title.charCodeAt(i);
      hash |= 0;
    }

    notes.push({
      id: "note-" + Math.abs(hash).toString(36),
      title: card.title,
      content: scraped.content || "",
      html: scraped.html || "",
      type: card.type,
      timestamp: card.timestamp || new Date().toISOString(),
      _debug: scraped.debug || {},
      _method: scraped.method || "unknown",
    });

    // Go back to the notes list
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const isIconElement = (el) => {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = el.tagName?.toLowerCase() || "";
          const cls = (el.className || "").toString().toLowerCase();
          return (
            tag === "mat-icon" ||
            cls.includes("material-icons") ||
            cls.includes("mat-icon")
          );
        };
        const getCleanText = (node) => {
          let result = "";
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
              if (child.tagName === "STYLE" || child.tagName === "SCRIPT")
                continue;
              if (isIconElement(child)) continue;
              result += getCleanText(child);
            }
          }
          return result;
        };

        // Try breadcrumb "Studio" link
        const allEls = document.querySelectorAll(
          "a, button, [role='button'], [role='link'], span",
        );
        const studioLabels = [
          "studio",
          "工作室",
          "工作區",
          "スタジオ",
          "스튜디오",
          "estudio",
          "atelier",
          "labor",
          "estúdio",
        ];
        for (const el of allEls) {
          const text = getCleanText(el).trim().toLowerCase();
          if (
            studioLabels.includes(text) &&
            (el.tagName === "A" || el.getAttribute("role") === "link")
          ) {
            el.click();
            return "breadcrumb-studio";
          }
        }

        // Try back/close button (including mat-icon "arrow_back")
        for (const btn of allEls) {
          const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
          const raw = (btn.textContent || "").trim().toLowerCase();
          if (
            aria.includes("back") ||
            aria.includes("close") ||
            aria.includes("返回") ||
            aria.includes("关闭") ||
            aria.includes("關閉") ||
            aria.includes("戻る") ||
            aria.includes("閉じる") ||
            aria.includes("뒤로") ||
            aria.includes("닫기") ||
            aria.includes("volver") ||
            aria.includes("cerrar") ||
            aria.includes("retour") ||
            aria.includes("fermer") ||
            aria.includes("zurück") ||
            aria.includes("schließen") ||
            aria.includes("voltar") ||
            aria.includes("fechar") ||
            raw === "arrow_back" ||
            raw === "close" ||
            raw === "返回" ||
            raw === "关闭" ||
            raw === "關閉" ||
            raw === "戻る" ||
            raw === "閉じる" ||
            raw === "뒤로" ||
            raw === "닫기"
          ) {
            btn.click();
            return "back-button";
          }
        }

        // Fallback: Escape
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
          }),
        );
        return "escape";
      },
    });

    await sleep(800);
  }

  return notes;
}

/**
 * Backward sync: extracts notes from NotebookLM and imports to Zotero.
 */
async function backwardSync(collectionId, customTags) {
  // Prefer the notebook that this collection was originally mapped to, so that
  // if the user has multiple NotebookLM tabs open we pull notes from the right one.
  let preferredNotebookId = null;
  try {
    const mappingsRes = await getMappings();
    const mapping = (mappingsRes?.data || []).find(
      (m) => m.collectionId === collectionId,
    );
    if (mapping?.notebookId) preferredNotebookId = mapping.notebookId;
  } catch {
    // Non-fatal — fall through to active-tab resolution.
  }

  const { tab, reason } = await resolveNotebookLMTab(preferredNotebookId);
  if (!tab) {
    return {
      success: false,
      error:
        reason === "ambiguous"
          ? AMBIGUOUS_TAB_ERROR
          : "No NotebookLM tab found. Please open NotebookLM first.",
    };
  }

  if (activeSyncs.has(tab.id)) {
    return {
      success: false,
      error: "A sync is already running on this NotebookLM tab.",
    };
  }
  activeSyncs.add(tab.id);
  try {
    return await backwardSyncImpl(tab, collectionId, customTags);
  } finally {
    activeSyncs.delete(tab.id);
  }
}

async function backwardSyncImpl(tab, collectionId, customTags) {
  const notebookId = extractNotebookIdFromUrl(tab.url);

  let notes;
  try {
    notes = await extractNotesFromTab(tab.id);
  } catch (e) {
    return { success: false, error: `Could not extract notes: ${e.message}` };
  }

  if (!notes || notes.length === 0) {
    return {
      success: true,
      message: "No notes found in this notebook.",
      imported: 0,
    };
  }

  const payloads = notes.map((note) => ({
    collectionId,
    notebookId: notebookId || "",
    noteTitle: note.title,
    noteContent: note.html || note.content,
    noteType: note.type || "saved-note",
    sourceUrl: tab.url,
    tags: customTags || [],
    timestamp: note.timestamp || new Date().toISOString(),
    noteExternalId: note.id,
  }));

  const result = await importNotesToZotero(payloads);
  if (!result.success) {
    return { success: false, error: result.error || "Failed to import notes" };
  }

  const importedCount = (result.data || []).filter((r) => r !== null).length;
  const skippedCount = (result.data || []).filter((r) => r === null).length;

  return {
    success: true,
    message: `Imported ${importedCount} notes (${skippedCount} duplicates skipped).`,
    imported: importedCount,
    skipped: skippedCount,
    total: notes.length,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads NotebookLM's Sources panel state in the tab:
 *   { count: number|null, busy: boolean, method }
 *
 * - `count`: number of sources currently shown (from a "N sources" label, or
 *   a row count). null when unreadable.
 * - `busy`: true while NotebookLM is still processing an upload (a spinner /
 *   progress indicator is visible). Used to wait for a batch to FINISH before
 *   starting the next one — so we never re-drop files that are still loading.
 *
 * The Add-sources dialog subtree is excluded so its own controls don't count.
 */
async function getSourceState(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const getCleanText = (node) => {
          let t = "";
          for (const c of node.childNodes) {
            if (c.nodeType === 3) t += c.textContent;
            else if (c.nodeType === 1) {
              const tag = c.tagName?.toLowerCase() || "";
              const cls = (c.className || "").toString().toLowerCase();
              if (
                tag === "mat-icon" ||
                cls.includes("material-icons") ||
                cls.includes("mat-icon")
              )
                continue;
              t += getCleanText(c);
            }
          }
          return t.trim();
        };
        const inDialog = (el) =>
          !!el.closest('[role="dialog"], mat-dialog-container');

        // Count strategy 1: explicit "N sources" text (virtualization-proof).
        let countFromText = null;
        const countRe =
          /(\d+)\s*(sources?|来源|來源|ソース|소스|출처|fuentes?|quellen?|fontes?|fonti|bronnen|sumber)/i;
        for (const el of document.querySelectorAll(
          'span, div, p, h1, h2, h3, button, [role="button"], [aria-label]',
        )) {
          if (inDialog(el)) continue;
          const text = getCleanText(el);
          if (text.length > 60) continue;
          const m =
            text.match(countRe) ||
            (el.getAttribute("aria-label") || "").match(countRe);
          if (m) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n))
              countFromText =
                countFromText == null ? n : Math.max(countFromText, n);
          }
        }

        // Count strategy 2: source rows.
        const rowSelectors = [
          '[role="list"] [role="listitem"]',
          "mat-list-item",
          '[class*="source"][class*="item"]',
          '[class*="source-list"] > *',
          '[aria-label*="source" i] input[type="checkbox"]',
        ];
        let bestRowCount = 0;
        for (const sel of rowSelectors) {
          const n = [...document.querySelectorAll(sel)].filter(
            (el) => !inDialog(el),
          ).length;
          if (n > bestRowCount) bestRowCount = n;
        }

        let count = null,
          method = null;
        if (countFromText != null) {
          count = countFromText;
          method = "text";
        } else if (bestRowCount > 0) {
          count = bestRowCount;
          method = "rows";
        }

        // Busy: any processing spinner / progress indicator OUTSIDE the dialog.
        const busyEls = document.querySelectorAll(
          'mat-spinner, mat-progress-spinner, mat-progress-bar, [role="progressbar"], .mdc-circular-progress, [class*="spinner"], [class*="loading"], [aria-busy="true"]',
        );
        let busy = false;
        for (const el of busyEls) {
          if (inDialog(el)) continue;
          const s = window.getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden") continue;
          busy = true;
          break;
        }

        return { count, method, busy };
      },
    });
    return r?.[0]?.result || { count: null, method: null, busy: false };
  } catch {
    return { count: null, method: null, busy: false };
  }
}

/**
 * Reads the live source list from NotebookLM's Sources panel.
 *
 * Returns one record per source: { label, faviconDomain }, where:
 *   - `label`         is the full, UNtruncated source name (from aria-label).
 *   - `faviconDomain` is the URL encoded in the favicon icon's src
 *     (https://www.google.com/s2/favicons?domain=<URL>) — a stable, exact
 *     identifier for URL sources. Null for PDFs (generic doc icon).
 *
 * Returns `null` (not []) when the Sources panel isn't open / readable, so
 * callers can tell "panel not visible" from "genuinely zero sources" and
 * avoid pruning markers on a blind read.
 *
 * DOM contract (verified against NotebookLM, 2026-06):
 *   - each source row is `div.single-source-container`
 *   - its name lives in `aria-label` on the row's title/button descendants
 *   - the favicon is `img.favicon-icon` with src `...?domain=<sourceURL>&sz=..`
 */
async function getSourceNames(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const inDialog = (el) =>
          !!el.closest('[role="dialog"], mat-dialog-container');
        const rows = [
          ...document.querySelectorAll(".single-source-container"),
        ].filter((el) => !inDialog(el));
        if (rows.length === 0) {
          // Zero rows can mean "notebook emptied" or "panel not readable".
          // The empty-state text is only rendered when the Sources panel is
          // open with genuinely zero sources — deleting ALL sources must be
          // detectable, so report a confirmed empty list instead of null.
          // (No match → null: never prune blind on a DOM misread.)
          const emptyState = /saved sources will appear here/i.test(
            document.body?.textContent || "",
          );
          return emptyState ? [] : null;
        }

        const decodeFaviconDomain = (src) => {
          if (!src) return null;
          const m = src.match(/[?&]domain=([^&]+)/);
          if (!m) return null;
          try {
            return decodeURIComponent(m[1]);
          } catch {
            return m[1];
          }
        };

        return rows
          .map((row) => {
            // Full untruncated name: prefer the title element's aria-label.
            const titleEl =
              row.querySelector(".source-title[aria-label]") ||
              row.querySelector("[aria-label]");
            const label = (
              titleEl?.getAttribute("aria-label") ||
              row.textContent ||
              ""
            )
              .replace(/more_vert\s*$/i, "")
              .trim();
            const favSrc =
              row
                .querySelector('img.favicon-icon, [class*="favicon"]')
                ?.getAttribute("src") || "";
            return { label, faviconDomain: decodeFaviconDomain(favSrc) };
          })
          .filter((s) => s.label || s.faviconDomain);
      },
    });
    return r?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

// ─── Reconcile ("Check notebook") ────────────────────────────────────
// Identity matching + the prune decision live in reconcile.js
// (importScripts'd above) so they're unit-testable; see computePruneKeys.

/**
 * Reconciles the saved upload registry for (collection, notebook) against the
 * notebook's live sources, pruning markers for sources that were removed in
 * NotebookLM so those items can be re-uploaded.
 *
 * Identity-driven (see computePruneKeys in reconcile.js): a name-bearing
 * marker is pruned when NONE of its identifiers (favicon domain / captured
 * label / uploaded filename) is still found among the live sources. Extra
 * unrelated sources in the notebook (added manually or from other
 * collections) do NOT block pruning — the old count-shortfall heuristic did,
 * which left deleted sources permanently marked as uploaded.
 *
 * Writes: the durable Zotero mapping is the source of truth, so the prune is
 * applied THERE first and the local cache is mirrored from it. A local-only
 * prune would be resurrected by the mapping on the next sync's merge.
 *
 * Safety rails:
 *   - NotebookLM still ingesting after a settle-wait → pruning proceeds, but
 *     markers uploaded in the last `skipRecentMs` are protected (a just-
 *     uploaded source may still show a placeholder label and would look
 *     deleted); older deletions are fully readable and prune normally
 *   - the Sources panel can't be read (getSourceNames → null)
 *   - the live read is partial (rows < the panel's "N sources" count — the
 *     list virtualizes, so off-screen sources would look deleted)
 *
 * Returns { keys, note } — still-valid item keys plus the rail that blocked
 * pruning ("unreadable" | "partial" | "mapping"), or null when the result
 * is a true answer. The popup surfaces the note so a blocked check is never
 * mistaken for "nothing was deleted".
 */
async function reconcileSyncedKeys(collectionId, notebookId, tabId) {
  const syncKey = `sync_${collectionId}_${notebookId}`;
  const state = await chrome.storage.local.get(syncKey);
  const registry = state[syncKey] || {};
  const keys = Object.keys(registry);
  if (keys.length === 0) return { keys: [], note: null };

  // Give the panel a few seconds to settle first — users often check right
  // after deleting/uploading, and a mid-ingestion spinner makes the count
  // unstable.
  let liveState = await getSourceState(tabId);
  for (let i = 0; i < 8 && liveState && liveState.busy; i++) {
    await sleep(1000);
    liveState = await getSourceState(tabId);
  }
  const stillBusy = !!(liveState && liveState.busy);

  const liveSources = await getSourceNames(tabId); // [{label, faviconDomain}] | null
  if (liveSources == null) {
    console.log(
      `[n2z] Reconcile ${syncKey}: Sources panel not readable — keeping all ${keys.length} markers.`,
    );
    return { keys, note: "unreadable" }; // panel not open / unreadable — never prune blind
  }

  // Authoritative source count (prefers NotebookLM's "N sources" text).
  // An empty-but-open panel (getSourceNames → []) is positive evidence of
  // zero sources — don't let a missing/stale count text block the prune.
  const countState =
    liveState && liveState.count != null
      ? liveState
      : await getSourceState(tabId);
  const liveCount =
    liveSources.length === 0
      ? 0
      : countState && countState.count != null
        ? countState.count
        : null;

  // Partial read: the panel reports more sources than are in the DOM
  // (virtualization / mid-update) — off-screen sources would look deleted.
  if (liveCount != null && liveCount > liveSources.length) {
    console.log(
      `[n2z] Reconcile ${syncKey}: partial read (count=${liveCount}, rows=${liveSources.length}) — keeping all markers.`,
    );
    return { keys, note: "partial" };
  }

  // Still ingesting after the wait: a just-uploaded source may show a
  // placeholder label, so protect markers uploaded in the last minute — but
  // older deletions are fully readable and must NOT be blocked.
  const skipRecentMs = stillBusy ? 60_000 : 0;
  const toPrune = computePruneKeys(registry, liveSources, liveCount, {
    skipRecentMs,
  });

  // Diagnostic: surface the exact comparison so mismatches are debuggable.
  const nameBearingKeys = keys.filter((k) => {
    const e = registry[k];
    return e && typeof e === "object" && (e.label || e.name || e.url || e.faviconDomain);
  });
  console.log(
    `[n2z] Reconcile ${syncKey}: ${nameBearingKeys.length} name-bearing markers, ` +
      `liveCount=${liveCount} (rows=${liveSources.length}), prune=${toPrune.length}\n` +
      `  stored: ${nameBearingKeys.map((k) => JSON.stringify(registry[k].label || registry[k].url || registry[k].name)).join(", ")}\n` +
      `  live:   ${liveSources.map((s) => JSON.stringify(s.label || s.faviconDomain)).join(", ")}`,
  );

  if (toPrune.length === 0) return { keys, note: null }; // nothing removed

  // The Zotero mapping is the durable source of truth (the popup's ✓ marks
  // and the next sync's merge both read it), so prune THERE first and mirror
  // the local cache from the result. A local-only prune would be resurrected
  // by the mapping. If the mapping can't be updated (Zotero unreachable),
  // abort — better to keep a stale marker than to fight a resurrecting one.
  try {
    const m = await zoteroRequest("/n2z/mapping", {
      action: "get",
      collectionId,
    });
    if (m?.success && m.data && m.data.notebookId === notebookId) {
      for (const k of toPrune) delete m.data.syncedItemHashes?.[k];
      await zoteroRequest("/n2z/mapping", { action: "set", mapping: m.data });
    }
    // Mapping bound to a DIFFERENT notebook: the local registry (keyed by
    // collection+notebook) is authoritative for this notebook — local prune
    // alone is safe because the next sync ignores a mismatched mapping's
    // hashes for this notebook.
  } catch (e) {
    console.warn(`[n2z] Reconcile ${syncKey}: mapping update failed — keeping all markers.`, e);
    return { keys, note: "mapping" };
  }

  for (const k of toPrune) delete registry[k];
  await chrome.storage.local.set({ [syncKey]: registry });

  console.log(
    `[n2z] Reconcile pruned ${toPrune.length} removed source(s); ${Object.keys(registry).length} remain.`,
  );
  return { keys: Object.keys(registry), note: null };
}

/**
 * Broadcasts a progress update to the popup (fire-and-forget).
 * The popup may not be open, so we ignore errors.
 */
function broadcastProgress(payload) {
  chrome.runtime
    .sendMessage({ type: "n2z-sync-progress", ...payload })
    .catch(() => {});
}

/**
 * Polls a predicate function inside a tab until it returns truthy, or the
 * timeout elapses. Returns the final result (the last value the predicate
 * returned). Used to replace fixed sleeps that wait on DOM transitions.
 */
async function waitForInTab(
  tabId,
  predicateFn,
  { timeoutMs = 3000, intervalMs = 100, args = [] } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: predicateFn,
        args,
      });
      last = r?.[0]?.result;
      if (last) return last;
    } catch {
      // tab may be transitioning; retry
    }
    await sleep(intervalMs);
  }
  return last;
}

// ─── Message handlers ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case "n2z-check-connection":
        // Returns { connected, reason } — reason in {ok, timeout, blocked-or-down}
        return await checkZoteroConnection();

      case "n2z-get-libraries":
        return getLibraries();

      case "n2z-get-collections":
        return getCollections(message.libraryId);

      case "n2z-get-mappings":
        return getMappings();

      case "n2z-get-synced-items": {
        // Durable source of truth for "already uploaded": the per-unit record
        // stored in the Zotero mapping (mapping.syncedItemHashes), keyed by
        // Zotero itemKey (default unit) or "itemKey::unitId" (extras).
        // Survives popup reopen; never touched by DOM reads. Returns the
        // marker MAP (not just keys) so the popup can show which file was
        // actually uploaded for legacy per-item markers.
        const m = await zoteroRequest("/n2z/mapping", {
          action: "get",
          collectionId: message.collectionId,
        });
        const hashes =
          m?.success && m.data ? m.data.syncedItemHashes || {} : {};
        // Only count items mapped to the CURRENTLY connected notebook, so the
        // checks reflect the notebook the user is actually looking at.
        const wantNb = message.notebookId || null;
        const sameNb =
          !wantNb || !m?.data?.notebookId || m.data.notebookId === wantNb;
        return { success: true, data: sameNb ? hashes : {} };
      }

      case "n2z-remove-mapping":
        return removeMapping(message.collectionId);

      case "n2z-forward-sync":
        return forwardSync(
          message.collectionId,
          message.collectionName,
          message.selectedItemKeys,
          message.libraryId,
          message.libraryName,
          message.tag,
          message.selectedUnits,
        );

      case "n2z-sync-status": {
        const prog = syncProgress.get(message.tabId);
        return prog
          ? { success: true, data: prog }
          : { success: false, error: "No sync in progress" };
      }

      case "n2z-cancel-sync": {
        // Flag the active sync to stop at its next safe checkpoint. If no tabId
        // is given, cancel the sole active sync (the common single-notebook case).
        let tabId = message.tabId;
        if (tabId == null) {
          const ids = [...activeSyncs];
          tabId = ids.length === 1 ? ids[0] : null;
        }
        if (tabId != null && activeSyncs.has(tabId)) {
          cancelledSyncs.add(tabId);
          return { success: true, cancelling: true };
        }
        return { success: false, error: "No sync in progress to cancel" };
      }

      case "n2z-backward-sync":
        return backwardSync(message.collectionId, message.customTags);

      case "n2z-get-notebooklm-tab": {
        const { tab, reason } = await resolveNotebookLMTab();
        if (tab) {
          return {
            success: true,
            data: {
              id: tab.id,
              url: tab.url,
              notebookId: extractNotebookIdFromUrl(tab.url),
            },
          };
        }
        return {
          success: false,
          error:
            reason === "ambiguous"
              ? AMBIGUOUS_TAB_ERROR
              : "No NotebookLM tab found",
        };
      }

      case "n2z-get-tags":
        return getTags(message.libraryId);

      case "n2z-get-items":
        return getExportableItems({
          collectionId: message.collectionId,
          libraryId: message.libraryId,
          tag: message.tag,
        });

      case "n2z-inspect-upload-dialog": {
        const { tab: inspectTab } = await resolveNotebookLMTab();
        if (!inspectTab)
          return { success: false, error: "No NotebookLM tab found" };
        const r = await chrome.scripting.executeScript({
          target: { tabId: inspectTab.id },
          func: () => {
            const dialog =
              document.querySelector('[role="dialog"]') || document.body;
            const inputs = [...document.querySelectorAll("input")].map((i) => ({
              type: i.type,
              id: i.id,
              name: i.name,
              cls: i.className.slice(0, 80),
              accept: i.accept,
              visible: window.getComputedStyle(i).display !== "none",
            }));
            const buttons = [
              ...document.querySelectorAll('button, [role="button"]'),
            ]
              .filter((e) => {
                const s = window.getComputedStyle(e);
                return s.display !== "none" && s.visibility !== "hidden";
              })
              .map((e) => ({
                tag: e.tagName,
                text: e.textContent?.trim().slice(0, 60),
                cls: e.className?.slice(0, 60),
              }));
            return {
              dialogHTML: dialog.innerHTML.slice(0, 4000),
              inputs,
              buttons: buttons.slice(0, 20),
              bodyText: document.body.textContent.slice(0, 500),
            };
          },
        });
        return { success: true, data: r?.[0]?.result };
      }

      case "n2z-reconcile-synced": {
        // Explicit removal check (triggered by the "Check notebook" button).
        // Prunes markers for sources removed in NotebookLM, then returns the
        // remaining synced markers from the durable Zotero mapping, plus the
        // rail that blocked pruning (note) so the popup can say WHY nothing
        // was cleared instead of implying "nothing was deleted".
        const { tab: recTab } = await resolveNotebookLMTab();
        const readMappingHashes = async () => {
          const m = await zoteroRequest("/n2z/mapping", {
            action: "get",
            collectionId: message.collectionId,
          });
          const sameNb =
            m?.data &&
            (!message.notebookId || m.data.notebookId === message.notebookId);
          return sameNb ? m.data.syncedItemHashes || {} : {};
        };
        // Never probe the tab while a sync is uploading to it — a concurrent
        // scripting read can disrupt the CDP file-chooser handshake.
        if (!recTab || activeSyncs.has(recTab.id)) {
          return { success: true, data: await readMappingHashes(), note: null };
        }
        const rec = await reconcileSyncedKeys(
          message.collectionId,
          message.notebookId,
          recTab.id,
        );
        return {
          success: true,
          data: await readMappingHashes(),
          note: rec?.note || null,
        };
      }

      case "n2z-clear-sync-state": {
        // Clear all sync state for this collection: the local cache AND the
        // durable per-item record in the Zotero mapping (the source of truth).
        const allKeys = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(allKeys).filter(
          (k) =>
            k.startsWith(`sync_${message.collectionId}_`) ||
            k === `sync_${message.collectionId}`,
        );
        if (keysToRemove.length > 0) {
          await chrome.storage.local.remove(keysToRemove);
        }
        try {
          const m = await zoteroRequest("/n2z/mapping", {
            action: "get",
            collectionId: message.collectionId,
          });
          if (m?.success && m.data) {
            m.data.syncedItemHashes = {};
            await zoteroRequest("/n2z/mapping", {
              action: "set",
              mapping: m.data,
            });
          }
        } catch {
          /* best-effort */
        }
        return { success: true, message: "Sync state cleared" };
      }

      case "n2z-extract-notes": {
        const { tab: nlmTab, reason: extractReason } =
          await resolveNotebookLMTab();
        if (!nlmTab) {
          return {
            success: false,
            error:
              extractReason === "ambiguous"
                ? AMBIGUOUS_TAB_ERROR
                : "No NotebookLM tab found",
          };
        }
        try {
          const notes = await extractNotesFromTab(nlmTab.id);
          const notebookId = extractNotebookIdFromUrl(nlmTab.url);
          // Cache extracted notes per notebook so they survive the popup being
          // closed/reopened. A fresh "Find Text Notes" overwrites the cache.
          if (notebookId) {
            await chrome.storage.local.set({
              [notesCacheKey(notebookId)]: {
                notebookId,
                notebookTitle: nlmTab.title || "",
                notes,
                extractedAt: Date.now(),
              },
            });
          }
          return {
            success: true,
            data: notes,
            notebookId,
            debug: notes.length === 0 ? `Page: ${nlmTab.title}` : undefined,
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case "n2z-get-cached-notes": {
        // Return previously-extracted notes for the active notebook, if any.
        const { tab: cacheTab } = await resolveNotebookLMTab();
        const notebookId = cacheTab
          ? extractNotebookIdFromUrl(cacheTab.url)
          : "";
        if (!notebookId)
          return { success: false, error: "No NotebookLM tab found" };
        const stored = await chrome.storage.local.get(
          notesCacheKey(notebookId),
        );
        const entry = stored[notesCacheKey(notebookId)];
        if (entry && Array.isArray(entry.notes)) {
          return {
            success: true,
            data: entry.notes,
            notebookId,
            extractedAt: entry.extractedAt,
          };
        }
        return { success: true, data: [], notebookId };
      }

      case "n2z-import-selected-notes": {
        // Import pre-extracted notes (selected by user in popup) into Zotero
        const { tab: nlmTab2 } = await resolveNotebookLMTab();
        const notebookId2 = nlmTab2
          ? extractNotebookIdFromUrl(nlmTab2.url)
          : "";
        const notes = message.notes || [];
        if (notes.length === 0) {
          return { success: false, error: "No notes to import" };
        }

        const payloads = notes.map((note) => ({
          collectionId: message.collectionId,
          notebookId: notebookId2 || "",
          noteTitle: note.title,
          noteContent: note.html || note.content,
          noteType: note.type || "saved-note",
          sourceUrl: nlmTab2?.url || "",
          tags: message.customTags || [],
          timestamp: note.timestamp || new Date().toISOString(),
          noteExternalId: note.id,
        }));

        const importResult = await importNotesToZotero(payloads);
        if (!importResult.success) {
          return {
            success: false,
            error: importResult.error || "Failed to import notes",
          };
        }

        const imported = (importResult.data || []).filter(
          (r) => r !== null,
        ).length;
        const skipped = (importResult.data || []).filter(
          (r) => r === null,
        ).length;

        return {
          success: true,
          message: `Imported ${imported} notes${skipped > 0 ? ` (${skipped} duplicates skipped)` : ""}.`,
          imported,
          skipped,
          total: notes.length,
        };
      }

      default:
        return { success: false, error: "未知消息类型" };
    }
  };

  handler()
    .then(sendResponse)
    .catch((e) => sendResponse({ success: false, error: e.message }));

  return true;
});
