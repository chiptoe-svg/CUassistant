// Banner "Advising Profile / Register for Classes" schedule cleaner. PURE:
// string in, sanitized data + Markdown out. No DOM, no pdf.js.
//
// The advisor copies a student's registered-schedule table out of Banner; each
// row arrives tab-delimited, and the CRN column is followed by a wall of
// screen-reader text ("Press enter key to view additional class details … Press
// Escape key to select the entire row Press enter to activate popup"). This
// module whitelist-extracts the useful fields (code, section, title, CRN,
// credits, status, instructor) and drops the accessibility noise, emitting a
// clean Markdown table. This paste carries no student name or ID — only the
// student's registered sections and (public) instructor names.

export const bannerScheduleModule = {
  id: "banner-schedule",
  label: "Advising Profile Schedule",
  description:
    "Clemson Banner registered-schedule paste → clean Markdown table (code, title, CRN, credits, instructor). Strips the screen-reader text; no student name or ID appears in this view.",
  accepts: ["text"],
  clean(rawText) {
    const lines = String(rawText || "")
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim());

    const courses = [];
    const warnings = [];
    let term = null;

    for (const line of lines) {
      if (isHeaderRow(line)) continue;
      const parsed = parseRow(line);
      if (!parsed) {
        warnings.push(
          `Skipped a row that did not look like a registered course: "${truncate(line, 70)}"`,
        );
        continue;
      }
      if (parsed.term && !term) term = parsed.term;
      courses.push(parsed.course);
    }

    if (!term) {
      warnings.push(
        "No term (e.g. 202608) was found in the paste. Add it manually if the advising tools need it.",
      );
    }
    if (courses.length === 0) {
      warnings.push(
        "No registered courses were parsed. Paste the schedule table rows directly from Banner (tab-separated).",
      );
    }

    const totalCredits = courses.reduce(
      (sum, c) => sum + (Number.isFinite(c.credits) ? c.credits : 0),
      0,
    );

    const sanitized = {
      schema: "banner-schedule-v1",
      term,
      totalCredits,
      courses,
    };

    return {
      schema: "banner-schedule-v1",
      sanitized,
      markdown: toMarkdown(sanitized),
      warnings,
      metrics: [
        { label: "Term", value: term ?? "—" },
        { label: "Courses", value: String(courses.length) },
        { label: "Total credits", value: String(totalCredits) },
      ],
      // Source preview: the raw rows, so the advisor can eyeball what parsed.
      preview: lines.join("\n"),
    };
  },
};

// A tab-delimited registered-course row is:
//   Title \t SUBJ NUM SEC \t <CRN><screen-reader text> \t Credits \t Status \t Instructor
// The CRN is the leading digits of column 3; the term is embedded in its
// "for term 202608" phrase. Anything that doesn't match the code column shape is
// treated as a non-course row.
function parseRow(line) {
  const cols = line.split("\t").map((c) => c.trim());
  if (cols.length < 4) return null;

  const [title, codeCol, crnCol, creditsCol, statusCol, instructorCol] = cols;

  const codeMatch = codeCol.match(/^([A-Z]{2,5})\s+(\d{4})\s+(\S+)$/);
  if (!codeMatch) return null;
  const [, subject, number, section] = codeMatch;

  const crn = (crnCol.match(/^(\d{3,})/) || [])[1] ?? "";
  const term = (crnCol.match(/for term (\d{6})/) || [])[1] ?? null;

  const creditsToken = (creditsCol || "").match(/-?\d+(?:\.\d+)?/);
  const credits = creditsToken ? Number(creditsToken[0]) : NaN;

  return {
    term,
    course: {
      code: `${subject} ${number}`,
      section,
      title: title || "",
      crn,
      credits,
      status: statusCol || "",
      instructor: instructorCol || "",
    },
  };
}

function isHeaderRow(line) {
  const first = line.split("\t")[0]?.trim() ?? "";
  return (
    /^(Title|Course Title|Subject)\b/i.test(first) &&
    /\b(Details?|Credits?|Hours|Status|Instructor)\b/i.test(line)
  );
}

function toMarkdown(sanitized) {
  const header = `**Registered schedule${
    sanitized.term ? ` — term ${sanitized.term}` : ""
  } — ${sanitized.courses.length} course${
    sanitized.courses.length === 1 ? "" : "s"
  }, ${sanitized.totalCredits} credit${
    sanitized.totalCredits === 1 ? "" : "s"
  }**`;

  if (sanitized.courses.length === 0) {
    return `${header}\n\n_No courses parsed._`;
  }

  const rows = sanitized.courses.map((c) => {
    const code = c.section ? `${c.code} ${c.section}` : c.code;
    const credits = Number.isFinite(c.credits) ? String(c.credits) : "?";
    return `| ${cell(code)} | ${cell(c.title)} | ${cell(c.crn)} | ${credits} | ${cell(
      c.status,
    )} | ${cell(c.instructor)} |`;
  });

  return [
    header,
    "",
    "| Code | Title | CRN | Cr | Status | Instructor |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

// Escape the cell separator so a stray pipe in a title/instructor can't break
// the Markdown table.
function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function truncate(text, max) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
