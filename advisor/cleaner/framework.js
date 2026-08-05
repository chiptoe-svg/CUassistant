// Cleaner framework shell. Source-type agnostic: handles input (PDF via pdf.js,
// or pasted text), routes the raw text to the selected cleaner MODULE, and
// renders the module's sanitized output for review + copy/download. It owns NO
// extraction logic — each module does whitelist extraction. New cleaning duties
// plug in by adding a module to MODULES; the shell is untouched.
//
// Client-side only. The raw document is parsed here; only the sanitized module
// output ever leaves this tab, by copy or download.

import { degreeWorksModule } from "./modules/degree-works.js";
import { bannerScheduleModule } from "./modules/banner-schedule.js";
import { navigatorScheduleModule } from "./modules/navigator-schedule.js";

// pdf.js is loaded LAZILY, on the first PDF, not at module top level. A static
// import that throws (pdfjs 4.x needs a very recent browser, e.g.
// Promise.withResolvers) would kill this whole script before initModules()
// runs — leaving an empty module dropdown and a dead page. Deferring it keeps
// the registry, the module selector, and the paste-text path working even if
// PDF support is unavailable; a PDF load then fails on its own with a message.
let _pdfjs = null;
async function pdfjs() {
  if (!_pdfjs) {
    _pdfjs = await import("./vendor/pdfjs/pdf.mjs");
    _pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";
  }
  return _pdfjs;
}

const MODULES = [degreeWorksModule, bannerScheduleModule, navigatorScheduleModule]; // add a module object here to add a duty

const $ = (id) => document.getElementById(id);
const els = {
  moduleSelect: $("moduleSelect"), moduleDesc: $("moduleDesc"),
  pdfInput: $("pdfInput"), pasteInput: $("pasteInput"), cleanPaste: $("cleanPaste"),
  status: $("status"), messages: $("messages"), summary: $("summary"),
  output: $("output"), preview: $("preview"),
  copyButton: $("copyButton"), downloadButton: $("downloadButton"),
};
let current = null;

const activeModule = () => MODULES.find((m) => m.id === els.moduleSelect.value) ?? MODULES[0];

function initModules() {
  for (const m of MODULES) {
    const opt = document.createElement("option");
    opt.value = m.id; opt.textContent = m.label;
    els.moduleSelect.appendChild(opt);
  }
  syncModuleUi();
  els.moduleSelect.addEventListener("change", syncModuleUi);
}
function syncModuleUi() {
  const m = activeModule();
  els.moduleDesc.textContent = m.description;
  els.pdfInput.disabled = !m.accepts.includes("pdf");
  els.pasteInput.disabled = !m.accepts.includes("text");
  els.cleanPaste.disabled = !m.accepts.includes("text");
}

async function extractPdfText(buffer) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: buffer }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => "str" in it && it.str.trim())
      .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5], width: it.width ?? 0 }));
    lines.push(...groupIntoLines(items));
  }
  return lines.join("\n");
}
function groupIntoLines(items) {
  const rows = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find((r) => Math.abs(r.y - item.y) <= 2.5);
    if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  return rows.sort((a, b) => b.y - a.y)
    .map((r) => joinRow(r.items.sort((a, b) => a.x - b.x))).filter(Boolean);
}
function joinRow(items) {
  let prev = null, text = "";
  for (const it of items) {
    if (prev) text += it.x - (prev.x + prev.width) > 8 ? "  " : " ";
    text += it.text.trim(); prev = it;
  }
  return text.replace(/\s+/g, " ").trim();
}

function run(rawText, sourceLabel) {
  reset();
  try {
    const result = activeModule().clean(rawText);
    current = result;
    // The copyable output is readable Markdown (built by the module from its
    // whitelisted fields); fall back to JSON only if a module omits it.
    els.output.value =
      result.markdown ?? JSON.stringify(result.sanitized, null, 2);
    els.preview.value = result.preview;
    renderSummary(result.metrics);
    renderMessages(result.warnings, "warning");
    els.copyButton.disabled = false; els.downloadButton.disabled = false;
    els.status.textContent = `Cleaned ${sourceLabel}. Review before copying.`;
  } catch (err) {
    els.status.textContent = "Could not clean this input.";
    renderMessages([err instanceof Error ? err.message : String(err)], "error");
  }
}
function renderSummary(metrics) {
  els.summary.innerHTML = "";
  for (const m of metrics) {
    const div = document.createElement("div"); div.className = "metric";
    const span = document.createElement("span"); span.textContent = m.label;
    const strong = document.createElement("strong"); strong.textContent = m.value;
    div.append(span, strong); els.summary.appendChild(div);
  }
}
function renderMessages(list, kind) {
  els.messages.innerHTML = "";
  for (const text of list) {
    const div = document.createElement("div"); div.className = "message " + kind;
    div.textContent = text; els.messages.appendChild(div);
  }
}
function reset() {
  current = null; els.output.value = ""; els.preview.value = "";
  els.summary.innerHTML = ""; els.messages.innerHTML = "";
  els.copyButton.disabled = true; els.downloadButton.disabled = true;
}

els.pdfInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  els.status.textContent = "Reading PDF…";
  try { run(await extractPdfText(await file.arrayBuffer()), file.name); }
  catch (err) {
    els.status.textContent = "Could not read this PDF.";
    renderMessages([err instanceof Error ? err.message : String(err)], "error");
  }
});
els.cleanPaste.addEventListener("click", () => {
  const text = els.pasteInput.value.trim();
  if (!text) { els.status.textContent = "Paste some text first."; return; }
  run(text, "pasted text");
});
els.copyButton.addEventListener("click", async () => {
  if (!current) return;
  await navigator.clipboard.writeText(els.output.value);
  els.status.textContent = "Markdown copied.";
});
els.downloadButton.addEventListener("click", () => {
  if (!current) return;
  const blob = new Blob([els.output.value + "\n"], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = current.schema + ".md"; a.click();
  URL.revokeObjectURL(url);
});

initModules();
