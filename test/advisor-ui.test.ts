import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { renderChatPage, renderLoginPage } from "../src/advisor-ui.ts";

// Minimal fake DOM element used to execute the chat page's inline <script>
// in a sandboxed vm context. Real enough to drive the submit handler without
// pulling in a DOM dependency.
interface FakeElement {
  tagName: string;
  value: string;
  textContent: string;
  className: string;
  disabled: boolean;
  hidden: boolean;
  scrollTop: number;
  scrollHeight: number;
  children: FakeElement[];
  parent?: FakeElement;
  listeners: Record<string, (...args: unknown[]) => unknown>;
  dataset: Record<string, string>;
  append(...nodes: FakeElement[]): void;
  appendChild(node: FakeElement): FakeElement;
  replaceChildren(): void;
  addEventListener(type: string, handler: (...args: unknown[]) => unknown): void;
  focus(): void;
  setAttribute(name: string, value: string): void;
  querySelectorAll(selector: string): FakeElement[];
  remove(): void;
}

function makeElement(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    tagName: "",
    value: "",
    textContent: "",
    className: "",
    disabled: false,
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
    listeners: {},
    dataset: {},
    append(...nodes) {
      for (const n of nodes) n.parent = this;
      this.children.push(...nodes);
      // Mimic the real DOM's read-only, recursively-concatenated textContent
      // so tests can assert on rendered structure (e.g. a <ul>'s aggregate
      // text) the same way they'd assert on a real element.
      this.textContent = this.children.map((c) => c.textContent).join("");
    },
    appendChild(node) {
      node.parent = this;
      this.children.push(node);
      this.textContent = this.children.map((c) => c.textContent).join("");
      return node;
    },
    replaceChildren() {
      this.children = [];
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    focus() {},
    setAttribute(name, value) {
      if (name === "data-track") this.dataset.track = value;
      if (name === "data-mode") this.dataset.mode = value;
    },
    querySelectorAll(selector) {
      // Only the one selector shape the script actually uses:
      // article[data-track="<value>"]
      const match = selector.match(/data-track="([^"]+)"/);
      const track = match?.[1];
      return this.children.filter((c) => (track ? c.dataset.track === track : true));
    },
    remove() {
      const kids = this.parent?.children;
      if (kids) {
        const i = kids.indexOf(this);
        if (i >= 0) kids.splice(i, 1);
      }
    },
    ...overrides,
  };
}

// Extracts and runs the chat page's inline <script> against a fake DOM and a
// fake fetch, then submits the composer once. Returns the recorded fetch
// calls and the fake elements so callers can assert on the resulting DOM.
async function runChatSubmit(responseBody: unknown) {
  const match = renderChatPage("private").match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "expected an inline <script> in the chat page");
  const script = match[1];

  const elements: Record<string, FakeElement> = {
    status: makeElement(),
    answers: makeElement(),
    composer: makeElement(),
    message: makeElement({ value: "What room fits 30 students?" }),
    send: makeElement(),
    stop: makeElement({ disabled: true }),
    clear: makeElement(),
    export: makeElement(),
    schedule: makeElement({ hidden: true }),
    mic: makeElement(),
    modebar: makeElement(),
    modePrivate: makeElement(),
    modeOpenai: makeElement(),
    modenote: makeElement(),
    fbOpen: makeElement(),
    fbDialog: makeElement(),
    fbText: makeElement(),
    fbFile: makeElement(),
    fbPreview: makeElement({ hidden: true }),
    fbStatus: makeElement(),
    fbSend: makeElement(),
    fbCancel: makeElement(),
  };

  const fetchCalls: Array<[string, unknown]> = [];
  const documentElement = makeElement({ tagName: "html" });
  const localStorageStore: Record<string, string> = {};
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements[id],
      createElement: (tag: string) => makeElement({ tagName: tag }),
      createTextNode: (text: string) => makeElement({ tagName: "#text", textContent: text }),
      documentElement,
    },
    fetch: async (url: string, opts: unknown) => {
      fetchCalls.push([url, opts]);
      return { ok: true, json: async () => responseBody };
    },
    localStorage: {
      getItem: (k: string) => (Object.hasOwn(localStorageStore, k) ? localStorageStore[k] : null),
      setItem: (k: string, v: string) => {
        localStorageStore[k] = v;
      },
    },
    location: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  await elements.composer.listeners.submit({ preventDefault() {} });

  return { elements, fetchCalls };
}

