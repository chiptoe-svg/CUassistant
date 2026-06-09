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

import fs from "fs";
import path from "path";
import zlib from "zlib";

import { STATE_DIR } from "./config.js";
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

// Run the searchResults query on an already-opened session.
async function runSearch(
  jar: CookieJar,
  params: ClemsonSearchParams,
): Promise<ClemsonSearchResult | null> {
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
  // Banner sometimes returns an HTML error shell instead of JSON; treat that
  // as a failed fetch rather than throwing.
  const text = await r.text();
  let data: { totalCount?: number; data?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return {
    totalCount: data.totalCount ?? 0,
    sections: arr(data.data).map(mapSection),
  };
}

export async function searchClemsonClasses(
  params: ClemsonSearchParams,
): Promise<ClemsonSearchResult | null> {
  try {
    const jar = await openSession(params.term);
    if (!jar) return null;
    return await runSearch(jar, params);
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

// --- Instructor lookup + "what is <name> teaching" ---

export interface ClemsonInstructorMatch {
  id: string;
  name: string;
}

export interface ClemsonInstructorClasses {
  term: string;
  termDescription: string;
  query: string;
  /** The single instructor the query resolved to, when unambiguous. */
  matched: ClemsonInstructorMatch | null;
  /** Candidate instructors when the name is ambiguous or unmatched. */
  candidates: ClemsonInstructorMatch[];
  sections: ClemsonSection[];
  /** Human-readable note about where the data came from. */
  note: string | null;
  /** ISO date of the snapshot used; null when fetched live. */
  snapshotDate: string | null;
  scope: "snapshot" | "live-full" | "live-subject" | null;
}

// Accept a term code (202608) or human text ("Fall 2026"); resolve to a code.
async function resolveTerm(
  term: string,
): Promise<{ code: string; description: string } | null> {
  if (/^\d{6}$/.test(term)) {
    const all = await listClemsonTerms(50);
    const hit = all?.find((t) => t.code === term);
    return { code: term, description: hit?.description ?? term };
  }
  const all = await listClemsonTerms(50);
  const q = term.trim().toLowerCase();
  const hit = all?.find((t) => t.description.toLowerCase().includes(q));
  return hit ? { code: hit.code, description: hit.description } : null;
}

// get_instructor on an already-opened session (returns a top-level array).
async function fetchInstructors(
  jar: CookieJar,
  term: string,
  query: string,
  max: number,
): Promise<ClemsonInstructorMatch[]> {
  const r = await fetch(
    `${SSB}/classSearch/get_instructor?searchTerm=${encodeURIComponent(query)}&term=${encodeURIComponent(term)}&offset=1&max=${max}`,
    { headers: { Cookie: jar.header() } },
  );
  if (!r.ok) return [];
  const body = (await r.json()) as unknown;
  const rows = Array.isArray(body)
    ? body
    : ((body as { data?: unknown }).data ?? []);
  return (Array.isArray(rows) ? rows : []).map((i) => {
    const o = rec(i);
    return { id: String(o.code ?? ""), name: String(o.description ?? "") };
  });
}

export async function listClemsonInstructors(
  term: string,
  query: string,
  max = 25,
): Promise<ClemsonInstructorMatch[] | null> {
  try {
    const jar = await openSession(term);
    if (!jar) return null;
    return await fetchInstructors(jar, term, query, max);
  } catch (err) {
    log.warn("clemson instructor lookup failed", { err: String(err) });
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Page through searchResults on one session, accumulating every section.
// Banner's txt_instructor filter is unreliable (HTTP 500s), so the instructor
// flow instead lists sections (optionally subject-scoped) and filters by
// faculty name in code. With a subject this is one page; without one it walks
// the whole term (~10k sections) in 500-row pages.
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

type PagedResult = { sections: ClemsonSection[]; complete: boolean };

async function fetchSectionsPaged(
  term: string,
  subject: string | undefined,
  openOnly: boolean | undefined,
  attempts = 4,
): Promise<PagedResult | null> {
  // NB: Banner's searchResults is stateful per session — the first query on a
  // session fixes the result set, and offset paging walks it. Do NOT issue any
  // other search (e.g. a probe) on the same session first; that resets the set
  // and breaks paging. So each attempt opens a fresh session and pages the real
  // query directly. A first page with totalCount=0 means the term didn't bind
  // (cold session) — retry with a new session rather than report "no results".
  for (let attempt = 0; attempt < attempts; attempt++) {
    const jar = await openSession(term);
    if (!jar) {
      await sleep(400);
      continue;
    }
    const out: ClemsonSection[] = [];
    let failed = false;
    let cold = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await runSearch(jar, {
        term,
        subject,
        openOnly,
        offset: page * PAGE_SIZE,
        max: PAGE_SIZE,
      });
      if (res === null) {
        failed = true;
        break;
      }
      if (page === 0 && res.totalCount === 0 && res.sections.length === 0) {
        cold = true;
        break;
      }
      out.push(...res.sections);
      if (out.length >= res.totalCount || res.sections.length === 0) {
        return { sections: out, complete: true };
      }
      await sleep(200);
    }
    if (cold || (failed && out.length === 0)) {
      await sleep(400);
      continue;
    }
    // Partial failure mid-scan: return what we have, marked incomplete.
    return { sections: out, complete: false };
  }
  return null;
}

// --- Per-term snapshots (disk) ---
//
// A full-term scan is ~20 requests and Banner rate-limits bursts, so the live
// (registering) terms are scanned once a day by a separate job and written
// gzip-compressed to state/clemson/<term>.json.gz (JSON-of-records compresses
// ~20x — repeated keys + low-cardinality values). Queries read the snapshot and
// stamp results with its date. Reads are memoized in-process keyed by file
// mtime, so the ~6.5MB term parses once and is reused across requests until the
// daily job rewrites the file. Snapshots are per term — Banner binds one term
// per session. Past "(View Only)" terms never change, so they need no refresh.

export interface ClemsonTermSnapshot {
  term: string;
  termDescription: string;
  fetchedAt: string; // ISO 8601
  sectionCount: number;
  sections: ClemsonSection[];
}

function snapshotDir(): string {
  return path.join(STATE_DIR, "clemson");
}
function snapshotPath(term: string): string {
  return path.join(snapshotDir(), `${term}.json`);
}

/** Serialize a snapshot to a gzipped JSON buffer. */
export function serializeSnapshot(snap: ClemsonTermSnapshot): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(snap), "utf-8"));
}

/** Parse a snapshot buffer — gzip (magic 1f 8b) or legacy plain JSON. */
export function deserializeSnapshot(buf: Buffer): ClemsonTermSnapshot {
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const json = (isGzip ? zlib.gunzipSync(buf) : buf).toString("utf-8");
  return JSON.parse(json) as ClemsonTermSnapshot;
}

// Parsed-snapshot cache, keyed by file path, invalidated by mtime change.
const snapshotCache = new Map<
  string,
  { mtimeMs: number; snap: ClemsonTermSnapshot }
>();

export function loadClemsonSnapshot(term: string): ClemsonTermSnapshot | null {
  // Prefer the gzipped file; fall back to a legacy uncompressed .json.
  for (const p of [`${snapshotPath(term)}.gz`, snapshotPath(term)]) {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue; // not this format; try the next
    }
    const cached = snapshotCache.get(p);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.snap;
    try {
      const snap = deserializeSnapshot(fs.readFileSync(p));
      snapshotCache.set(p, { mtimeMs: st.mtimeMs, snap });
      return snap;
    } catch (err) {
      log.warn("clemson snapshot read failed", { term, err: String(err) });
      return null;
    }
  }
  return null;
}

