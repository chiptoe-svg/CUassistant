// Rudimentary private-information detector for the OpenAI advisor track.
//
// Precision over recall, on purpose. This gate blocks a send and asks a human to
// confirm; a detector that false-fires on ordinary advising prose trains
// advisors to click through, which destroys the value of the true positives. So
// it matches only HIGH-SIGNAL structured identifiers and deliberately does NOT
// attempt name detection — names false-fire on course titles, buildings, and
// instructor names. Names are covered by the standing "de-identified only"
// banner and the switch-to-OpenAI confirm instead.
//
// It is not a security boundary (trusted staff behind auth) — it is a guardrail
// against an accidental paste. The server enforces it as a soft gate: flagged
// text is refused until the advisor explicitly consents.

export interface PrivacyFlag {
  category: string;
  sample: string;
}

const PATTERNS: { category: string; re: RegExp }[] = [
  { category: "Clemson student ID", re: /\bC\d{8}\b/ },
  { category: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { category: "email address", re: /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/ },
  // 10-digit US phone with optional country code and common separators.
  { category: "phone number", re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  // "GPA" adjacent to a number (e.g. "GPA 3.42", "GPA: 3.4").
  { category: "GPA", re: /\bGPA\b[^\d\n]{0,6}\d(?:\.\d{1,3})?/i },
  // A bare run of 7+ digits — student/employee IDs without the C prefix. CRNs
  // (5), course numbers (4), and years (4) are shorter and do not match.
  { category: "long digit sequence", re: /\b\d{7,}\b/ },
];

export function flagLikelyPrivate(text: string): PrivacyFlag[] {
  const flags: PrivacyFlag[] = [];
  for (const { category, re } of PATTERNS) {
    const m = text.match(re);
    if (m) flags.push({ category, sample: m[0].trim() });
  }
  return flags;
}
