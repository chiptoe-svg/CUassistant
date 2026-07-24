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
             padding:.7rem 1.75rem; border-bottom:1px solid #8886; }
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

  #answers { flex:1 1 auto; overflow-y:auto; min-height:0; padding:1rem 1.75rem 0; }
  #answers article { padding:.15rem 0; }
  #answers article.you { margin-left:2.25rem; }
  #answers article.agent { padding-bottom:.6rem; border-bottom:1px solid #8882; margin-bottom:.5rem; }
  .role { font-size:.66rem; font-weight:700; text-transform:uppercase;
          letter-spacing:.05em; color:#8a8a8a; margin:0 0 .1rem; }
  #answers p { margin:.3rem 0; }
  #answers article.you .msg { font-style:italic; color:#555; margin:.1rem 0 .3rem; }
  #answers ul, #answers ol { padding-left:1.4rem; }
  #answers table { border-collapse:collapse; width:100%; }
  #answers th, #answers td { border:1px solid #8886; padding:.35rem .6rem; text-align:left; }
  .mdtable-wrap { overflow-x:auto; }
  code { font-family: ui-monospace, monospace; background:#8882; padding:.1rem .3rem; border-radius:4px; }

  #status { flex:0 0 auto; min-height:1.25rem; padding:0 1.75rem; color:#595959; font-size:.9rem; }

  #composer { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:flex-end; gap:.6rem;
              padding:.9rem 1.75rem 1.1rem; border-top:1px solid #8886; }
  #composer label { flex-basis:100%; font-weight:600; margin-bottom:.25rem; }
  #composer textarea { flex:1 1 auto; min-width:10rem; min-height:2.75rem; max-height:8rem;
                        font:inherit; padding:.5rem; }
  #composerbtns { display:grid; grid-template-columns:auto auto; gap:.35rem; align-content:end; }
  #composerbtns button { font:inherit; font-size:.85rem; padding:.35rem .6rem; }
  #send { grid-column:1 / -1; font-weight:600; }
  #mic { font-size:1rem; line-height:1; }
  #mic.live { background:#d33; color:#fff; }

  :focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }

  #answers[data-track="private"] article[data-track="openai"],
  #answers[data-track="openai"] article[data-track="private"] { display:none; }

  #fbDialog { width:min(34rem, 92vw); border:1px solid #8886; border-radius:10px;
              padding:1.25rem 1.4rem; color:inherit; }
  #fbDialog::backdrop { background:rgba(0,0,0,.4); }
  #fbDialog h2 { margin:0 0 .5rem; font-size:1.15rem; }
  #fbDialog label { display:block; font-weight:600; margin:.7rem 0 .25rem; }
  #fbText { width:100%; min-height:6rem; font:inherit; padding:.5rem; box-sizing:border-box; }
  #fbDialog .fbnote { color:#777; font-size:.85rem; margin:.5rem 0; }
  #fbPreview { display:block; max-width:100%; max-height:9rem; margin:.5rem 0;
               border:1px solid #8886; border-radius:6px; }
  #fbPreview[hidden] { display:none; }
  #fbStatus { min-height:1.2rem; color:#595959; font-size:.9rem; margin:.4rem 0; }
  #fbSend, #fbCancel { font:inherit; padding:.45rem 1rem; margin-right:.5rem; margin-top:.4rem; }
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
      ? "Clemson-hosted AI models — your data stays on Clemson systems."
      : "De-identified data only — do NOT enter student names, IDs, or grades."
  }</span>
  <div id="modeswitch" role="group" aria-label="Model mode">
    <button id="modePrivate" type="button" class="seg" aria-pressed="${priv ? "true" : "false"}">Private</button>
    <button id="modeOpenai" type="button" class="seg" aria-pressed="${priv ? "false" : "true"}">OpenAI</button>
  </div>
  <a class="cleanerlink" href="cleaner/" target="_blank" rel="noopener">Clean a document ↗</a>
  <button id="fbOpen" class="cleanerlink" type="button">Feedback</button>
</div>

<div id="status" role="status" aria-live="polite"></div>
<div id="answers" data-track="${mode}" aria-live="polite" aria-atomic="false"></div>

<form id="composer">
  <label for="message">Your question</label>
  <textarea id="message" name="message" required placeholder="Enter to send · Shift+Enter for a new line"></textarea>
  <div id="composerbtns">
    <button id="send" type="submit">Send</button>
    <button id="mic" type="button" aria-label="Dictate your question" title="Dictate">🎙</button>
    <button id="stop" type="button" disabled>Stop</button>
    <button id="clear" type="button" title="Clear session">Clear</button>
    <button id="export" type="button" title="Export chat history">Export</button>
    <button id="schedule" type="button" hidden>Open proposed schedule</button>
  </div>