function saveClemsonSnapshot(snap: ClemsonTermSnapshot): void {
  try {
    fs.mkdirSync(snapshotDir(), { recursive: true });
    const p = `${snapshotPath(snap.term)}.gz`;
    fs.writeFileSync(p, serializeSnapshot(snap));
    snapshotCache.delete(p); // next read re-loads with the fresh mtime
  } catch (err) {
    log.warn("clemson snapshot write failed", {
      term: snap.term,
      err: String(err),
    });
  }
}

// Scan a term's full section list and persist it. Returns null if the scan did
// not complete (so a throttled/partial scan never overwrites a good snapshot).
export async function refreshClemsonSnapshot(
  term: string,
): Promise<ClemsonTermSnapshot | null> {
  const resolved = await resolveTerm(term);
  if (!resolved) return null;
  const fetched = await fetchSectionsPaged(resolved.code, undefined, undefined);
  if (fetched === null || !fetched.complete) return null;
  const snap: ClemsonTermSnapshot = {
    term: resolved.code,
    termDescription: resolved.description,
    fetchedAt: new Date().toISOString(),
    sectionCount: fetched.sections.length,
    sections: fetched.sections,
  };
  saveClemsonSnapshot(snap);
  return snap;
}

// A term is "live" (needs daily refresh) unless Banner labels it View Only.
// New terms (e.g. Spring 2027) appear in getTerms automatically without the
// label, so the daily job picks them up with no manual configuration.
function isLiveTerm(t: ClemsonTerm): boolean {
  return !/\(view only\)/i.test(t.description);
}

