// Meaningful HTML revision: the deployed fix made speeches visible without
// React's reveal scripts. Do not advance this for routine deployments or at
// request time; update only when the public meeting representation changes.
export const MEETING_HTML_UPDATED_AT = new Date("2026-10-28T16:47:05Z");

export function meetingHtmlLastModified(contentUpdatedAt: Date): Date {
  return new Date(
    Math.max(contentUpdatedAt.getTime(), MEETING_HTML_UPDATED_AT.getTime()),
  );
}