</form>

<dialog id="fbDialog">
  <h2>Request a feature or report an issue</h2>
  <label for="fbText">What's on your mind?</label>
  <textarea id="fbText" required></textarea>
  <p class="fbnote">Screenshots stay on this server — they are never sent
  anywhere else. Please avoid including student names or IDs.</p>
  <label for="fbFile">Attach a screenshot (optional)</label>
  <input id="fbFile" type="file" accept="image/*">
  <img id="fbPreview" alt="Screenshot preview" hidden>
  <div id="fbStatus" role="status" aria-live="polite"></div>
  <button id="fbSend" type="button">Send</button>
  <button id="fbCancel" type="button">Cancel</button>
</dialog>

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

// Enter sends; Shift+Enter inserts a newline — the expected chat behavior.
$("message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});

// Voice dictation. The browser's SpeechRecognition transcribes into the box.
// NOTE: in Chrome this streams audio to Google for transcription — same as the
// curriculum tool's voice input. Hidden entirely where the API is absent.
const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
if (SR) {
  let rec = null, live = false;
  const stopMic = () => { live = false; $("mic").classList.remove("live"); };
  $("mic").addEventListener("click", () => {
    if (live && rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = "en-US"; rec.interimResults = false;
    rec.onresult = (ev) => {
      const t = Array.from(ev.results).map((r) => r[0].transcript).join(" ").trim();
      const el = $("message");
      el.value = (el.value.trim() ? el.value.trim() + " " : "") + t;
      el.focus();
    };
    rec.onend = stopMic; rec.onerror = stopMic;
    live = true; $("mic").classList.add("live"); rec.start();
  });
} else {
  $("mic").hidden = true;   // no speech support in this browser
}

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
      ? "Clemson-hosted AI models — your data stays on Clemson systems."
      : "De-identified data only \\u2014 do NOT enter student names, IDs, or grades.";
    $("schedule").hidden = true;
    status.textContent = "Now on the " + (priv ? "Private" : "OpenAI") + " track.";
  } catch (err) { status.textContent = "Could not switch mode."; }
}
$("modePrivate").addEventListener("click", () => switchMode("private"));
$("modeOpenai").addEventListener("click", () => switchMode("openai"));

// ---- Feature request / feedback -----------------------------------------
// Local-only: the screenshot never leaves this server (see POST /feedback).
// Downscaled through a canvas before it is stored, so a full-resolution
// phone photo does not blow up the request body.

const fbDialog = $("fbDialog"), fbText = $("fbText"), fbFile = $("fbFile"),
      fbPreview = $("fbPreview"), fbStatus = $("fbStatus"),
      fbSend = $("fbSend"), fbCancel = $("fbCancel");
let fbScreenshot = null;

async function downscaleToDataUrl(blob) {
  const bitmap = await createImageBitmap(blob);
  const max = 1800;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function attachImage(blob) {
  try {
    fbScreenshot = await downscaleToDataUrl(blob);
    fbPreview.src = fbScreenshot;
    fbPreview.hidden = false;
  } catch (err) {
    fbStatus.textContent = "Could not attach that image \\u2014 you can still send text.";
  }
}

function resetFeedbackForm() {
  fbText.value = "";
  fbFile.value = "";
  fbPreview.hidden = true;
  fbPreview.src = "";
  fbScreenshot = null;
  fbStatus.textContent = "";
}

$("fbOpen").addEventListener("click", () => {
  fbStatus.textContent = "";
  fbDialog.showModal();
});

fbFile.addEventListener("change", () => {
  const file = fbFile.files && fbFile.files[0];
  if (file) attachImage(file);
});

fbDialog.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.indexOf("image/") === 0) {
      const blob = item.getAsFile();
      if (blob) attachImage(blob);
      break;
    }
  }
});

fbSend.addEventListener("click", async () => {
  const description = fbText.value.trim();
  if (!description) {
    fbStatus.textContent = "Please describe the issue or request first.";
    return;
  }
  fbStatus.textContent = "Sending\\u2026";
  try {
    const r = await fetch("feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, screenshot: fbScreenshot }),
    });
    const data = await r.json();
    if (r.ok && data.saved) {
      fbStatus.textContent = "Thanks \\u2014 sent.";
      setTimeout(() => {
        resetFeedbackForm();
        fbDialog.close();
      }, 800);
    } else {
      fbStatus.textContent = "Could not send \\u2014 try again.";
    }
  } catch (err) {
    fbStatus.textContent = "Could not send \\u2014 try again.";
  }
});

fbCancel.addEventListener("click", () => {
  resetFeedbackForm();
  fbDialog.close();
});
</script>`,
    ` data-mode="${mode}"`,
  );
}
