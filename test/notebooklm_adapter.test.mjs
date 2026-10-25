import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const shared = require("../extension/webchat_shared.js");
const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const adapterSource = read("../extension/notebooklm_adapter.js");

function createNotebookLMAdapter(html = "<html><body></body></html>", url = "https://notebooklm.google.com/notebook/a969f72e-7f8a-4b54-b537-8aca8bacf8a0") {
  const { window, document } = parseHTML(html);
  window.location = new URL(url);
  window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  const context = vm.createContext({
    window,
    document,
    globalThis: {},
    URL,
    console,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    InputEvent: window.InputEvent || window.Event,
    DragEvent: window.DragEvent || window.Event,
    DataTransfer: window.DataTransfer || class { items = { add() {} }; },
    SyncZoteroShared: shared,
    WeakMap,
    Map,
    Set,
    Array,
    Object,
    Date,
    Math,
    String,
    RegExp,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(adapterSource, context);
  const isVisibleElement = (el) => Boolean(el);
  const htmlToMarkdown = (rawHtml) => {
    const textDom = parseHTML(`<html><body>${rawHtml}</body></html>`);
    return textDom.document.body.textContent.trim();
  };
  const adapter = context.globalThis.SyncZoteroNotebookLM.createAdapter({
    document,
    isVisibleElement,
    htmlToMarkdown,
    shared,
  });
  return { dom: { window, document }, adapter, SyncZoteroNotebookLM: context.globalThis.SyncZoteroNotebookLM };
}

test("NotebookLM URL normalization accepts valid notebook UUIDs from both origins", () => {
  const { SyncZoteroNotebookLM } = createNotebookLMAdapter();
  const uuid = "a969f72e-7f8a-4b54-b537-8aca8bacf8a0";

  const url1 = `https://notebooklm.google.com/notebook/${uuid}`;
  const url2 = `https://notebook.google.com/notebook/${uuid}/`;
  const urlWithQuery = `https://notebooklm.google.com/notebook/${uuid}?addSource=true#section`;

  assert.equal(
    SyncZoteroNotebookLM.normalizeConversationUrl(url1),
    `https://notebooklm.google.com/notebook/${uuid}`
  );
  assert.equal(
    SyncZoteroNotebookLM.normalizeConversationUrl(url2),
    `https://notebooklm.google.com/notebook/${uuid}`
  );
  assert.equal(
    SyncZoteroNotebookLM.normalizeConversationUrl(urlWithQuery),
    `https://notebooklm.google.com/notebook/${uuid}`
  );

  // Reject malicious / lookalike
  assert.equal(SyncZoteroNotebookLM.normalizeConversationUrl(`https://notebooklm.google.com.evil/notebook/${uuid}`), null);
  assert.equal(SyncZoteroNotebookLM.normalizeConversationUrl(`http://notebooklm.google.com/notebook/${uuid}`), null);
  assert.equal(SyncZoteroNotebookLM.normalizeConversationUrl("https://notebooklm.google.com/"), null);
  assert.equal(SyncZoteroNotebookLM.normalizeConversationUrl("https://notebooklm.google.com/notebook/invalid-uuid"), null);
});

test("NotebookLM binding resolution enforces UUID validation", () => {
  const uuid = "a969f72e-7f8a-4b54-b537-8aca8bacf8a0";

  const resolved = shared.resolveExpectedConversationBinding(
    { expected_chat_url: `https://notebooklm.google.com/notebook/${uuid}` },
    "notebooklm"
  );
  assert.equal(resolved.chatId, uuid);
  assert.equal(resolved.chatUrl, `https://notebooklm.google.com/notebook/${uuid}`);

  // Invalid ID throws
  assert.throws(() => {
    shared.resolveExpectedConversationBinding(
      { expected_chat_id: "not-a-valid-uuid" },
      "notebooklm"
    );
  }, /Expected NotebookLM conversation binding ID does not match/);

  // Mismatched URL and ID throws
  assert.throws(() => {
    shared.resolveExpectedConversationBinding(
      {
        expected_chat_url: `https://notebooklm.google.com/notebook/${uuid}`,
        expected_chat_id: "11111111-2222-3333-4444-555555555555"
      },
      "notebooklm"
    );
  }, /Expected NotebookLM conversation binding ID does not match/);
});

test("NotebookLM message role and text extraction with citations", () => {
  const html = `
    <div class="chat-panel">
      <chat-message id="msg-user">
        <div class="from-user-container">
          <div class="message-text-content">What is the capital of Turkey?</div>
        </div>
      </chat-message>
      <chat-message id="msg-bot">
        <div class="to-user-container">
          <div class="message-text-content">
            <thinking-chain-view>Some hidden thoughts</thinking-chain-view>
            <p>Ankara is the capital of Turkey<span><button class="citation-marker"><span aria-label="1: source.pdf">1</span></button></span>.</p>
          </div>
          <div class="mat-mdc-card-actions message-actions">
            <button aria-label="Copy">Copy</button>
          </div>
        </div>
      </chat-message>
    </div>
  `;
  const { dom, adapter } = createNotebookLMAdapter(html);
  const userNode = dom.document.querySelector('#msg-user');
  const botNode = dom.document.querySelector('#msg-bot');

  assert.equal(adapter.getMessageRole(userNode), "user");
  assert.equal(adapter.getMessageRole(botNode), "assistant");

  assert.equal(adapter.extractUserMessageText(userNode), "What is the capital of Turkey?");
  const botText = adapter.extractAssistantAnswerText(botNode);
  assert.ok(botText.includes("Ankara is the capital of Turkey"));
  assert.ok(botText.includes("[1]"));
  assert.ok(!botText.includes("Some hidden thoughts"));
  assert.ok(!botText.includes("Copy"));

  const turnKey = adapter.getMessageId(botNode);
  assert.equal(adapter.isResponseComplete(turnKey), true);
});

test("NotebookLM source classification and attachment contract", () => {
  const html = `
    <div class="sources-list">
      <div class="single-source-container">
        <div class="source-title">paper-ready.pdf</div>
        <input type="checkbox" checked />
      </div>
      <div class="single-source-container">
        <div class="source-title">paper-busy.pdf</div>
        <mat-spinner></mat-spinner>
      </div>
    </div>
  `;
  const { adapter } = createNotebookLMAdapter(html);
  const sources = adapter.listSources();
  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, "paper-ready.pdf");
  assert.equal(sources[0].ready, true);
  assert.equal(sources[1].title, "paper-busy.pdf");
  assert.equal(sources[1].ready, false);
  assert.equal(sources[1].busy, true);

  const verifiedContract = adapter.classifySubmittedAttachments([], "paper-ready.pdf");
  assert.equal(verifiedContract.pdfAttachmentCount, 1);
  assert.equal(verifiedContract.contractVerified, true);
  assert.equal(verifiedContract.filenameMatched, true);

  const unreadyContract = adapter.classifySubmittedAttachments([], "paper-busy.pdf");
  assert.equal(unreadyContract.pdfAttachmentCount, 1);
  assert.equal(unreadyContract.contractVerified, false);

  const missingContract = adapter.classifySubmittedAttachments([], "non-existent.pdf");
  assert.equal(missingContract.pdfAttachmentCount, 0);
  assert.equal(missingContract.contractVerified, false);
  assert.equal(missingContract.filenameMatched, false);
});
