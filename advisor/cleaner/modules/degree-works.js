// Degree Works cleaner module. PURE: string in, sanitized data out. No DOM, no
// pdf.js — the framework extracts text from the PDF/paste and hands it here.
//
// Whitelist extraction: the output is BUILT from named safe fields
// (code/title/term/credits/status), so names, student IDs, GPA, advisor, and
// grades cannot appear in it by construction. This is the load-bearing privacy
// property of the cleaner.

export const degreeWorksModule = {
  id: "degree-works",
  label: "Degree Works audit",
  description:
    "Clemson Degree Works PDF → sanitized gc-course-ledger-v1 (drops name, ID, GPA, advisor, and grades).",
  accepts: ["pdf", "text"],
  clean(rawText) {
    const text = String(rawText || "");
    // The parser reads line.text only; the framework already flattened the PDF
    // (or the pasted text) to newline-joined lines, so re-wrapping is enough.
    const lines = text.split("\n").map((t) => ({ text: t }));
    const cleanLines = removePrivateLines(lines);
    const { progress, warnings } = parseDegreeWorks(cleanLines, text, "");
    const completed = progress.courses.filter((c) => c.status === "completed").length;
    const inProgress = progress.courses.filter((c) => c.status === "in_progress").length;
    const ledger = makeCourseLedger(progress);
    return {
      schema: "gc-course-ledger-v1",
      sanitized: ledger,
      markdown: ledgerToMarkdown(ledger),
      warnings,
      metrics: [
        { label: "Catalog year", value: progress.catalogYear ?? "—" },
        { label: "Completed", value: String(completed) },
        { label: "In progress", value: String(inProgress) },
        { label: "Excess", value: String(progress.excessElectives.length) },
        { label: "Still needed", value: String(progress.requirementsRemaining.length) },
      ],
      preview: cleanLines.map((l) => l.text).join("\n"),
    };
  },
};

// ---------------------------------------------------------------------------
// The functions below are relocated verbatim (unchanged) from the uploaded
// Degree Works Cleaner prototype's <script> block (lines 415-932 of
// 22b70cde-index.html). They are pure string -> data helpers with no DOM or
// pdf.js dependency. PDF-extraction functions (extractPdfPages,
// groupIntoLines, joinRowText) and DOM code were intentionally left behind —
// those belong to the browser framework (Task 8).
// ---------------------------------------------------------------------------

function parseDegreeWorks(lines, rawText, fileName) {
  const cleanText = lines.map((line) => line.text).join("\n");
  const catalogYear = firstMatch(cleanText, /Catalog year:\s*(\d{4}-\d{4})/);
  const major = firstMatch(cleanText, /Major\s+(.+?)\s+Minor\s+/);
  const programRaw = firstMatch(cleanText, /Program\s+(.+?)\s+College\s+/);
  const degree = firstMatch(cleanText, /Degree\s+(Bachelor of Science)/);
  const degreeCredits = firstMatchGroups(
    cleanText,
    /Credits required:\s*(\d+)\s+Credits applied:\s*(\d+)\s+Catalog year:\s*(\d{4}-\d{4})/
  );

  const allRows = extractCourseRows(lines);
  const courses = dedupeCourses(
    allRows
      .filter((row) => row.section !== "Insufficient")
      .filter((row) => row.section !== "Excess Electives")
      .map(toPublicCourse)
  );
  const excessElectives = dedupeCourses(
    allRows
      .filter((row) => row.section === "Excess Electives")
      .map(toPublicCourse)
  );
  const minors = extractMinors(cleanText);
  const requirementsRemaining = extractStillNeeded(lines);

  const warnings = buildWarnings(rawText, cleanText, {
    catalogYear,
    courses
  });

  return {
    progress: {
      schema: "gc-progress-v1",
      catalogYear,
      degree,
      programName: normalizeProgram(programRaw),
      major: normalizeMajor(major),
      minors,
      creditsRequired: degreeCredits ? Number(degreeCredits[0]) : null,
      creditsApplied: degreeCredits ? Number(degreeCredits[1]) : null,
      courses,
      excessElectives,
      requirementsRemaining,
      blockStatuses: extractBlockStatuses(lines)
    },
    warnings
  };
}

