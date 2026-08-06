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
  .dots { display:inline-flex; gap:.35rem; padding:.35rem 0; }
  .dots span { width:.5rem; height:.5rem; border-radius:50%; background:#9a9a9a;
               animation:blink 1.2s infinite ease-in-out both; }
  .dots span:nth-child(2) { animation-delay:.2s; }
  .dots span:nth-child(3) { animation-delay:.4s; }
  @keyframes blink { 0%,80%,100% { opacity:.2; transform:scale(.7); }
                     40% { opacity:1; transform:scale(1); } }
  #answers ul, #answers ol { padding-left:1.4rem; }
  #answers table { border-collapse:collapse; width:100%; }
  #answers th, #answers td { border:1px solid #8886; padding:.35rem .6rem; text-align:left; }
  .mdtable-wrap { overflow-x:auto; }
  #answers iframe.artifact { width:100%; border:1px solid #8884; border-radius:8px;
    margin:.4rem 0 .2rem; background:#fff; }
  @media (prefers-color-scheme: dark) { #answers iframe.artifact { background:#1c2024; } }
  code { font-family: ui-monospace, monospace; background:#8882; padding:.1rem .3rem; border-radius:4px; }

  #status { flex:0 0 auto; min-height:1.25rem; padding:0 1.75rem; color:#595959; font-size:.9rem; }

  #composer { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:flex-end; gap:.6rem;
              padding:.9rem 1.75rem 1.1rem; border-top:1px solid #8886; }
  #composer label { flex-basis:100%; font-weight:600; margin-bottom:.25rem; }
  #composer textarea { flex:1 1 auto; min-width:10rem; min-height:6rem; max-height:12rem;
                        font:inherit; padding:.5rem; }
  #composerbtns { display:grid; grid-template-columns:auto auto; gap:.35rem; align-content:end; }
  #composerbtns button { font:inherit; font-size:.85rem; padding:.35rem .6rem; }
  #send { grid-column:1 / -1; font-weight:600; }
  #mic { font-size:1rem; line-height:1; }
  #mic.live { background:#d33; color:#fff; }

  :focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }

  #answers[data-track="private"] article[data-track="openai"],
  #answers[data-track="openai"] article[data-track="private"] { display:none; }
  /* Empty-state examples: middle-gray italic hints shown until the active
     track has a message. :has() scopes it per track so it returns after Clear
     and shows on a fresh track. */
  #examples { color:#888; font-style:italic; padding:1.5rem .25rem; max-width:44rem; }
  #examples .ex-lead { margin:0 0 .5rem; }
  #examples ul { list-style:none; padding:0; margin:0; }
  #examples li { padding:.3rem 0; border-bottom:1px solid #8881; }
  #examples li:last-child { border-bottom:0; }
  #answers[data-track="private"]:has(article[data-track="private"]) #examples,
  #answers[data-track="openai"]:has(article[data-track="openai"]) #examples { display:none; }
  /* Course-code links + hover card. The dotted underline signals "hover for
     info" without shouting; the card is a fixed-position popover on <body>. */
  a.course { color:inherit; cursor:help; text-decoration:underline;
             text-decoration-style:dotted; text-decoration-color:#3a7bd5;
             text-underline-offset:2px; }
  a.course:hover, a.course:focus { text-decoration-style:solid; outline:none; }
  #coursecard { position:fixed; z-index:50; max-width:22rem; max-height:15rem;
                overflow:auto; background:Canvas; color:CanvasText;
                border:1px solid #8886; border-radius:8px; padding:.55rem .7rem;
                box-shadow:0 6px 24px #0004; font-size:.9rem; line-height:1.4; }
  #coursecard .cc-head { font-size:.95rem; }
  #coursecard .cc-cr { color:#888; font-weight:400; }
  #coursecard .cc-title { font-weight:600; margin:.15rem 0 .35rem; }
  #coursecard .cc-desc { margin:0; }

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
<div id="answers" data-track="${mode}" aria-live="polite" aria-atomic="false">
  <div id="examples" aria-hidden="true">
    <p class="ex-lead">Not sure where to start? Try asking…</p>
    <ul>
      <li>Which sections of GC 3400 still have open seats this fall?</li>
      <li>What does the Graphic Communications major take in the sophomore year?</li>
      <li>Find 3-credit sections on Tue/Thu afternoons with at least 5 open seats.</li>
      <li>What are the requirements for the Business Administration minor?</li>
      <li>What are the conflicting sections of GC 4061 and GC 4401 this fall?</li>
    </ul>
  </div>
