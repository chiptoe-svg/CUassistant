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
  children: FakeElement[];
  listeners: Record<string, (...args: unknown[]) => unknown>;
  append(...nodes: FakeElement[]): void;
  replaceChildren(): void;
  addEventListener(type: string, handler: (...args: unknown[]) => unknown): void;
  focus(): void;
}

function makeElement(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    tagName: "",
    value: "",
    textContent: "",
    className: "",
    disabled: false,
    hidden: false,
    children: [],
    listeners: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren() {
      this.children = [];
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    focus() {},
    ...overrides,
  };
}

// Extracts and runs the chat page's inline <script> against a fake DOM and a
// fake fetch, then submits the composer once. Returns the recorded fetch
// calls and the fake elements so callers can assert on the resulting DOM.
async function runChatSubmit(responseBody: unknown) {
  const match = renderChatPage().match(/<script>([\s\S]*?)<\/script>/);
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
  };

  const fetchCalls: Array<[string, unknown]> = [];
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => elements[id],
      createElement: (tag: string) => makeElement({ tagName: tag }),
    },
    fetch: async (url: string, opts: unknown) => {
      fetchCalls.push([url, opts]);
      return { ok: true, json: async () => responseBody };
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
  const page = renderChatPage();
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
  const page = renderChatPage();
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

test("every control has an accessible name", () => {
  const page = renderChatPage();
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
  const page = renderChatPage();
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
