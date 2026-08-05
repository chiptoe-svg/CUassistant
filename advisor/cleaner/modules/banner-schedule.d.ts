export interface BannerScheduleResult {
  schema: string;
  sanitized: {
    schema: string;
    term: string | null;
    totalCredits: number;
    courses: {
      code: string;
      section: string;
      title: string;
      crn: string;
      credits: number;
      status: string;
      instructor: string;
    }[];
  };
  markdown: string;
  warnings: string[];
  metrics: { label: string; value: string }[];
  preview: string;
}
export interface BannerScheduleModule {
  id: string;
  label: string;
  description: string;
  accepts: ("pdf" | "text")[];
  clean(rawText: string): BannerScheduleResult;
}
export const bannerScheduleModule: BannerScheduleModule;