export interface ClemsonRefreshResult {
  term: string;
  description: string;
  sections: number | null; // null = scan failed (snapshot left untouched)
}

// Daily job: discover the live terms via getTerms and refresh each snapshot.
export async function refreshLiveClemsonSnapshots(): Promise<
  ClemsonRefreshResult[]
> {
  const terms = await listClemsonTerms(20);
  if (!terms) return [];
  const out: ClemsonRefreshResult[] = [];
  for (const t of terms.filter(isLiveTerm)) {
    const snap = await refreshClemsonSnapshot(t.code);
    out.push({
      term: t.code,
      description: t.description,
      sections: snap?.sectionCount ?? null,
    });
    await sleep(1000); // be gentle between term scans
  }
  return out;
}

export interface TermSections {
  termCode: string;
  termDescription: string;
  sections: ClemsonSection[];
  /** ISO date of the snapshot the sections came from; null when fetched live. */
  snapshotDate: string | null;
  scope: "snapshot" | "live-full" | "live-subject";
}

// Section source for a query: prefer the saved snapshot; on refresh or a cold
// (missing) snapshot, scan live. When no snapshot exists and a subject is
// given, do the cheap subject-scoped scan instead of forcing a full scan, so a
// missing snapshot degrades gracefully rather than hammering Banner.
async function getTermSections(
  term: string,
  opts: { subject?: string; refresh?: boolean } = {},
): Promise<TermSections | null> {
  const resolved = await resolveTerm(term);
  if (!resolved) return null;
  const base = {
    termCode: resolved.code,
    termDescription: resolved.description,
  };

  if (opts.refresh) {
    const snap = await refreshClemsonSnapshot(resolved.code);
    if (snap) {
      return {
        ...base,
        sections: snap.sections,
        snapshotDate: snap.fetchedAt,
        scope: "snapshot",
      };
    }
    // refresh failed — fall through to any existing snapshot / live scan.
  }

  const existing = loadClemsonSnapshot(resolved.code);
  if (existing) {
    return {
      ...base,
      sections: existing.sections,
      snapshotDate: existing.fetchedAt,
      scope: "snapshot",
    };
  }

  // Cold: no snapshot on disk.
  if (opts.subject) {
    const scoped = await fetchSectionsPaged(
      resolved.code,
      opts.subject,
      undefined,
    );
    if (scoped === null) return null;
    return {
      ...base,
      sections: scoped.sections,
      snapshotDate: null,
      scope: "live-subject",
    };
  }
  const full = await fetchSectionsPaged(resolved.code, undefined, undefined);
  if (full === null) return null;
  if (full.complete) {
    const snap: ClemsonTermSnapshot = {
      term: resolved.code,
      termDescription: resolved.description,
      fetchedAt: new Date().toISOString(),
      sectionCount: full.sections.length,
      sections: full.sections,
    };
    saveClemsonSnapshot(snap);
    return {
      ...base,
      sections: full.sections,
      snapshotDate: snap.fetchedAt,
      scope: "snapshot",
    };
  }
  return {
    ...base,
    sections: full.sections,
    snapshotDate: null,
    scope: "live-full",
  };
}