function extractCourseRows(lines) {
  const rows = [];
  let section = "Degree Audit";
  let block = "Degree";
  let inProgressTable = false;
  let insufficientTable = false;
  let pendingRequirement = null;

  for (const line of lines) {
    const text = normalizeSpaces(line.text);

    const blockHeader = parseBlockHeader(text);
    if (blockHeader) {
      block = blockHeader.label;
      pendingRequirement = null;
      continue;
    }

    const sectionHeader = parseSectionHeader(text);
    if (sectionHeader) {
      section = sectionHeader;
      inProgressTable = /^In-progress/.test(text);
      insufficientTable = text === "Insufficient";
      pendingRequirement = null;
      continue;
    }

    if (/^Course\s+Title\s+Grade\s+Credits\s+Term/.test(text)) {
      continue;
    }

    if (isPrivateLine(text) || isNonCourseLine(text)) {
      continue;
    }

    const standaloneRequirement = parseUnmetRequirementLabel(text);
    if (standaloneRequirement) {
      pendingRequirement = mergeRequirementLabel(pendingRequirement, standaloneRequirement.label);
    }

    const row = parseCourseLine(text, pendingRequirement);
    if (!row) continue;

    row.section = insufficientTable ? "Insufficient" : section;
    row.block = block;

    if (inProgressTable) {
      row.status = "in_progress";
    }

    rows.push(row);

    if (row.requirement) {
      pendingRequirement = row.requirement;
    }
  }

  return rows;
}

function parseCourseLine(text, fallbackRequirement = null) {
  const termPattern = "(Spring|Summer|Fall)\\s+(\\d{4})";
  const codePattern = "\\b([A-Z]{2,5})\\s+(\\d{4})\\b";
  const match = text.match(new RegExp(`${codePattern}([\\s\\S]*?)\\s+(\\(?\\d+(?:\\.\\d+)?\\)?)\\s+${termPattern}\\b`));
  if (!match) return null;

  const beforeCode = text.slice(0, match.index).trim();
  if (beforeCode.startsWith("Still needed:")) return null;
  if (/^(GENERAL EDUCATION|GRAPHIC COMMUNICATION TECHNICAL REQUIREMENT|SPECIALTY AREA REQUIREMENT)/.test(beforeCode) && !match[3].trim()) {
    return null;
  }

  const betweenCodeAndCredits = normalizeSpaces(match[3]);
  const gradeLikeToken = lastToken(betweenCodeAndCredits);
  const status = gradeLikeToken === "IP" ? "in_progress" : "completed";
  const title = stripTrailingGradeToken(betweenCodeAndCredits);
  const credits = Number(match[4].replace(/[()]/g, ""));

  if (!Number.isFinite(credits)) return null;

  return {
    code: `${match[1]} ${match[2]}`,
    title,
    credits,
    term: `${match[5]} ${match[6]}`,
    status,
    requirement: parseRequirementLabel(beforeCode) ?? fallbackRequirement
  };
}

function extractStillNeeded(lines) {
  const needed = [];
  let block = "Degree";
  let pendingRequirement = null;

  for (let index = 0; index < lines.length; index += 1) {
    const text = normalizeSpaces(lines[index].text);
    const blockHeader = parseBlockHeader(text);
    if (blockHeader) {
      block = blockHeader.label;
      pendingRequirement = null;
      continue;
    }

    if (parseSectionHeader(text)) {
      pendingRequirement = null;
      continue;
    }

    const match = text.match(/Still needed:\s*(.+)$/);
    if (!match) {
      const label = parseUnmetRequirementLabel(text);
      if (label) {
        pendingRequirement = {
          ...label,
          label: mergeRequirementLabel(pendingRequirement?.label ?? null, label.label)
        };
      }
      continue;
    }

    const value = match[1].trim();
    if (!value || value.includes("FINAL GRADES")) continue;

    const inlineLabel = parseUnmetRequirementLabel(text.split("Still needed:")[0]);
    const requirement = inlineLabel ?? pendingRequirement;
    if (!requirement) continue;

    needed.push({
      block,
      requirement: requirement.label,
      credits: requirement.credits,
      needed: value,
      candidateCourses: summarizeCandidateCourses(extractCourseCodes(value), value),
      candidateCoursesAbbreviated: extractCourseCodes(value).length > 2,
      truncatedOptions: isTruncatedNeededText(value),
      confidence: requirementConfidence(value)
    });
  }

  return dedupeObjects(needed, (item) => `${item.block}|${item.requirement}|${item.needed}`);
}

