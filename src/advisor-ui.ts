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
  html, body { height: 100%; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif;
         display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  html[data-mode="openai"] { background: #ffe3b0; }
  @media (prefers-color-scheme: dark) {
    html[data-mode="openai"] { background: #2c1c04; }
  }

  #modebar { flex: 0 0 auto; display:flex; align-items:center; gap:.6rem; flex-wrap:wrap;
             padding:.5rem .9rem; border-bottom:1px solid #8886; }
  #modebar h1 { font-size:1rem; margin:0; font-weight:700; }
  #modebar[data-mode="private"] { background:#e6f4ee; border-color:#2f6f5e; }
  #modebar[data-mode="openai"]  { background:#f2a13d; border-color:#8a4c00; }
  @media (prefers-color-scheme: dark) {
    #modebar[data-mode="private"] { background:#12271f; }
    #modebar[data-mode="openai"]  { background:#6b4008; } }
  #modebar strong { font-weight:680; }
  #modebar .modenote { color:#595959; font-size:.85rem; }
  @media (prefers-color-scheme: dark) {
    #modebar .modenote { color:#c8c8c8; } }
  #modeswitch { margin-left:auto; display:inline-flex; border-radius:999px;
                overflow:hidden; border:2px solid #9999; flex:0 0 auto; }
  #modeswitch .seg { border:0; margin:0; padding:.4rem 1.15rem; font:inherit;
                     font-weight:700; font-size:.95rem; cursor:pointer;
                     background:transparent; color:#777; }
  #modePrivate[aria-pressed="true"] { background:#2f6f5e; color:#fff; }
  #modeOpenai[aria-pressed="true"]  { background:#d17b1e; color:#fff; }
  #modebar a.cleanerlink { margin-left:.85rem; font-size:.9rem; }

  #answers { flex:1 1 auto; overflow-y:auto; min-height:0; padding:1rem 1rem 0; }
  #answers article { max-width:46rem; margin:0 auto; padding:.15rem 0; }
  #answers article.agent { padding-bottom:.55rem; border-bottom:1px solid #8882; margin-bottom:.45rem; }
  .role { font-size:.66rem; font-weight:700; text-transform:uppercase;
          letter-spacing:.05em; color:#8a8a8a; margin:0 0 .1rem; }
  #answers p { margin:.3rem 0; }
  #answers article.you .msg { font-style:italic; color:#555; margin:.1rem 0 .3rem; }
  #answers ul, #answers ol { padding-left:1.4rem; }
  #answers table { border-collapse:collapse; width:100%; }
  #answers th, #answers td { border:1px solid #8886; padding:.35rem .6rem; text-align:left; }
  .mdtable-wrap { overflow-x:auto; max-width:46rem; margin:0 auto; }
  code { font-family: ui-monospace, monospace; background:#8882; padding:.1rem .3rem; border-radius:4px; }

  #status { flex:0 0 auto; min-height:1.25rem; padding:0 1rem; color:#595959; font-size:.9rem; }

  #composer { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:flex-end; gap:.5rem;
              padding:.75rem 1rem 1rem; border-top:1px solid #8886; }
  #composer label { flex-basis:100%; font-weight:600; margin-bottom:.25rem; }
  #composer textarea { flex:1 1 auto; min-width:12rem; min-height:2.75rem; max-height:8rem;
                        font:inherit; padding:.5rem; }
  #composer button { font:inherit; padding:.5rem 1rem; }

  :focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }

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

function page(title: string, inner: string, rootAttr = ""): string {
  return `<!DOCTYPE html>
<html lang="en"${rootAttr}><head><meta charset="utf-8">
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
    `<div id="modebar" data-mode="${mode}">
  <h1>Advisor chat</h1>
  <span class="modenote" id="modenote">${
    priv
      ? "Local, FERPA-approved models. Student information may be used."
      : "De-identified data only — do NOT enter student names, IDs, or grades."
  }</span>
  <div id="modeswitch" role="group" aria-label="Model mode">
    <button id="modePrivate" type="button" class="seg" aria-pressed="${priv ? "true" : "false"}">Private</button>
    <button id="modeOpenai" type="button" class="seg" aria-pressed="${priv ? "false" : "true"}">OpenAI</button>
  </div>
  <a class="cleanerlink" href="cleaner" target="_blank" rel="noopener">Clean a document ↗</a>
</div>

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

// ---- Minimal, XSS-safe Markdown rendering -------------------------------
// The model emits Markdown-ish prose. Answers are untrusted model output, so
// this builds DOM nodes with createElement/textContent only \\u2014 never
// innerHTML. Supports: paragraphs, -/* bullet lists, numbered lists,
// **bold**, \\u0060code\\u0060, and pipe tables. Plain text with none of that
// syntax renders as a single <p> (test-compat: textContent === the answer).

function isOrderedItem(line) {
  let j = 0;
  while (j < line.length && line[j] >= "0" && line[j] <= "9") j++;
  return j > 0 && line.slice(j, j + 2) === ". ";
}

function isSeparatorRow(line) {
  const t = line.trim();
  if (t.indexOf("|") === -1) return false;
  for (const ch of t) {
    if (ch !== "|" && ch !== "-" && ch !== ":" && ch !== " ") return false;
  }
  return true;
}

function hasMarkdown(text) {
  if (text.indexOf("**") !== -1) return true;
  if (text.indexOf(String.fromCharCode(96)) !== -1) return true;
  const lines = text.split("\\n");
  for (const raw of lines) {
    const l = raw.trim();
    if (l.slice(0, 2) === "- " || l.slice(0, 2) === "* ") return true;
    if (isOrderedItem(l)) return true;
    if (l.charAt(0) === "|" && l.indexOf("|", 1) !== -1) return true;
  }
  return false;
}

function splitBlocks(text) {
  const lines = text.split("\\n");
  const blocks = [];
  let cur = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (cur.length) { blocks.push(cur); cur = []; }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

// Appends **bold** and \\u0060code\\u0060 spans (and plain text runs) as
// child nodes of parent, using only createTextNode/createElement.
function appendInline(parent, text) {
  const BT = String.fromCharCode(96);
  let i = 0;
  while (i < text.length) {
    const b = text.indexOf("**", i);
    const c = text.indexOf(BT, i);
    let idx = -1, kind = null;
    if (b !== -1 && (c === -1 || b < c)) { idx = b; kind = "b"; }
    else if (c !== -1) { idx = c; kind = "c"; }
    if (idx === -1) {
      parent.append(document.createTextNode(text.slice(i)));
      return;
    }
    if (kind === "b") {
      const end = text.indexOf("**", idx + 2);
      if (end === -1) { parent.append(document.createTextNode(text.slice(i))); return; }
      if (idx > i) parent.append(document.createTextNode(text.slice(i, idx)));
      const strong = document.createElement("strong");
      strong.textContent = text.slice(idx + 2, end);
      parent.append(strong);
      i = end + 2;
    } else {
      const end = text.indexOf(BT, idx + 1);
      if (end === -1) { parent.append(document.createTextNode(text.slice(i))); return; }
      if (idx > i) parent.append(document.createTextNode(text.slice(i, idx)));
      const codeEl = document.createElement("code");
      codeEl.textContent = text.slice(idx + 1, end);
      parent.append(codeEl);
      i = end + 1;
    }
  }
}

function splitRow(line) {
  let t = line.trim();
  if (t.charAt(0) === "|") t = t.slice(1);
  if (t.charAt(t.length - 1) === "|") t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function renderTable(container, lines) {
  const wrap = document.createElement("div");
  wrap.className = "mdtable-wrap";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  splitRow(lines[0]).forEach((c) => {
    const th = document.createElement("th");
    appendInline(th, c);
    trh.append(th);
  });
  thead.append(trh);
  table.append(thead);
  const tbody = document.createElement("tbody");
  for (let i = 2; i < lines.length; i++) {
    const tr = document.createElement("tr");
    splitRow(lines[i]).forEach((c) => {
      const td = document.createElement("td");
      appendInline(td, c);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
}

function renderList(container, lines, ordered) {
  const list = document.createElement(ordered ? "ol" : "ul");
  lines.forEach((line) => {
    const li = document.createElement("li");
    let content;
    if (ordered) {
      let j = 0;
      while (j < line.length && line[j] >= "0" && line[j] <= "9") j++;
      content = line.slice(j + 2);
    } else {
      content = line.trim().slice(2);
    }
    appendInline(li, content.trim());
    list.append(li);
  });
  container.append(list);
}

function renderParagraph(container, lines) {
  const p = document.createElement("p");
  lines.forEach((line, idx) => {
    if (idx > 0) p.append(document.createElement("br"));
    appendInline(p, line);
  });
  container.append(p);
}

function renderMarkdown(container, text) {
  if (!hasMarkdown(text)) {
    const p = document.createElement("p");
    p.textContent = text;
    container.append(p);
    return;
  }
  splitBlocks(text).forEach((lines) => {
    const trimmed = lines.map((l) => l.trim());
    if (
      lines.length >= 2 &&
      trimmed[0].charAt(0) === "|" &&
      isSeparatorRow(trimmed[1])
    ) {
      renderTable(container, trimmed);
    } else if (trimmed.every((l) => l.slice(0, 2) === "- " || l.slice(0, 2) === "* ")) {
      renderList(container, trimmed, false);
    } else if (trimmed.every((l) => isOrderedItem(l))) {
      renderList(container, trimmed, true);
    } else {
      renderParagraph(container, lines);
    }
  });
}
// ---------------------------------------------------------------------------

function addAnswer(role, text) {
  const art = document.createElement("article");
  art.dataset.track = uiMode;
  const agent = role.indexOf("Advisor chat") === 0;
  art.className = agent ? "agent" : "you";
  const h = document.createElement("h2");
  h.className = "role"; h.textContent = role;
  art.append(h);
  if (agent) {
    renderMarkdown(art, text);           // agent output — markdown, XSS-safe
  } else {
    const p = document.createElement("p");
    p.className = "msg";
    p.textContent = text;                // the advisor's own message — plain
    art.append(p);
  }
  answers.append(art);
  answers.scrollTop = answers.scrollHeight;   // keep the newest turn in view
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

async function switchMode(next) {
  if (next === uiMode) return;                    // already there — no-op
  if (next === "openai" && !localStorage.getItem("advisor.openaiAck")) {
    const ok = confirm(
      "Switch to the OpenAI track?\\n\\nDe-identified data only \\u2014 do not enter " +
      "student names, IDs, or grades. Your Private conversation stays open on the " +
      "Private track."
    );
    if (!ok) return;
    localStorage.setItem("advisor.openaiAck", "1");
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
    document.documentElement.setAttribute("data-mode", uiMode);
    answers.setAttribute("data-track", uiMode);   // show this track's messages, hide the other
    $("modePrivate").setAttribute("aria-pressed", priv ? "true" : "false");
    $("modeOpenai").setAttribute("aria-pressed", priv ? "false" : "true");
    $("modenote").textContent = priv
      ? "Local, FERPA-approved models. Student information may be used."
      : "De-identified data only \\u2014 do NOT enter student names, IDs, or grades.";
    $("schedule").hidden = true;
    status.textContent = "Now on the " + (priv ? "Private" : "OpenAI") + " track.";
  } catch (err) { status.textContent = "Could not switch mode."; }
}
$("modePrivate").addEventListener("click", () => switchMode("private"));
$("modeOpenai").addEventListener("click", () => switchMode("openai"));
</script>`,
    ` data-mode="${mode}"`,
  );
}