</div>

<form id="composer">
  <label for="message">Your question</label>
  <textarea id="message" name="message" required placeholder="Enter to send · Shift+Enter for newline · paste a class schedule (Advising Profile or Navigator) to auto-format it"></textarea>
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

// Course-code linkifier. Matches tokens like "GC 4061" (2-4 uppercase letters,
// an optional space, then exactly 4 digits) so they can carry a hover card. The
// (?!\\d) tail keeps 5-digit CRNs from matching, and a section suffix like
// "GC 4061-002" linkifies only the "GC 4061" part.
const COURSE_RE = /([A-Z]{2,4})[ \\u00a0]?(\\d{4})(?!\\d)/g;

// Appends a plain-text run to parent, wrapping any course codes in it as
// <a class="course" data-code="GC 4061"> links. Everything else is a text node,
// so this stays XSS-safe. Used everywhere a raw text run would be appended.
function appendText(parent, str) {
  COURSE_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = COURSE_RE.exec(str)) !== null) {
    const before = m.index === 0 ? "" : str.charAt(m.index - 1);
    if (before && /[A-Za-z0-9]/.test(before)) continue;   // mid-token, not a code
    if (m.index > last) parent.append(document.createTextNode(str.slice(last, m.index)));
    const a = document.createElement("a");
    a.className = "course";
    a.href = "#";
    a.dataset.code = m[1] + " " + m[2];   // normalized "SUBJ 1234" for lookup
    a.textContent = m[0];                 // display keeps the original spacing
    parent.append(a);
    last = m.index + m[0].length;
  }
  if (last < str.length) parent.append(document.createTextNode(str.slice(last)));
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
      appendText(parent, text.slice(i));
      return;
    }
    if (kind === "b") {
      const end = text.indexOf("**", idx + 2);
      if (end === -1) { appendText(parent, text.slice(i)); return; }
      if (idx > i) appendText(parent, text.slice(i, idx));
      const strong = document.createElement("strong");
      appendText(strong, text.slice(idx + 2, end));   // course codes link inside **bold** too
      parent.append(strong);
      i = end + 2;
    } else {
      const end = text.indexOf(BT, idx + 1);
      if (end === -1) { appendText(parent, text.slice(i)); return; }
      if (idx > i) appendText(parent, text.slice(i, idx));
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
    appendText(p, text);   // still linkifies course codes in an otherwise-plain answer
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

// True when the text contains a Markdown table (a "| … |" line immediately
// followed by a separator row) — the same shape renderMarkdown recognizes. Used
// to format a pasted/cleaned schedule in the user's own bubble instead of
// printing it as one flowing line of pipes.
function hasTable(text) {
  const lines = String(text).split("\\n").map((l) => l.trim());
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].charAt(0) === "|" && isSeparatorRow(lines[i + 1])) return true;
  }
  return false;
}

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
  } else if (hasTable(text)) {
    renderMarkdown(art, text);           // e.g. a /sched schedule — render the table, not raw pipes
  } else {
    const p = document.createElement("p");
    p.className = "msg";
    p.textContent = text;                // the advisor's own message — plain
    art.append(p);
  }
  answers.append(art);
  answers.scrollTop = answers.scrollHeight;   // keep the newest turn in view
  return art;
}

// Mount a host-rendered artifact as a SANDBOXED iframe. sandbox="" is maximally
// restricted (no scripts, no same-origin), so arbitrary HTML/CSS is safe. Content
// is set via setAttribute("srcdoc", …) — it runs only inside the isolated frame;
// the page itself never uses innerHTML.
function mountArtifact(container, artifact) {
  if (!artifact || !artifact.html) return;
  const frame = document.createElement("iframe");
  frame.className = "artifact";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("title", artifact.kind === "schedule" ? "Weekly schedule" : "Artifact");
  frame.setAttribute("srcdoc", artifact.html);
  if (artifact.height) frame.style.height = artifact.height + "px";
  container.appendChild(frame);
}

