import assert from "node:assert/strict";
import test from "node:test";

import { renderChatPage, renderLoginPage } from "../src/advisor-ui.ts";

test("login page posts to /login and shows an error when given one", () => {
  const page = renderLoginPage();
  assert.match(page, /<form[^>]+action="\/login"[^>]+method="post"/);
  assert.match(page, /type="password"/);
  assert.doesNotMatch(page, /Incorrect password/);
  assert.match(renderLoginPage("Incorrect password."), /Incorrect password\./);
});

// Live regions only announce changes detected AFTER they are in the
// accessibility tree, so both must be present and empty in the initial HTML.
test("both live regions are mounted empty in the initial markup", () => {
  const page = renderChatPage();
  assert.match(page, /id="status"[^>]*aria-live="polite"[^>]*><\/div>/);
  assert.match(page, /id="answers"[^>]*aria-live="polite"[^>]*>/);
});

// Buffer and gate: streaming prose mutates the DOM dozens of times a second,
// which screen readers were never designed for.
test("the client fetches /chat once and does not stream tokens", () => {
  const page = renderChatPage();
  assert.match(page, /fetch\("\/chat"/);
  assert.doesNotMatch(page, /EventSource|ReadableStream|text\/event-stream/);
});

test("every control has an accessible name", () => {
  const page = renderChatPage();
  for (const id of ["send", "clear", "export", "message"]) {
    assert.match(
      page,
      new RegExp(`id="${id}"[^>]*(aria-label=|>)`),
      `${id} needs an accessible name`,
    );
  }
  assert.match(page, /<label[^>]+for="message"/);
});
