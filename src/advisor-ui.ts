// HTML for the advisor chat, kept out of the server module so routing stays
// readable.
//
// Accessibility: buffer and gate (Title II / WCAG 2.1 AA). Streaming prose
// token-by-token mutates the DOM dozens of times a second, which produces
// either stutter or repeated re-reading in a screen reader. So a low-bandwidth
// STATUS region streams progress, and the ANSWER arrives once, complete.
// Both regions are in the initial markup and empty: a live region only
// announces changes detected after it is already in the accessibility tree.

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem;
         margin: 2rem auto; padding: 0 1rem; }
  #answers article { border-top: 1px solid #8888; padding: 1rem 0; }
  .role { font-weight: 600; }
  #status { min-height: 1.5rem; color: #595959; }
  label { display: block; font-weight: 600; margin-bottom: .25rem; }
  textarea { width: 100%; min-height: 5rem; font: inherit; padding: .5rem; }
  button { font: inherit; padding: .5rem 1rem; margin-right: .5rem; }
  :focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
`;

// The login error is the only place a string crosses into this page's markup.
// Callers are expected to pass fixed, server-authored text, but escaping here
// means a future caller that forwards something request-derived gets a broken
// message rather than reflected XSS.
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function page(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${STYLE}</style></head>
<body>${inner}</body></html>`;
}

export function renderLoginPage(error = ""): string {
  return page(
    "Advisor chat — sign in",
    `<h1>Advisor chat</h1>
${error ? `<p role="alert">${escHtml(error)}</p>` : ""}
<form action="login" method="post">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>`,
  );
}

export function renderChatPage(): string {
  return page(
    "Advisor chat",
    `<h1>Advisor chat</h1>
<p>Ask about schedules, room capacity, or GC requirements. Clear the session
when you move to another student.</p>

<div id="status" role="status" aria-live="polite"></div>
<div id="answers" aria-live="polite" aria-atomic="false"></div>

<form id="composer">
  <label for="message">Your question</label>
  <textarea id="message" name="message" required></textarea>
  <button id="send" type="submit">Send</button>
  <button id="stop" type="button" disabled>Stop</button>
  <button id="clear" type="button">Clear session</button>
  <button id="export" type="button">Export transcript</button>
  <button id="schedule" type="button" hidden>Open proposed schedule</button>
</form>

<script>
const $ = (id) => document.getElementById(id);
const status = $("status"), answers = $("answers");

function addAnswer(role, text) {
  const art = document.createElement("article");
  const h = document.createElement("h2");
  h.className = "role"; h.textContent = role;
  const p = document.createElement("p"); p.textContent = text;
  art.append(h, p); answers.append(art);
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("message").value.trim();
  if (!message) return;
  addAnswer("You", message);
  $("message").value = "";
  $("send").disabled = true;
  $("stop").disabled = false;   // a turn is now in flight — stop can reach it
  status.textContent = "Checking the schedule\\u2026";
  try {
    const r = await fetch("chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "request failed");
    // An aborted turn is a partial answer, not a finished one (Task 3). It
    // gets a distinct label and status so it is never mistaken for a
    // completed response.
    // Prose is the default. The document button appears only after the agent
    // has actually called propose_schedule and the host validated it.
    if (data.schedule) $("schedule").hidden = false;
    if (data.outcome === "aborted") {
      addAnswer("Advisor chat \\u2014 stopped", data.text);
      status.textContent = "Stopped.";
    } else {
      addAnswer("Advisor chat", data.text);
      status.textContent = "Response ready.";
    }
  } catch (err) {
    status.textContent = "Something went wrong. Please try again.";
  } finally {
    $("send").disabled = false;
    $("stop").disabled = true;
    $("message").focus();   // focus stays on input, never yanked to the answer
  }
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  status.textContent = "Stopping\\u2026";
  try {
    const r = await fetch("stop", { method: "POST" });
    const data = await r.json();
    status.textContent = data.stopped ? "Stop requested." : "Nothing to stop.";
  } catch (err) {
    status.textContent = "Could not stop.";
  }
});

$("clear").addEventListener("click", async () => {
  await fetch("clear", { method: "POST" });
  answers.replaceChildren();
  $("schedule").hidden = true;   // the old session's document is gone with it
  status.textContent = "Session cleared.";
  $("message").focus();
});

$("export").addEventListener("click", () => { location.href = "export"; });

$("schedule").addEventListener("click", () => {
  window.open("export/schedule", "_blank", "noopener");
});
</script>`,
  );
}