function describeScope(ts: TermSections, subject?: string): string {
  if (ts.scope === "snapshot") {
    return `From the daily snapshot taken ${ts.snapshotDate}.`;
  }
  if (ts.scope === "live-subject") {
    return (
      `Live scan scoped to subject ${(subject || "").toUpperCase()} ` +
      "(no snapshot yet — run a refresh to cache the full term)."
    );
  }
  return "Live full-term scan (no snapshot yet — now cached).";
}

export async function findClemsonInstructorClasses(params: {
  term: string;
  instructor: string;
  subject?: string;
  openOnly?: boolean;
  max?: number;
  refresh?: boolean;
}): Promise<ClemsonInstructorClasses | null> {
  try {
    const resolved = await resolveTerm(params.term);
    if (!resolved) return null;
    const tokens = params.instructor
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    // Banner's instructor lookup keys on a single fragment — search by surname
    // (the most selective token) then narrow client-side by every token.
    const surname = tokens.length
      ? tokens[tokens.length - 1]
      : params.instructor;
    const base: ClemsonInstructorClasses = {
      term: resolved.code,
      termDescription: resolved.description,
      query: params.instructor,
      matched: null,
      candidates: [],
      sections: [],
      note: null,
      snapshotDate: null,
      scope: null,
    };

    // Resolve the name -> candidate(s) via a live get_instructor lookup.
    const jar = await openSession(resolved.code);
    if (!jar) return null;
    const all = await fetchInstructors(jar, resolved.code, surname, 50);
    const narrowed = all.filter((c) =>
      tokens.every((t) => c.name.toLowerCase().includes(t)),
    );
    const pool = narrowed.length ? narrowed : all;
    if (pool.length !== 1) {
      // Ambiguous or no match — hand back candidates for disambiguation.
      return { ...base, candidates: pool };
    }
    const matched = pool[0];

    // Sections come from the daily snapshot (or a live fallback) and are
    // filtered by faculty name in code.
    const ts = await getTermSections(resolved.code, {
      subject: params.subject,
      refresh: params.refresh,
    });
    if (ts === null) return null;
    let sections = ts.sections.filter((s) =>
      s.instructors.some((f) =>
        tokens.every((t) => f.name.toLowerCase().includes(t)),
      ),
    );
    if (params.openOnly)
      sections = sections.filter((s) => s.seatsAvailable > 0);
    const limited =
      typeof params.max === "number" ? sections.slice(0, params.max) : sections;
    return {
      ...base,
      matched,
      sections: limited,
      note: describeScope(ts, params.subject),
      snapshotDate: ts.snapshotDate,
      scope: ts.scope,
    };
  } catch (err) {
    log.warn("clemson instructor classes failed", { err: String(err) });
    return null;
  }
}

// --- Room availability (class occupancy from Banner) ---

const DAY_LETTER_TO_KEY: Record<string, string> = {
  M: "monday",
  T: "tuesday",
  W: "wednesday",
  R: "thursday",
  F: "friday",
  S: "saturday",
  U: "sunday",
};

function toMinutes(hhmm: string | null): number | null {
  if (!hhmm || hhmm.length < 3) return null;
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = parseInt(hhmm.slice(2), 10);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
}

