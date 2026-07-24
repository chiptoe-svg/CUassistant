// Read-only catalog lookup for the advisor's course hover cards. Opens
// gc_advisor.db per call (like the get-program-requirements tool) so it always
// reflects the latest nightly rebuild. Course title/credits/description are
// public catalog data — not student PII — so this needs no consent gate.

import Database from "better-sqlite3";

import { GC_ADVISOR_DB } from "./config.js";

export interface CatalogCourse {
  code: string;
  title: string | null;
  credits: string | null;
  description: string | null;
}

interface CourseRow {
  code: string;
  title: string | null;
  credits: string | null;
  description: string | null;
}

// Normalize "gc4061", "GC 4061", "GC  4061" -> "GC 4061" (uppercase subject +
// single space + number), matching how course.code is stored. Returns null for
// anything that is not a plausible course code so a junk path 404s cleanly.
export function normalizeCourseCode(raw: string): string | null {
  const m = /^\s*([A-Za-z]{2,4})\s*(\d{3,4}[A-Za-z]?)\s*$/.exec(raw);
  if (!m) return null;
  return `${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
}

export function lookupCourse(rawCode: string): CatalogCourse | null {
  const code = normalizeCourseCode(rawCode);
  if (!code) return null;

  let db: Database.Database;
  try {
    db = new Database(GC_ADVISOR_DB, { readonly: true, fileMustExist: true });
  } catch {
    return null; // catalog DB not loaded yet — treat as "no entry"
  }

  try {
    const row = db
      .prepare(
        "SELECT code, title, credits, description FROM course WHERE code = ? LIMIT 1",
      )
      .get(code) as CourseRow | undefined;
    if (!row) return null;
    return {
      code: row.code,
      title: row.title,
      credits: row.credits,
      description: row.description,
    };
  } finally {
    db.close();
  }
}
