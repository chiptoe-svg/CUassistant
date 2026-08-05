export interface NavigatorScheduleResult {
  schema: string;
  sanitized: {
    schema: string;
    courses: {
      code: string;
      section: string;
      type: string;
      title: string;
      instructor: string;
      days: string;
      time: string;
      room: string;
      dates: string;
    }[];
  };
  markdown: string;
  warnings: string[];
  metrics: { label: string; value: string }[];
  preview: string;
}
export interface NavigatorScheduleModule {
  id: string;
  label: string;
  description: string;
  accepts: ("pdf" | "text")[];
  detect(text: string): boolean;
  clean(rawText: string): NavigatorScheduleResult;
}
export const navigatorScheduleModule: NavigatorScheduleModule;
