// NotebookLM (Gemini Notebook) DOM WebChat adapter.
// Google uses Angular / Material Web Components on notebook.google.com.
(function (root) {
  const NOTEBOOK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const NOTEBOOK_PATH_RE = /^\/notebook\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

  function normalizeNotebookLMConversationUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      if (
        (parsed.origin !== "https://notebooklm.google.com" &&
          parsed.origin !== "https://notebook.google.com") ||
        parsed.username ||
        parsed.password
      ) {
        return null;
      }
      const match = parsed.pathname.match(NOTEBOOK_PATH_RE);
      return match ? `https://notebooklm.google.com/notebook/${match[1].toLowerCase()}` : null;
    } catch (_) {
      return null;
    }
  }

  root.SyncZoteroNotebookLM = {
    normalizeConversationUrl: normalizeNotebookLMConversationUrl,
    UUID_REGEX: NOTEBOOK_UUID_RE,

    createAdapter({ document, isVisibleElement, htmlToMarkdown, shared }) {
      const composerSelector = 'query-box textarea.query-box-input, textarea[aria-label="Query box"]';

      const findSendButton = () => {
        const btn = document.querySelector('query-box button[aria-label="Submit"]');
        return btn && isVisibleElement(btn) ? btn : null;
      };

      const findStopButton = () => {
        const btn = document.querySelector('button[aria-label="Stop"], [fonticonname="stop"]')?.closest('button') ||
          document.querySelector('button[aria-label="Stop"]');
        return btn && isVisibleElement(btn) ? btn : null;
      };

      const messageRole = (node) => {
        if (!node) return null;
        if (node.querySelector?.('.from-user-container') || node.classList?.contains('from-user-container')) {
          return "user";
        }
        if (node.querySelector?.('.to-user-container') || node.classList?.contains('to-user-container')) {
          return "assistant";
        }
        return null;
      };

      const turnIdentities = new WeakMap();
      let provisionalSerial = 0;

      const messageId = (node) => {
        const turn = node?.closest?.('chat-message') || node;
        const role = messageRole(node);
        if (!turn || !role) return null;
        let identity = turnIdentities.get(turn);
        if (!identity) {
          identity = turn.id || `nb-provisional-${++provisionalSerial}`;
          turnIdentities.set(turn, identity);
        }
        return `${identity}:${role}`;
      };

      const cleanAssistantNode = (node) => {
        const clone = node.cloneNode(true);
        // Remove thinking block
        clone.querySelectorAll('thinking-chain-view, .thinking-chain').forEach((el) => el.remove());

        // Transform citation markers to readable markdown [n]
        clone.querySelectorAll('button.citation-marker').forEach((btn) => {
          const aria = btn.querySelector('span')?.getAttribute('aria-label');
          const num = btn.textContent?.trim();
          let label = "";
          if (num && num !== 'more_horiz') {
            label = ` [${num}]`;
          } else if (aria) {
            label = ` [${aria.split(':')[0]}]`;
          }
          if (label) {
            const span = document.createElement('span');
            span.textContent = label;
            btn.replaceWith(span);
          } else {
            btn.remove();
          }
        });

        // Strip action bar, buttons, ripple, tooltip triggers
        clone.querySelectorAll(
          'mat-card-actions, .message-actions, button, [role="button"], [hidden], [aria-hidden="true"], .mat-focus-indicator, .cdk-visually-hidden'
        ).forEach((el) => el.remove());

        return clone;
      };

      const listSources = () => {
        return Array.from(document.querySelectorAll('.single-source-container')).map((row) => {
          const titleEl = row.querySelector('.source-title');
          const title = (titleEl?.textContent || titleEl?.getAttribute('aria-label') || '').trim();
          const checkbox = row.querySelector('input[type="checkbox"]');
          const isChecked = Boolean(
            checkbox?.checked ||
            checkbox?.hasAttribute?.('checked') ||
            row.querySelector('.mat-mdc-checkbox-checked, .mdc-checkbox--selected')
          );
          const spinner = row.querySelector('mat-spinner, mat-progress-spinner, [role="progressbar"]');
          const error = row.querySelector('.error, [class*="error"]');
          const ready = Boolean(title && isChecked && !spinner && !error);
          return { title, ready, busy: Boolean(spinner), error: Boolean(error), node: row };
        }).filter((s) => s.title);
      };

      return {
        siteId: "notebooklm",
        homeUrl: "https://notebooklm.google.com/",
        answerCapture: "dom",
        forbidsBlobWorkers: true, // Uses Google web page timer
        supportsImages: false,
        composerSelectors: [composerSelector],

        sendButtonSelectors: () => findSendButton(),
        findStopButton,
        findUploadControl: () => document.querySelector('[xapscottyuploaderdropzone], button[aria-label="Add source"]'),

        userMessageSelector: "chat-message .from-user-container",
        assistantMessageSelectors: ["chat-message .to-user-container"],
        conversationMessageSelector: "chat-message .from-user-container, chat-message .to-user-container",
        conversationTurnSelector: "chat-message",

        getMessageRole: messageRole,
        getMessageId: messageId,

        extractUserMessageText(node) {
          const content = node.querySelector?.('.message-text-content, .md3-body-text') || node;
          return content?.innerText?.trim() || "";
        },

        extractAssistantAnswerText(node) {
          const content = node.querySelector?.('.message-text-content') || node;
          if (!content) return "";
          const cleaned = cleanAssistantNode(content);
          return htmlToMarkdown(cleaned.innerHTML).trim();
        },

        extractAssistantThinkingText(node) {
          const thinking = node.querySelector?.('thinking-chain-view');
          if (!thinking) return "";
          return thinking.innerText?.trim() || "";
        },

        extractAttachmentNames() {
          return [];
        },

        listSources,

        isResponseComplete(assistantTurnKey) {
          if (findStopButton()) return false;
          if (!assistantTurnKey) return false;
          const node = Array.from(document.querySelectorAll('chat-message')).find(
            (candidate) => messageId(candidate) === assistantTurnKey
          );
          if (!node || !isVisibleElement(node)) return false;
          const actions = node.querySelector('.mat-mdc-card-actions, .message-actions');
          return Boolean(actions && isVisibleElement(actions));
        },

        classifySubmittedAttachments(_attachments, expectedFilename) {
          const sources = listSources();
          if (!expectedFilename) {
            return {
              pdfAttachmentCount: 0,
              contractVerified: true,
              filenameMatched: null,
            };
          }
          const norm = (s) => String(s || "").trim().toLowerCase();
          const match = sources.find((s) => norm(s.title) === norm(expectedFilename));
          const ready = Boolean(match && match.ready);
          return {
            pdfAttachmentCount: match ? 1 : 0,
            contractVerified: ready,
            filenameMatched: Boolean(match),
          };
        },

        async typePrompt(textarea, text) {
          textarea.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          )?.set;
          if (nativeSetter) {
            nativeSetter.call(textarea, text);
          } else {
            textarea.value = text;
          }
          textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        },

        async uploadFile(file, { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), timeoutMs = 120000 } = {}) {
          const startedAt = now();
          const dropzone = document.querySelector('[xapscottyuploaderdropzone]');
          if (!dropzone) {
            throw new Error("NotebookLM source dropzone was not found.");
          }

          const dt = new DataTransfer();
          dt.items.add(file);

          const dragenter = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt });
          const dragover = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
          const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });

          dropzone.dispatchEvent(dragenter);
          dropzone.dispatchEvent(dragover);
          dropzone.dispatchEvent(drop);

          const norm = (s) => String(s || "").trim().toLowerCase();
          while (now() - startedAt <= timeoutMs) {
            const sources = listSources();
            const found = sources.find((s) => norm(s.title) === norm(file.name));
            if (found) {
              if (found.error) {
                throw new Error(`NotebookLM failed to process source "${file.name}".`);
              }
              if (found.ready) {
                return {
                  method: "drag_drop",
                  filenameConfirmed: true,
                  readyConfirmed: true,
                  evidence: found.title,
                  totalElapsedMs: now() - startedAt,
                };
              }
            }
            await wait(1000);
          }
          throw new Error(`NotebookLM did not confirm a ready source for "${file.name}" within ${timeoutMs / 1000}s.`);
        },

        getChatIdFromUrl(url) {
          return normalizeNotebookLMConversationUrl(url)?.split("/").pop() || null;
        },

        historyLinkSelector: 'a[href^="/notebook/"], a[href^="https://notebooklm.google.com/notebook/"], a[href^="https://notebook.google.com/notebook/"]',

        async prepareHistory({ wait, now = () => Date.now(), timeoutMs = 15000 } = {}) {
          const startedAt = now();
          while (now() - startedAt < timeoutMs) {
            if (document.querySelector(this.historyLinkSelector)) return true;
            await wait(200);
          }
          return Boolean(document.querySelector(this.historyLinkSelector));
        },

        buildHistoryEntry(anchor) {
          const href = anchor.getAttribute("href") || "";
          const resolved = new URL(href, "https://notebooklm.google.com").href;
          const chatUrl = normalizeNotebookLMConversationUrl(resolved);
          if (!chatUrl) return null;
          const id = chatUrl.split("/").pop();
          const title = anchor.innerText?.trim() || anchor.getAttribute("aria-label") || id;
          return { id, title, chatUrl };
        },

        supportsFileUpload: true,
        supportsModelSelector: false,
        hasFormWrapper: false,
      };
    },
  };
})(globalThis);