// An animated "typing" placeholder shown while the turn runs, so the UI never
// looks frozen. Replaced by the real answer (or removed on error/cancel).
function addThinking() {
  const art = document.createElement("article");
  art.dataset.track = uiMode;
  art.className = "agent thinking";
  const h = document.createElement("h2");
  h.className = "role"; h.textContent = "Advisor chat";
  const dots = document.createElement("div");
  dots.className = "dots";
  dots.append(
    document.createElement("span"),
    document.createElement("span"),
    document.createElement("span"),
  );
  art.append(h, dots);
  answers.append(art);
  answers.scrollTop = answers.scrollHeight;
  return art;
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
  // Format a pasted class schedule into a clean Markdown table using the SAME
  // parsers as the cleaner tab (exposed by the module script). An explicit /sched
  // forces formatting; otherwise a module must recognize the paste via detect().
  // Two formats are supported (Banner "Advising Profile" and Navigator). The first
  // submit expands in place for review; the next submit sends it. Done here so
  // Enter and the Send button behave identically.
  const mods = globalThis.__scheduleModules;
  if (mods && mods.length) {
    const slash = $("message").value.match(/^\\s*\\/sched\\b([\\s\\S]*)$/);
    const body = slash ? slash[1].replace(/^[ \\t]*\\r?\\n?/, "") : $("message").value;
    if (slash && !body.trim()) {
      status.textContent = "Paste a schedule after /sched, then press Send.";
      return;
    }
    for (const mod of mods) {
      if (!slash && !mod.detect(body)) continue;
      const cleaned = mod.clean(body);
      if (cleaned.sanitized.courses.length >= 1) {
        $("message").value = cleaned.markdown;
        status.textContent = "Schedule formatted \\u2014 review, then press Send.";
        $("message").focus();
        return;
      }
    }
  }
  const message = $("message").value.trim();
  if (!message) return;
  $("send").disabled = true; $("stop").disabled = false;
  // Optimistic: move the question into the pane and clear the box right away,
  // then show an animated "thinking" indicator so it never looks frozen.
  const you = addAnswer("You", message);
  $("message").value = "";
  const thinking = addThinking();
  status.textContent = "Thinking\\u2026";
  try {
    const r = await send(message, false);
    if (!r) {
      // Consent cancelled — roll back the optimistic echo and restore the text.
      thinking.remove();
      you.remove();
      $("message").value = message;
      return;
    }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "request failed");
    thinking.remove();
    if (data.schedule) $("schedule").hidden = false;
    if (data.outcome === "aborted") {
      addAnswer("Advisor chat \\u2014 stopped", data.text);
      status.textContent = "Stopped.";
    } else {
      const article = addAnswer("Advisor chat", data.text);
      if (data.artifact) mountArtifact(article, data.artifact);
      status.textContent = "Response ready.";
    }
  } catch (err) {
    thinking.remove();
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

// Voice dictation via ON-HOST Whisper. The mic records audio in the browser and
// posts the blob to /transcribe, which forwards it to OMLX's local Whisper — the
// audio stays on the machine, never a cloud STT (the browser's SpeechRecognition
// would stream to Google). Works in any browser with MediaRecorder.
const micOk = typeof navigator !== "undefined" && navigator.mediaDevices &&
  typeof MediaRecorder !== "undefined";
if (micOk) {
  let mediaRec = null, chunks = [], recording = false;
  const setMic = (on) => { recording = on; $("mic").classList.toggle("live", on); };
  $("mic").addEventListener("click", async () => {
    if (recording && mediaRec) { mediaRec.stop(); return; }   // second click stops
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (err) { status.textContent = "Microphone unavailable."; return; }
    chunks = [];
    mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setMic(false);
      const blob = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
      if (!blob.size) { status.textContent = "No audio recorded."; return; }
      status.textContent = "Transcribing\\u2026";
      try {
        const r = await fetch("transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "transcription failed");
        const t = (data.text || "").trim();
        if (t) { const el = $("message"); el.value = (el.value.trim() ? el.value.trim() + " " : "") + t; el.focus(); }
        status.textContent = t ? "Transcribed." : "No speech detected.";
      } catch (err) { status.textContent = "Could not transcribe."; }
    };
    mediaRec.start(); setMic(true);
    status.textContent = "Listening\\u2026 click the mic again to stop.";
  });
} else {
  $("mic").hidden = true;   // no MediaRecorder support in this browser
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

// ---- Course hover cards --------------------------------------------------
// Course codes in answers are linkified (a.course, data-code). Hovering or
// focusing one shows a small card with the catalog title, credits, and
// description \\u2014 fetched read-only from GET /course/<code> and cached per
// code. The card content comes from the catalog DB, never the model, and is
// inserted with textContent only (XSS-safe).
const courseCache = new Map();
let courseCard = null, courseHideTimer = null;

function ensureCourseCard() {
  if (courseCard) return courseCard;
  courseCard = document.createElement("div");
  courseCard.id = "coursecard";
  courseCard.hidden = true;
  courseCard.addEventListener("mouseenter", () => {
    if (courseHideTimer) { clearTimeout(courseHideTimer); courseHideTimer = null; }
  });
  courseCard.addEventListener("mouseleave", scheduleHideCard);
  document.body.append(courseCard);
  return courseCard;
}

function scheduleHideCard() {
  if (courseHideTimer) clearTimeout(courseHideTimer);
  courseHideTimer = setTimeout(() => { if (courseCard) courseCard.hidden = true; }, 150);
}

function positionCard(card, rect) {
  const gap = 6, margin = 12;
  card.style.top = (rect.bottom + gap) + "px";
  let left = rect.left;
  const maxLeft = document.documentElement.clientWidth - card.offsetWidth - margin;
  if (left > maxLeft) left = Math.max(margin, maxLeft);
  card.style.left = left + "px";
}

function fillCard(card, data) {
  card.replaceChildren();
  const head = document.createElement("div");
  head.className = "cc-head";
  const code = document.createElement("strong");
  code.textContent = data.code;
  head.append(code);
  const credits = data.credits && String(data.credits).trim();
  if (credits && credits !== "0") {   // 0-credit labs: skip the "0 cr" line
    const cr = document.createElement("span");
    cr.className = "cc-cr";
    cr.textContent = " \\u00b7 " + credits + " cr";
    head.append(cr);
  }
  card.append(head);
  if (data.title) {
    const t = document.createElement("div");
    t.className = "cc-title";
    t.textContent = data.title;
    card.append(t);
  }
  const d = document.createElement("p");
  d.className = "cc-desc";
  d.textContent = data.description || "No catalog description on file.";
  card.append(d);
}

function loadCourse(code) {
  if (courseCache.has(code)) return courseCache.get(code);
  const p = fetch("course/" + encodeURIComponent(code))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  courseCache.set(code, p);
  return p;
}

async function showCourseCard(link) {
  const code = link.dataset.code;
  if (!code) return;
  if (courseHideTimer) { clearTimeout(courseHideTimer); courseHideTimer = null; }
  const card = ensureCourseCard();
  card.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "cc-desc";
  loading.textContent = code + " \\u2026";
  card.append(loading);
  card.hidden = false;
  positionCard(card, link.getBoundingClientRect());
  const data = await loadCourse(code);
  if (card.hidden) return;                 // pointer already left before it loaded
  fillCard(card, data || { code: code, description: "No catalog entry found." });
  positionCard(card, link.getBoundingClientRect());
}

function courseLinkFrom(e) {
  return e.target && e.target.closest ? e.target.closest("a.course") : null;
}
answers.addEventListener("mouseover", (e) => { const l = courseLinkFrom(e); if (l) showCourseCard(l); });
answers.addEventListener("mouseout", (e) => { if (courseLinkFrom(e)) scheduleHideCard(); });
answers.addEventListener("focusin", (e) => { const l = courseLinkFrom(e); if (l) showCourseCard(l); });
answers.addEventListener("focusout", (e) => { if (courseLinkFrom(e)) scheduleHideCard(); });
answers.addEventListener("click", (e) => { const l = courseLinkFrom(e); if (l) { e.preventDefault(); showCourseCard(l); } });

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
</script>
<script type="module">
// Expose the cleaner tab's schedule parsers to the classic script so the composer
// shares ONE set of parsers (no drift). Each module has detect(text) + clean(text);
// the submit handler tries them in order. Two formats today (Banner "Advising
// Profile" and Navigator); add a module here to support another. The handler reads
// globalThis.__scheduleModules and does the expansion there, so Enter (via
// requestSubmit) and the Send button take the exact same path. This import runs
// after the classic script is parsed, which is fine: it only needs to be set
// before the user submits a schedule paste.
import { bannerScheduleModule } from "./cleaner/modules/banner-schedule.js";
import { navigatorScheduleModule } from "./cleaner/modules/navigator-schedule.js";
globalThis.__scheduleModules = [bannerScheduleModule, navigatorScheduleModule];
</script>`,
    ` data-mode="${mode}"`,
  );
}