function extractMinors(text) {
  const minors = [];
  const headerMinor = firstMatch(text, /Minor\s+(.+?)\s+Program\s+/);
  if (headerMinor) {
    minors.push({ name: headerMinor, status: null });
  }

  const minorBlocks = [...text.matchAll(/Minor in ([^\n]+?)\s+(COMPLETE|INCOMPLETE)/g)]
    .map((match) => ({
      name: match[1].trim(),
      status: match[2].toLowerCase()
    }));

  for (const minor of minorBlocks) {
    const existing = minors.find((item) => item.name === minor.name);
    if (existing) {
      existing.status = minor.status;
    } else {
      minors.push(minor);
    }
  }

  return minors;
}

function extractBlockStatuses(lines) {
  const statuses = [];
  const blockPattern = /^(.{3,80}?)\s+(COMPLETE|INCOMPLETE)$/;

  for (const line of lines) {
    const text = normalizeSpaces(line.text);
    const match = text.match(blockPattern);
    if (!match) continue;
    if (/Clemson University|Degree Works|Legend/.test(text)) continue;

    statuses.push({
      label: match[1].trim(),
      status: match[2].toLowerCase()
    });
  }

  return dedupeObjects(statuses, (item) => `${item.label}|${item.status}`);
}

function removePrivateLines(lines) {
  return lines
    .map((line) => ({ ...line, text: redactPrivateTokens(line.text) }))
    .filter((line) => line.text && !isPrivateLine(line.text));
}

function redactPrivateTokens(text) {
  return normalizeSpaces(text)
    .replace(/\bC\d{8}\b/g, "[student-id-removed]")
    .replace(/\b\d\.\d{2,3}\b/g, (value, offset, full) => {
      const window = full.slice(Math.max(0, offset - 24), offset + 24);
      return /GPA/i.test(window) ? "[gpa-removed]" : value;
    });
}

function isPrivateLine(text) {
  return /Student name|Student ID|Overall GPA|Advisor\b|Academic Standing/i.test(text)
    || /^Clemson University\s+.+\[student-id-removed\]/.test(text)
    || /^Level Undergraduate\b/.test(text);
}

function isNonCourseLine(text) {
  return !text
    || /^Satisfied by:/.test(text)
    || /^NOTE:/.test(text)
    || /^Credits required:/.test(text)
    || /^Catalog year:/.test(text)
    || /^Blocks included/.test(text)
    || /^Legend$/.test(text)
    || /^Disclaimer$/.test(text)
    || /^Ellucian Degree Works/.test(text)
    || /^SC REACH Act/.test(text)
    || /^A student may select/.test(text)
    || /^Unmet conditions/.test(text)
    || /^Prerequisite\b/.test(text)
    || /^Complete\b/.test(text)
    || /^Not complete\b/.test(text)
    || /^Nearly complete/.test(text);
}

function parseSectionHeader(text) {
  const direct = [
    "Excess Electives",
    "Insufficient",
    "In-progress",
    "In-progress and Preregistered"
  ].find((header) => text === header || text.startsWith(`${header} Credits applied:`));
  return direct ?? null;
}

function buildWarnings(rawText, cleanText, parsed) {
  const warnings = [];
  if (/\bC\d{8}\b/.test(rawText)) {
    warnings.push("Student ID-like values were detected in the PDF text layer and removed from the preview/output.");
  }
  if (/Student name|Overall GPA|Advisor\b/i.test(rawText)) {
    warnings.push("Private header fields were detected and dropped from the output.");
  }
  if (!parsed.catalogYear) {
    warnings.push("Catalog year was not found. Add it manually before using the advising tools.");
  }
  if (parsed.courses.filter((course) => course.status === "completed").length === 0) {
    warnings.push("No completed courses were detected. Review the plain text preview and parser rules.");
  }
  if (/\b(?:A|B|C|D|F|P|TR|EC|IP|NCT)\b/.test(cleanText)) {
    warnings.push("Grade/status tokens may still appear in the preview for review, but they are not included in the sanitized JSON course objects.");
  }
  warnings.push("Remaining requirements preserve Degree Works candidates when visible, but gc_advisor/catalog tools are mandatory for authoritative requirement resolution.");
  return warnings;
}