test("login page posts to login and shows an error when given one", () => {
  const page = renderLoginPage();
  // Relative action: the page is served both at / (loopback) and under Caddy's
  // /advisor/ prefix, and a root-absolute "/login" would escape the prefix.
  assert.match(page, /<form[^>]+action="login"[^>]+method="post"/);
  assert.match(page, /type="password"/);
  assert.doesNotMatch(page, /Incorrect password/);
  assert.match(renderLoginPage("Incorrect password."), /Incorrect password\./);
});

// Live regions only announce changes detected AFTER they are in the
// accessibility tree, so both must be present and empty in the initial HTML.
test("both live regions are mounted empty in the initial markup", () => {
  const page = renderChatPage("private");
  assert.match(page, /id="status"[^>]*aria-live="polite"[^>]*><\/div>/);
  assert.match(page, /id="answers"[^>]*aria-live="polite"[^>]*><\/div>/);
});

// Buffer and gate: streaming prose (via EventSource, a WebSocket, or a
// polling loop) mutates the DOM dozens of times a second, which produces
// stutter or repeated re-reading in a screen reader. A blacklist of
// transport names can't express "do not stream" — a WebSocket token stream
// or a setInterval poll against /chat would pass a blacklist while
// reproducing the exact failure the pattern exists to prevent. So assert the
// positive invariant instead: the answer arrives in exactly one buffered
// request and is appended to #answers exactly once.
test("the client fetches chat once and appends the answer exactly once", async () => {
  const page = renderChatPage("private");
  // Relative URL — see the login-form note; it must keep the /advisor/ prefix.
  assert.match(page, /fetch\("chat"/);

  const { elements, fetchCalls } = await runChatSubmit({ text: "Room capacity is 30." });

  assert.equal(fetchCalls.length, 1, "expected exactly one request for the whole exchange");
  assert.equal(fetchCalls[0][0], "chat");

  // The echoed question plus exactly one assistant answer — never more.
  assert.equal(elements.answers.children.length, 2);
  const assistantArticles = elements.answers.children.filter((article) =>
    article.children.some((child) => child.textContent === "Advisor chat"),
  );
  assert.equal(assistantArticles.length, 1, "the answer must be appended exactly once");

  const answerParagraph = assistantArticles[0].children.find((child) => child.tagName === "p");
  assert.equal(answerParagraph?.textContent, "Room capacity is 30.");
});

// The agent's answer is untrusted Markdown-ish prose. It must be built as
// real DOM nodes (never innerHTML) so **bold**, bullets, and pipe tables
// render as structure instead of raw punctuation noise.
test("markdown in an agent answer renders as real elements, not raw syntax", async () => {
  const md =
    "Here is **the plan**:\n\n" +
    "- Meet advisor\n" +
    "- Register\n\n" +
    "| Course | Seats |\n" +
    "|---|---|\n" +
    "| CS101 | 30 |\n";
  const { elements } = await runChatSubmit({ text: md });

  const assistantArticle = elements.answers.children.find((article) =>
    article.children.some((child) => child.textContent === "Advisor chat"),
  );
  assert.ok(assistantArticle, "expected an assistant article");

  const para = assistantArticle!.children.find((c) => c.tagName === "p");
  assert.ok(para, "expected a paragraph for the intro line");
  const strong = para!.children.find((c) => c.tagName === "strong");
  assert.equal(strong?.textContent, "the plan", "**bold** must become a <strong>, not literal asterisks");
  assert.doesNotMatch(para!.textContent, /\*\*/, "no raw markdown syntax should leak into text nodes");

  const list = assistantArticle!.children.find((c) => c.tagName === "ul");
  assert.ok(list, "expected a <ul> for the bullet block");
  assert.equal(list!.children.length, 2);
  assert.equal(list!.children[0]?.textContent, "Meet advisor");

  const tableWrap = assistantArticle!.children.find((c) => c.className === "mdtable-wrap");
  assert.ok(tableWrap, "expected the table wrapped in a scrollable container");
  const table = tableWrap!.children.find((c) => c.tagName === "table");
  assert.ok(table, "expected a real <table>, not a literal pipe row");
});

// A plain answer with no markdown syntax at all must still collapse to a
// single <p> whose textContent is the whole line (existing test-compat
// contract), even when it happens to contain a blank line.
test("a markdown-free multi-line answer still yields plain text nodes", async () => {
  const text = "Room capacity is\n\n[Stopped — this answer is partial.]";
  const { elements } = await runChatSubmit({ text, outcome: "aborted" });
  const article = elements.answers.children.find((a) =>
    a.children.some((c) => c.tagName === "h2" && String(c.textContent).indexOf("Advisor chat") === 0),
  );
  const rendered = article!.children
    .filter((c) => c.tagName === "p")
    .map((c) => c.textContent)
    .join("");
  assert.equal(rendered, text, "no bold/list/table syntax means textContent must reflect the source exactly");
});

test("every control has an accessible name", () => {
  const page = renderChatPage("private");
  for (const id of ["send", "stop", "clear", "export", "message"]) {
    assert.match(
      page,
      new RegExp(`id="${id}"[^>]*(aria-label=|>)`),
      `${id} needs an accessible name`,
    );
  }
  assert.match(page, /<label[^>]+for="message"/);
});

// The stop control exists to reach the real, working /stop endpoint (Task 5)
// and the abort path through the Pi harness (Task 3). Its enabled state must
// be honest: disabled while there is nothing to abort.
test("the stop control is present and disabled at rest", () => {
  const page = renderChatPage("private");
  assert.match(
    page,
    /<button id="stop"[^>]*disabled[^>]*>[^<]*<\/button>/,
    "stop button must be disabled in the initial markup, before any turn is in flight",
  );
});

// AdvisorTurnResult's "aborted" outcome exists specifically so a partial
// answer is never mistaken for a finished one. The UI must carry that
// distinction through to what the advisor sees, not just what the server
// stuffed into the text field.
test("an aborted turn is not rendered as a complete answer", async () => {
  const { elements } = await runChatSubmit({
    text: "Room capacity is\n\n[Stopped — this answer is partial.]",
    outcome: "aborted",
  });

  const assistantArticle = elements.answers.children.find((article) =>
    article.children.some((child) => child.tagName === "h2"),
  );
  const heading = assistantArticle?.children.find((child) => child.tagName === "h2");

  assert.notEqual(
    heading?.textContent,
    "Advisor chat",
    "an aborted answer must not carry the same label as a completed one",
  );
  assert.notEqual(
    elements.status.textContent,
    "Response ready.",
    "the status region must not announce a stopped turn as a ready response",
  );
});

// Prose is the default. The document button is revealed only when the turn
// reported that the agent actually called propose_schedule and the host
// validated the result — never on an ordinary answer.
test("the schedule button stays hidden until a schedule has been proposed", async () => {
  const plain = await runChatSubmit({ text: "Room capacity is 30." });
  assert.equal(plain.elements.schedule!.hidden, true);

  const proposed = await runChatSubmit({ text: "Proposed.", schedule: true });
  assert.equal(proposed.elements.schedule!.hidden, false);
});

test("renderChatPage reflects the mode at first paint and links the cleaner", () => {
  const priv = renderChatPage("private");
  assert.match(priv, /data-mode="private"/);
  assert.match(priv, /Private/);
  assert.match(priv, /cleaner/);
  const oai = renderChatPage("openai");
  assert.match(oai, /data-mode="openai"/);
  assert.match(oai, /de-identified/i);
  assert.match(oai, /needsConsent/); // the consent handler is present in the script
});

// page() must place the mode attribute on <html> itself (not just a centered
// column) so the whole-page background can react to it.
test("page() emits the mode attribute on the <html> element", () => {
  const oai = renderChatPage("openai");
  assert.match(oai, /<html lang="en" data-mode="openai">/);
  const priv = renderChatPage("private");
  assert.match(priv, /<html lang="en" data-mode="private">/);
});

// Extracts and runs the chat page's inline <script>, then clicks #modeToggle
// once. Returns the fake elements/documentElement so tests can assert on the
// confirm-once gate and how far data-mode propagated.
async function runModeToggle(
  opts: {
    confirmReturns?: boolean;
    localStorageStore?: Record<string, string>;
    fetchMode?: string;
  } = {},
) {
  const match = renderChatPage("private").match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "expected an inline <script> in the chat page");
  const script = match[1];

  const elements: Record<string, FakeElement> = {
    status: makeElement(),
    answers: makeElement(),
    composer: makeElement(),
    message: makeElement({ value: "" }),
    send: makeElement(),
    stop: makeElement({ disabled: true }),
    clear: makeElement(),
    export: makeElement(),
    schedule: makeElement({ hidden: true }),
    mic: makeElement(),
    modebar: makeElement(),
    modePrivate: makeElement(),
    modeOpenai: makeElement(),
    modenote: makeElement(),
    fbOpen: makeElement(),
    fbDialog: makeElement(),
    fbText: makeElement(),
    fbFile: makeElement(),
    fbPreview: makeElement({ hidden: true }),
    fbStatus: makeElement(),
    fbSend: makeElement(),
    fbCancel: makeElement(),
  };

  const documentElement = makeElement({ tagName: "html" });
  const fetchCalls: Array<[string, unknown]> = [];
  const confirmCalls: string[] = [];
  const store = opts.localStorageStore ?? {};

  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements[id],
      createElement: (tag: string) => makeElement({ tagName: tag }),
      createTextNode: (text: string) => makeElement({ tagName: "#text", textContent: text }),
      documentElement,
    },
    fetch: async (url: string, reqOpts: unknown) => {
      fetchCalls.push([url, reqOpts]);
      return { ok: true, json: async () => ({ mode: opts.fetchMode ?? "openai" }) };
    },
    confirm: (msg: string) => {
      confirmCalls.push(msg);
      return opts.confirmReturns ?? true;
    },
    localStorage: {
      getItem: (k: string) => (Object.hasOwn(store, k) ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
    location: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  await elements.modeOpenai.listeners.click();

  return { elements, fetchCalls, confirmCalls, store, documentElement };
}

// The OpenAI-switch confirm() used to fire on every toggle. It should only
// interrupt the advisor the first time per browser; the persistent modebar
// warning is the standing reminder after that.
test("switching to OpenAI confirms once, remembers it, and sets data-mode on <html>", async () => {
  const store: Record<string, string> = {};
  const first = await runModeToggle({ confirmReturns: true, localStorageStore: store });

  assert.equal(first.confirmCalls.length, 1, "first switch to OpenAI must confirm");
  assert.equal(store["advisor.openaiAck"], "1", "OK must persist the acknowledgement");
  assert.equal(first.fetchCalls.length, 1, "an accepted confirm must proceed to switch modes");
  assert.equal(first.fetchCalls[0][0], "mode");
  assert.equal(
    first.documentElement.dataset.mode,
    "openai",
    "the whole page's data-mode must follow the switch, not just the modebar",
  );
});

test("cancelling the first-time OpenAI confirm does not switch and does not remember", async () => {
  const store: Record<string, string> = {};
  const cancelled = await runModeToggle({ confirmReturns: false, localStorageStore: store });

  assert.equal(cancelled.confirmCalls.length, 1);
  assert.equal(store["advisor.openaiAck"], undefined, "Cancel must not set the acknowledgement flag");
  assert.equal(cancelled.fetchCalls.length, 0, "cancelling at the confirm must not switch modes");
});

test("once acknowledged, later switches to OpenAI do not confirm again", async () => {
  const store: Record<string, string> = { "advisor.openaiAck": "1" };
  const again = await runModeToggle({ confirmReturns: true, localStorageStore: store });

  assert.equal(again.confirmCalls.length, 0, "already acknowledged in this browser — no dialog");
  assert.equal(again.fetchCalls.length, 1, "the switch itself still proceeds");
});

// The feedback modal is a new, self-contained addition; just confirm its
// entry points are present in the initial markup.
test("the feedback control and dialog are present in the chat page", () => {
  const page = renderChatPage("private");
  assert.match(page, /id="fbOpen"/);
  assert.match(page, /id="fbDialog"/);
});
