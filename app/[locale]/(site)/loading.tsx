import { HomePageSkeleton } from "@/components/home-page-skeleton";

// Loading fallback scoped to non-meeting pages. Fires during transitions to
// /[locale], /[locale]/about, /[locale]/login, /[locale]/verify,
// /[locale]/subscriptions. Keep it below the (site) route group so meeting
// pages don't inherit a Suspense boundary that hides their initial HTML.
// Speakers routes retain their own loading fallbacks outside this group.
//
// Homepage is the highest-traffic landing this fires for, so the skeleton
// silhouette matches it. The static auth/about pages render too fast for
// this loader to be noticed.
export default function Loading() {
  return <HomePageSkeleton />;
}