function toPublicCourse(row) {
  return {
    code: row.code,
    title: row.title,
    term: row.term,
    credits: row.credits,
    status: row.status,
    appliesTo: row.requirement && !isInvalidRequirementLabel(row.requirement) ? [{
      block: row.block,
      requirement: row.requirement
    }] : []
  };
}

function makeCourseLedger(progress) {
  const courses = dedupeCourses([
    ...progress.courses,
    ...progress.excessElectives
  ]).map(({ code, title, term, credits, status }) => ({
    code,
    prefix: code.split(" ")[0] ?? null,
    number: code.split(" ")[1] ?? null,
    title,
    term,
    credits,
    status
  }));

  return {
    schema: "gc-course-ledger-v1",
    catalogYear: progress.catalogYear,
    degree: progress.degree,
    programName: progress.programName,
    major: progress.major,
    minors: progress.minors,
    creditsRequired: progress.creditsRequired,
    creditsApplied: progress.creditsApplied,
    courses
  };
}

// Render the sanitized ledger as a readable Markdown document. Built ONLY from
// the whitelisted ledger fields (never the raw preview), so the privacy property
// is preserved: names, IDs, GPA, and grades cannot reach this output.
function ledgerToMarkdown(ledger) {
  const title = ledger.programName || ledger.major || "Degree Works";
  const parts = [`# ${title}${ledger.degree ? ` (${ledger.degree})` : ""}`];

  const meta = [];
  if (ledger.catalogYear) meta.push(`Catalog year ${ledger.catalogYear}`);
  if (ledger.creditsApplied != null || ledger.creditsRequired != null) {
    meta.push(
      `Credits applied ${ledger.creditsApplied ?? "?"}/${ledger.creditsRequired ?? "?"}`,
    );
  }
  if (Array.isArray(ledger.minors) && ledger.minors.length) {
    meta.push(
      `Minor: ${ledger.minors.map((m) => (m.status ? `${m.name} (${m.status})` : m.name)).join(", ")}`,
    );
  }
  if (meta.length) parts.push(meta.join(" · "));

  const courses = Array.isArray(ledger.courses) ? ledger.courses : [];
  if (courses.length === 0) {
    parts.push("\n_No courses parsed._");
  } else {
    parts.push(
      "",
      "| Code | Title | Term | Cr | Status |",
      "| --- | --- | --- | --- | --- |",
      ...courses.map(
        (c) =>
          `| ${mdCell(c.code)} | ${mdCell(c.title)} | ${mdCell(c.term)} | ${
            Number.isFinite(c.credits) ? c.credits : "?"
          } | ${mdCell(c.status)} |`,
      ),
    );
  }

  return parts.join("\n");
}

function mdCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function dedupeCourses(courses) {
  const byIdentity = new Map();
  for (const course of courses) {
    const key = `${course.code}|${course.term}|${course.credits}|${course.status}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, course);
      continue;
    }

    for (const appliesTo of course.appliesTo) {
      if (!existing.appliesTo.some((item) => item.block === appliesTo.block && item.requirement === appliesTo.requirement)) {
        existing.appliesTo.push(appliesTo);
      }
    }
  }

  return [...byIdentity.values()];
}

function dedupeObjects(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstMatch(text, regex) {
  return text.match(regex)?.[1]?.trim() ?? null;
}

function firstMatchGroups(text, regex) {
  const match = text.match(regex);
  return match ? match.slice(1) : null;
}

function normalizeSpaces(text) {
  return text.replace(/\s+/g, " ").trim();
}

function lastToken(text) {
  return text.trim().split(/\s+/).at(-1) ?? "";
}

function stripTrailingGradeToken(text) {
  return text.replace(/\s+\b(?:A|B|C|D|F|P|TR|EC|IP|NCT|S|U|W|I|NP|NC|Pass|Fail)\b$/i, "").trim();
}

function parseBlockHeader(text) {
  const match = text.match(/^(.{3,90}?)\s+(COMPLETE|INCOMPLETE)$/);
  if (!match) return null;
  if (/Clemson University|Degree Works|Legend/.test(text)) return null;
  return {
    label: match[1].trim(),
    status: match[2].toLowerCase()
  };
}

function parseRequirementLabel(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\(\d+(?:\.\d+)?\s*Cr\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function normalizeProgram(programRaw) {
  if (!programRaw) return "Graphic Communications, BS";
  if (/Graphic\s+Communications/i.test(programRaw)) return "Graphic Communications, BS";
  return programRaw;
}

function normalizeMajor(majorRaw) {
  if (!majorRaw) return null;
  return majorRaw.replace(/^in\s+/i, "").trim();
}

function parseUnmetRequirementLabel(text) {
  const cleaned = normalizeSpaces(text);
  if (!cleaned) return null;
  if (isPrivateLine(cleaned) || isNonCourseLine(cleaned)) return null;
  if (/^Course\s+Title\s+Grade\s+Credits\s+Term/.test(cleaned)) return null;
  if (/Still needed:/.test(cleaned)) return null;
  if (/\b[A-Z]{2,5}\s+\d{4}\b/.test(cleaned)) return null;
  if (/^\*+/.test(cleaned)) return null;
  if (parseSectionHeader(cleaned)) return null;
  if (/^Credits applied:\s*\d+/i.test(cleaned)) return null;
  if (isInvalidRequirementLabel(cleaned)) return null;

  const match = cleaned.match(/^(.+?)\s*\((\d+(?:\.\d+)?)\s*Cr\)$/i);
  if (match) {
    return {
      label: normalizeRequirementText(match[1]),
      credits: Number(match[2])
    };
  }

  return {
    label: normalizeRequirementText(cleaned),
    credits: null
  };
}

function mergeRequirementLabel(previous, current) {
  if (!previous) return current;
  if (/^(REQUIREMENT|Approved Courses|Lab|Specific Course Required)\b/i.test(current)) {
    return normalizeRequirementText(`${previous} ${current}`);
  }
  if (/\($/.test(previous) || /-\s*$/.test(previous)) {
    return normalizeRequirementText(`${previous} ${current}`);
  }
  return current;
}

function isInvalidRequirementLabel(text) {
  const cleaned = normalizeSpaces(text);
  return cleaned === "REQUIREMENT"
    || /Credits applied:\s*\d+\s+Classes applied:\s*\d+/i.test(cleaned)
    || /^(In-progress and Preregistered|In-progress|Excess Electives|Insufficient)\b/i.test(cleaned);
}

function normalizeRequirementText(text) {
  return text
    .replace(/\(\d+(?:\.\d+)?\s*Cr\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCourseCodes(text) {
  const codes = [];
  let currentSubject = null;
  const tokenPattern = /\b([A-Z]{2,5})\s+(\d{4})\b|\b(?:or|and|,)\s+(\d{4})\b/g;

  for (const match of text.matchAll(tokenPattern)) {
    if (match[1] && match[2]) {
      currentSubject = match[1];
      codes.push(`${currentSubject} ${match[2]}`);
      continue;
    }

    if (match[3] && currentSubject) {
      codes.push(`${currentSubject} ${match[3]}`);
    }
  }

  return [...new Set(codes)];
}

function requirementConfidence(neededText) {
  if (isTruncatedNeededText(neededText)) return "degreeworks_candidates_truncated";
  if (extractCourseCodes(neededText).length > 0) return "degreeworks_candidates";
  if (/minimum of \d+ credits/i.test(neededText) || /you currently have \d+ credits/i.test(neededText)) return "credit_count";
  if (/eligible for graduation|graduation|See .+ section|Click here/i.test(neededText)) return "informational";
  if (/^\d+\s+(Class|Credits?)\b/i.test(neededText)) return "catalog_required";
  return "catalog_required";
}

function summarizeCandidateCourses(codes, neededText) {
  if (codes.length <= 2) return codes;
  return [...codes.slice(0, 2), "..."];
}

function isTruncatedNeededText(text) {
  return /\bor\s*$/i.test(text) || /\b[A-Z]{1,5}\s*$/i.test(text);
}
