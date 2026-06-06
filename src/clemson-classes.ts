// Clemson public "Browse Classes" client (Banner 9 self-service).
//
// Read-only access to the public class schedule at regssb.sis.clemson.edu — no
// login and no Clemson network required. The VPN restriction documented for
// iROAR applies only to the authenticated *registration* side; the class
// browse is internet-facing.
//
// Banner needs a session cookie with a term bound before searchResults returns
// rows, so each search runs the 3-step dance:
//   1. GET classSearch            -> mint JSESSIONID (returned on a 302)
//   2. POST term/search?mode=search -> bind the term to the session
//   3. GET searchResults/searchResults -> the query
// A fresh session is opened per search so searches never need an inter-query
// reset.

import { log } from "./log.js";

const SSB = "https://regssb.sis.clemson.edu/StudentRegistrationSsb/ssb";

export interface ClemsonTerm {
  code: string;
  description: string;
}

export interface ClemsonMeeting {
  days: string; // e.g. "MWF"
  beginTime: string | null; // "1325" (24h, no colon — as Banner returns it)
  endTime: string | null;
  building: string | null;
  room: string | null;
  startDate: string | null;
  endDate: string | null;
  type: string | null;
}

export interface ClemsonInstructor {
  name: string;
  email: string | null;
  primary: boolean;
}

export interface ClemsonSection {
  term: string;
  termDescription: string;
  crn: string;
  subjectCourse: string;
  section: string;
  title: string;
  campus: string | null;
  scheduleType: string | null;
  instructionalMethod: string | null;
  creditHours: number | null;
  enrollment: number;
  maxEnrollment: number;
  seatsAvailable: number;
  waitCount: number;
  waitCapacity: number;
  open: boolean;
  instructors: ClemsonInstructor[];
  meetings: ClemsonMeeting[];
}

export interface ClemsonSearchParams {
  term: string;
  subject?: string;
  courseNumber?: string;
  openOnly?: boolean;
  max?: number;
  offset?: number;
}

export interface ClemsonSearchResult {
  totalCount: number;
  sections: ClemsonSection[];
}