function fromMinutes(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export interface ClemsonBusyBlock {
  start: string;
  end: string;
  courses: string[];
}

export interface ClemsonFreeBlock {
  start: string;
  end: string;
  minutes: number;
}

export interface ClemsonRoomAvailability {
  term: string;
  termDescription: string;
  building: string;
  room: string;
  /** Day pattern evaluated, e.g. "MW" — free slots are open on ALL of these. */
  pattern: string;
  window: { start: string; end: string };
  busy: ClemsonBusyBlock[];
  free: ClemsonFreeBlock[];
  note: string | null;
  /** ISO date of the snapshot used; null when fetched live. */
  snapshotDate: string | null;
  scope: "snapshot" | "live-full" | "live-subject" | null;
}

// Free/busy for a room on a day pattern (e.g. MW), derived from scheduled
// classes. A slot is "free" only if the room has no class at that time on ANY
// day in the pattern, so a meeting on any pattern day blocks the slot (busy is
// the union across those days). Classes only — ad-hoc 25Live events are not
// included (25Live's public API does not expose most rooms).
export async function getClemsonRoomAvailability(params: {
  term: string;
  building: string;
  room: string;
  days?: string;
  subject?: string;
  dayStart?: string;
  dayEnd?: string;
  minMinutes?: number;
  refresh?: boolean;
}): Promise<ClemsonRoomAvailability | null> {
  try {
    const ts = await getTermSections(params.term, {
      subject: params.subject,
      refresh: params.refresh,
    });
    if (ts === null) return null;

    const pattern = (params.days || "MW")
      .toUpperCase()
      .replace(/[^MTWRFSU]/g, "");
    const winStart = toMinutes(params.dayStart || "0800") ?? 8 * 60;
    const winEnd = toMinutes(params.dayEnd || "2200") ?? 22 * 60;
    const minMinutes = params.minMinutes ?? 50;
    const bldg = params.building.toLowerCase();

    type Interval = { s: number; e: number; course: string };
    const intervals: Interval[] = [];
    for (const s of ts.sections) {
      for (const m of s.meetings) {
        if (!m.building || !m.building.toLowerCase().includes(bldg)) continue;
        if ((m.room || "") !== params.room) continue;
        // Only meetings that fall on a day in the pattern matter.
        const onPattern = pattern
          .split("")
          .some((d) => m.days.includes(d) && DAY_LETTER_TO_KEY[d]);
        if (!onPattern) continue;
        const bs = toMinutes(m.beginTime);
        const be = toMinutes(m.endTime);
        if (bs === null || be === null) continue;
        intervals.push({
          s: bs,
          e: be,
          course: `${s.subjectCourse}-${s.section}`,
        });
      }
    }
    intervals.sort((a, b) => a.s - b.s || a.e - b.e);

    const merged: { s: number; e: number; courses: Set<string> }[] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv.s <= last.e) {
        last.e = Math.max(last.e, iv.e);
        last.courses.add(iv.course);
      } else {
        merged.push({ s: iv.s, e: iv.e, courses: new Set([iv.course]) });
      }
    }
    const busy: ClemsonBusyBlock[] = merged.map((b) => ({
      start: fromMinutes(b.s),
      end: fromMinutes(b.e),
      courses: [...b.courses].sort(),
    }));

    const free: ClemsonFreeBlock[] = [];
    let cur = winStart;
    for (const b of merged) {
      if (b.s > cur) {
        const end = Math.min(b.s, winEnd);
        if (end > cur)
          free.push({
            start: fromMinutes(cur),
            end: fromMinutes(end),
            minutes: end - cur,
          });
      }
      cur = Math.max(cur, b.e);
      if (cur >= winEnd) break;
    }
    if (cur < winEnd) {
      free.push({
        start: fromMinutes(cur),
        end: fromMinutes(winEnd),
        minutes: winEnd - cur,
      });
    }

    const coverage =
      ts.scope === "live-subject"
        ? ` Only subject ${(params.subject || "").toUpperCase()} was searched (no snapshot yet), so classes from other departments in this room are not included.`
        : "";
    const note =
      `${describeScope(ts, params.subject)} Scheduled classes only ` +
      `(excludes ad-hoc 25Live events).${coverage}`;

    return {
      term: ts.termCode,
      termDescription: ts.termDescription,
      building: params.building,
      room: params.room,
      pattern,
      window: { start: fromMinutes(winStart), end: fromMinutes(winEnd) },
      busy,
      free: free.filter((f) => f.minutes >= minMinutes),
      note,
      snapshotDate: ts.snapshotDate,
      scope: ts.scope,
    };
  } catch (err) {
    log.warn("clemson room availability failed", { err: String(err) });
    return null;
  }
}
