export interface CleanerResult {
  schema: string;
  sanitized: {
    schema: string;
    catalogYear: string | null;
    courses: { code: string; prefix: string | null; number: string | null; title: string; term: string; credits: number; status: string }[];
    [k: string]: unknown;
  };
  warnings: string[];
  metrics: { label: string; value: string }[];
  preview: string;
}
export interface CleanerModule {
  id: string;
  label: string;
  description: string;
  accepts: ("pdf" | "text")[];
  clean(rawText: string): CleanerResult;
}
export const degreeWorksModule: CleanerModule;