class CookieJar {
  private jar = new Map<string, string>();
  capture(res: Response): void {
    const getter = (res.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie;
    const cookies =
      typeof getter === "function" ? getter.call(res.headers) : [];
    for (const c of cookies) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0)
        this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export async function listClemsonTerms(
  max = 20,
): Promise<ClemsonTerm[] | null> {
  try {
    const r = await fetch(
      `${SSB}/classSearch/getTerms?searchTerm=&offset=1&max=${max}`,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as Array<{
      code?: string;
      description?: string;
    }>;
    return data.map((t) => ({
      code: String(t.code ?? ""),
      description: String(t.description ?? ""),
    }));
  } catch (err) {
    log.warn("clemson terms fetch failed", { err: String(err) });
    return null;
  }
}

async function openSession(term: string): Promise<CookieJar | null> {
  const jar = new CookieJar();
  // redirect: "manual" is required — the JSESSIONID is set on the 302, and
  // fetch only exposes Set-Cookie from the response it stops on.
  const r1 = await fetch(`${SSB}/classSearch/classSearch`, {
    redirect: "manual",
  });
  jar.capture(r1);
  const r2 = await fetch(`${SSB}/term/search?mode=search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
    },
    body: `term=${encodeURIComponent(term)}`,
    redirect: "manual",
  });
  jar.capture(r2);
  return jar;
}

const DAY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["monday", "M"],
  ["tuesday", "T"],
  ["wednesday", "W"],
  ["thursday", "R"],
  ["friday", "F"],
  ["saturday", "S"],
  ["sunday", "U"],
];

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

function mapMeeting(mf: Record<string, unknown>): ClemsonMeeting {
  const mt = rec(mf.meetingTime);
  const days = DAY_KEYS.filter(([k]) => mt[k])
    .map(([, d]) => d)
    .join("");
  return {
    days,
    beginTime: str(mt.beginTime),
    endTime: str(mt.endTime),
    building: str(mt.buildingDescription) ?? str(mt.building),
    room: str(mt.room),
    startDate: str(mt.startDate),
    endDate: str(mt.endDate),
    type: str(mt.meetingTypeDescription),
  };
}

function mapSection(r: Record<string, unknown>): ClemsonSection {
  const meetings = arr(r.meetingsFaculty).map(mapMeeting);
  // The same meeting repeats once per faculty member — dedupe identical rows.
  const seen = new Set<string>();
  const uniqueMeetings = meetings.filter((m) => {
    const key = JSON.stringify(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const instructors: ClemsonInstructor[] = arr(r.faculty).map((f) => ({
    name: String(f.displayName ?? ""),
    email: str(f.emailAddress),
    primary: Boolean(f.primaryIndicator),
  }));
  return {
    term: String(r.term ?? ""),
    termDescription: String(r.termDesc ?? ""),
    crn: String(r.courseReferenceNumber ?? ""),
    subjectCourse: String(r.subjectCourse ?? ""),
    section: String(r.sequenceNumber ?? ""),
    title: String(r.courseTitle ?? ""),
    campus: str(r.campusDescription),
    scheduleType: str(r.scheduleTypeDescription),
    instructionalMethod: str(r.instructionalMethodDescription),
    creditHours:
      typeof r.creditHourLow === "number"
        ? r.creditHourLow
        : typeof r.creditHours === "number"
          ? r.creditHours
          : null,
    enrollment: num(r.enrollment),
    maxEnrollment: num(r.maximumEnrollment),
    seatsAvailable: num(r.seatsAvailable),
    waitCount: num(r.waitCount),
    waitCapacity: num(r.waitCapacity),
    open: Boolean(r.openSection),
    instructors,
    meetings: uniqueMeetings,
  };
}

export async function searchClemsonClasses(
  params: ClemsonSearchParams,
): Promise<ClemsonSearchResult | null> {
  try {
    const jar = await openSession(params.term);
    if (!jar) return null;
    const q = new URLSearchParams({
      txt_term: params.term,
      pageOffset: String(params.offset ?? 0),
      pageMaxSize: String(Math.min(Math.max(params.max ?? 50, 1), 500)),
      sortColumn: "subjectDescription",
      sortDirection: "asc",
    });
    if (params.subject) q.set("txt_subject", params.subject.toUpperCase());
    if (params.courseNumber) q.set("txt_courseNumber", params.courseNumber);
    if (params.openOnly) q.set("chk_open_only", "true");
    const r = await fetch(`${SSB}/searchResults/searchResults?${q}`, {
      headers: { Cookie: jar.header() },
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      success?: boolean;
      totalCount?: number;
      data?: unknown;
    };
    return {
      totalCount: data.totalCount ?? 0,
      sections: arr(data.data).map(mapSection),
    };
  } catch (err) {
    log.warn("clemson class search failed", { err: String(err) });
    return null;
  }
}

// --- Per-section detail (description, prereqs, coreqs, restrictions, books) ---

export interface ClemsonSectionDetails {
  term: string;
  crn: string;
  description: string | null;
  prerequisites: string | null;
  corequisites: string | null;
  restrictions: string | null;
  attributes: string | null;
  bookstoreUrl: string | null;
}

function htmlToText(html: string): string | null {
  let t = html.replace(/<!--[\s\S]*?-->/g, "");
  // Banner returns an error shell for endpoints that don't apply.
  if (/page is not available/i.test(t)) return null;
  t = t
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

// Collapse Banner's "no X information available" placeholders to null.
function meaningful(text: string | null): string | null {
  if (!text) return null;
  if (/^(no .*information( is)? available\.?|none\.?)$/i.test(text))
    return null;
  return text;
}

async function postDetail(
  jar: CookieJar,
  endpoint: string,
  term: string,
  crn: string,
): Promise<string> {
  const r = await fetch(`${SSB}/searchResults/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
    },
    body: `term=${encodeURIComponent(term)}&courseReferenceNumber=${encodeURIComponent(crn)}`,
  });
  return r.ok ? await r.text() : "";
}

function bookstoreUrl(html: string): string | null {
  // Prefer the populated link over the "{0}" template the page also emits.
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
  const real = hrefs.find((h) => h.startsWith("http") && !h.includes("{"));
  return real ? real.replace(/&amp;/g, "&") : null;
}

export async function getClemsonSectionDetails(
  term: string,
  crn: string,
): Promise<ClemsonSectionDetails | null> {
  try {
    const jar = await openSession(term);
    if (!jar) return null;
    const [desc, preq, coreq, restr, attrs, books] = await Promise.all([
      postDetail(jar, "getCourseDescription", term, crn),
      postDetail(jar, "getSectionPrerequisites", term, crn),
      postDetail(jar, "getCorequisites", term, crn),
      postDetail(jar, "getRestrictions", term, crn),
      postDetail(jar, "getSectionAttributes", term, crn),
      postDetail(jar, "getSectionBookstoreDetails", term, crn),
    ]);
    return {
      term,
      crn,
      description: meaningful(htmlToText(desc)),
      prerequisites: meaningful(htmlToText(preq)),
      corequisites: meaningful(htmlToText(coreq)),
      restrictions: meaningful(htmlToText(restr)),
      attributes: meaningful(htmlToText(attrs)),
      bookstoreUrl: bookstoreUrl(books),
    };
  } catch (err) {
    log.warn("clemson section details failed", { err: String(err) });
    return null;
  }
}
