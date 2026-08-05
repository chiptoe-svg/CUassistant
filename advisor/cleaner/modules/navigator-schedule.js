// Clemson Navigator schedule cleaner. PURE: string in, sanitized data + Markdown
// out. No DOM, no pdf.js.
//
// Navigator exports a multi-line block per course (unlike Banner's one-row-per-
// course "Advising Profile"). A block looks like:
//
//   GC-1010-001-LEC Orientation to Graphic Comm<TAB>Chip Tonkin
//   Begins on 08/19/2026
//   <blank>
//   08/19/2026 - 12/11/2026
//   F 11:15am - 12:05pm ET
//   JORDAN-G33
//
// It has no CRN or credits, but it DOES carry meeting days/times and room — the
// useful bits for conflict advising. This module whitelist-extracts code, title,
// instructor, days/times, room, and date range into a clean Markdown table.

export const navigatorScheduleModule = {
  id: "navigator-schedule",
  label: "Navigator Schedule",
  description:
    "Clemson Navigator schedule paste → clean Markdown table (code, title, days/times, room, instructor).",
  accepts: ["text"],
  // Navigator's signature: its header row, or two or more dash-delimited course
  // codes (SUBJ-NUM-SEC-TYPE) at the start of a line.
  detect(text) {
    const s = String(text || "");
    if (/^\s*COURSE\t+PROFESSOR\t+DAYS\/TIMES/im.test(s)) return true;
    let rows = 0;
    for (const line of s.split("\n")) {
      if (/^\s*[A-Z]{2,5}-\d{4}-\d{3}-[A-Z]{2,4}\b/.test(line)) rows++;
    }
    return rows >= 2;
  },
  clean(rawText) {
    const lines = String(rawText || "").split("\n").map((l) => l.replace(/\r$/, ""));
    const courses = [];
    const warnings = [];
    let cur = null;

    const flush = () => {
      if (cur) courses.push(cur);
      cur = null;
    };

    for (const raw of lines) {
      // A new course starts at a "SUBJ-NUM-SEC-TYPE Title<TAB>Instructor" line.
      const code = raw.match(
        /^\s*([A-Z]{2,5})-(\d{4})-(\d{3})-([A-Z]{2,4})\s+(.+?)(?:\t+(.*))?$/,
      );
      if (code) {
        flush();
        const [, subj, num, sec, type, title, prof] = code;
        cur = {
          code: `${subj} ${num} ${sec}`,
          section: sec,
          type,
          title: title.trim(),
          instructor: (prof || "").trim(),
          days: "",
          time: "",
          room: "",
          dates: "",
        };
        continue;
      }
      if (!cur) continue;

      const line = raw.trim();
      if (!line || /^Begins on\b/i.test(line)) continue;

      const dateRange = line.match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})$/);
      if (dateRange) {
        cur.dates = `${dateRange[1]} - ${dateRange[2]}`;
        continue;
      }
      const meeting = line.match(
        /^([MTWRFSU]{1,7})\s+(\d{1,2}:\d{2}\s*[ap]m\s*-\s*\d{1,2}:\d{2}\s*[ap]m(?:\s+\w+)?)$/i,
      );
      if (meeting) {
        cur.days = meeting[1];
        cur.time = meeting[2].trim();
        continue;
      }
      // Room: a BUILDING-ROOM token (3+ letters, dash, alphanumerics). Course-code
      // lines were already consumed above, so this can't swallow one.
      if (/^[A-Z]{3,6}-[A-Z0-9]+$/.test(line)) {
        cur.room = line;
        continue;
      }
      // Anything else (online notes, "TBA", stray columns) is ignored.
    }
    flush();

    if (courses.length === 0) {
      warnings.push(
        "No courses were parsed. Paste the schedule blocks directly from Navigator.",
      );
    }

    const sanitized = { schema: "navigator-schedule-v1", courses };

    return {
      schema: "navigator-schedule-v1",
      sanitized,
      markdown: toMarkdown(courses),
      warnings,
      metrics: [{ label: "Courses", value: String(courses.length) }],
      preview: lines.join("\n"),
    };
  },
};

function toMarkdown(courses) {
  const header = `**Schedule — ${courses.length} course${courses.length === 1 ? "" : "s"}**`;
  if (courses.length === 0) return `${header}\n\n_No courses parsed._`;

  const rows = courses.map((c) => {
    const when = [c.days, c.time].filter(Boolean).join(" ") || "—";
    return `| ${cell(c.code)} | ${cell(c.title)} | ${cell(when)} | ${cell(
      c.room || "—",
    )} | ${cell(c.instructor || "—")} |`;
  });

  return [
    header,
    "",
    "| Code | Title | Days/Times | Room | Instructor |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}
