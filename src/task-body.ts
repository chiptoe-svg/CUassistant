export function formatTaskBody(auditMarker?: string): string {
  if (!auditMarker) return "";
  return `CUassistant ref: ${compactAuditMarker(auditMarker)}`;
}

export function taskMarkerNeedles(auditMarker: string): string[] {
  return [auditMarker, formatTaskBody(auditMarker)];
}

function compactAuditMarker(auditMarker: string): string {
  return auditMarker.replace(/^cuassistant:/, "").slice(0, 12);
}
