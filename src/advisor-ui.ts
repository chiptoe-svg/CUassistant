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
  #modebar { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap;
             padding:.6rem .8rem; border-radius:8px; margin-bottom:1rem; border:1px solid #8886; }
  #modebar[data-mode="private"] { background:#e6f4ee; border-color:#2f6f5e; }
  #modebar[data-mode="openai"]  { background:#fdf0e0; border-color:#c67b18; }
  @media (prefers-color-scheme: dark) {
    #modebar[data-mode="private"] { background:#12271f; }
    #modebar[data-mode="openai"]  { background:#2c2010; } }
  #modebar strong { font-weight:680; }
  #modebar .modenote { color:#595959; font-size:.9rem; }
  #modebar a.cleanerlink { margin-left:auto; }
  #answers[data-track="private"] article[data-track="openai"],
  #answers[data-track="openai"] article[data-track="private"] { display:none; }
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

export function renderChatPage(mode: "private" | "openai" = "private"): string {
  const priv = mode === "private";
  return page(
    "Advisor chat",
    `<h1>Advisor chat</h1>

<div id="modebar" data-mode="${mode}">
  <strong id="modelabel">${priv ? "Private mode" : "OpenAI mode"}</strong>
  <span class="modenote" id="modenote">${
    priv
      ? "Local, FERPA-approved models. Student information may be used."
      : "De-identified data only — do NOT enter student names, IDs, or grades."
  }</span>
  <button id="modeToggle" type="button">${
    priv ? "Switch to OpenAI mode" : "Switch to Private mode"
  }</button>
  <a class="cleanerlink" href="cleaner" target="_blank" rel="noopener">Clean a document ↗</a>
</div>

<p>Ask about schedules, room capacity, or GC requirements. Clear the session
when you move to another student.</p>

<div id="status" role="status" aria-live="polite"></div>
<div id="answers" data-track="${mode}" aria-live="polite" aria-atomic="false"></div>

<form id="composer">
  <label for="message">Your question</label>
  <textarea id="message" name="message" required></textarea>
  <button id="send" type="submit">Send</button>
  <button id="stop" type="button" disabled>Stop</button>
  <button id="clear" type="button">Clear session</button>
  <button id="export" type="button">Export chat history</button>
  <button id="schedule" type="button" hidden>Open proposed schedule</button>
</form>

<script>
const $ = (id) => document.getElementById(id);
const status = $("status"), answers = $("answers"), modebar = $("modebar");
let uiMode = ${JSON.stringify(mode)};

function addAnswer(role, text) {
  const art = document.createElement("article");
  art.dataset.track = uiMode;
  const h = document.createElement("h2");
  h.className = "role"; h.textContent = role;
  const p = document.createElement("p"); p.textContent = text;
  art.append(h, p); answers.append(art);
}

// POST a message; transparently handle the OpenAI PII 409. Returns the final
// Response (200) or null if the advisor cancelled at the consent prompt.
async function send(message, consent) {
  const r = await fetch("chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(consent ? { message, consent: true } : { message }),
  });
  if (r.status === 409) {
    const data = await r.json();
    if (data.needsConsent) {
      const cats = data.flags.map((f) => f.category + " (\\u201c" + f.sample + "\\u201d)").join(", ");
      const ok = confirm(
        "This looks like it may contain private information: " + cats + ".\\n\\n" +
        "OK = it is not private, send anyway.\\nCancel = go back and edit."
      );
      if (ok) return send(message, true);
      $("message").value = message;   // restore for editing; nothing was sent
      status.textContent = "Not sent \\u2014 edit and try again.";
      return null;
    }
  }
  return r;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("message").value.trim();
  if (!message) return;
  $("send").disabled = true; $("stop").disabled = false;
  status.textContent = "Checking the schedule\\u2026";
  try {
    const r = await send(message, false);
    if (!r) return;                      // cancelled at consent — leave text as-is
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "request failed");
    addAnswer("You", message);           // committed to sending; reflect it now
    $("message").value = "";
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
    $("send").disabled = false; $("stop").disabled = true; $("message").focus();
  }
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  status.textContent = "Stopping\\u2026";
  try {
    const r = await fetch("stop", { method: "POST" });
    const data = await r.json();
    status.textContent = data.stopped ? "Stop requested." : "Nothing to stop.";
  } catch (err) { status.textContent = "Could not stop."; }
});

$("clear").addEventListener("click", async () => {
  await fetch("clear", { method: "POST" });
  // Only the active track was cleared server-side; drop its messages from view.
  answers.querySelectorAll('article[data-track="' + uiMode + '"]').forEach((a) => a.remove());
  $("schedule").hidden = true;
  status.textContent = "Session cleared.";
  $("message").focus();
});

$("export").addEventListener("click", () => { location.href = "export"; });
$("schedule").addEventListener("click", () => { window.open("export/schedule", "_blank", "noopener"); });

$("modeToggle").addEventListener("click", async () => {
  const next = uiMode === "private" ? "openai" : "private";
  if (next === "openai") {
    const ok = confirm(
      "Switch to the OpenAI track?\\n\\nDe-identified data only \\u2014 do not enter " +
      "student names, IDs, or grades. Your Private conversation stays open on the " +
      "Private track."
    );
    if (!ok) return;
  }
  try {
    const r = await fetch("mode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "mode switch failed");
    uiMode = data.mode;
    const priv = uiMode === "private";
    modebar.setAttribute("data-mode", uiMode);
    answers.setAttribute("data-track", uiMode);   // show this track's messages, hide the other
    $("modelabel").textContent = priv ? "Private mode" : "OpenAI mode";
    $("modenote").textContent = priv
      ? "Local, FERPA-approved models. Student information may be used."
      : "De-identified data only \\u2014 do NOT enter student names, IDs, or grades.";
    $("modeToggle").textContent = priv ? "Switch to OpenAI mode" : "Switch to Private mode";
    $("schedule").hidden = true;
    status.textContent = "Now on the " + (priv ? "Private" : "OpenAI") + " track.";
  } catch (err) { status.textContent = "Could not switch mode."; }
});
</script>`,
  );
}
