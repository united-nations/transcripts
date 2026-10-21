import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";
import {
  publicCorsHeaderList,
  securityHeaderList,
} from "./lib/security-headers";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  transpilePackages: ["@un-eosg/ui"],
  // Standalone build collects only the server + its traced deps into
  // `.next/standalone`, which is what the Azure container runs (`node
  // server.js`). Vercel ignores this and uses its own build pipeline.
  output: "standalone",
  // Drop the `X-Powered-By: Next.js` framework-fingerprint header.
  poweredByHeader: false,
  // Load pdfjs-dist and its Node canvas polyfill from node_modules at runtime
  // instead of bundling them into a route chunk. `@napi-rs/canvas` ships a
  // native `.node` binary that can't be bundled, and keeping pdfjs external
  // makes ESM evaluation order deterministic so lib/pdfjs-node-globals.ts runs
  // before pdf.mjs. See lib/pv-parser.ts for the full DOMMatrix crash writeup.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  // next-intl loads message catalogs at runtime via dynamic import — the
  // standalone tracer doesn't always pick them up. Be explicit.
  outputFileTracingIncludes: {
    "/**/*": ["messages/**/*", "i18n/**/*"],
  },
  // Baseline security headers for every response. Verified to reach all route
  // types — locale-routed HTML pages, API routes, /openapi, and the middleware-
  // rewritten .json/.txt data API — each exactly once, so proxy.ts does not
  // re-apply them. See lib/security-headers.ts. (No CSP here: that is a staged,
  // report-only-first effort tracked separately to avoid breaking the player.)
  headers: async () => [
    { source: "/(.*)", headers: securityHeaderList },
    // CORS for the static OpenAPI spec in public/. The rest of the public
    // data surface (.json/.txt data API, /llms*.txt) sets the same header in
    // its route handlers instead: config `headers()` match the *incoming*
    // request path, so a source scoped to /api/data would never match the
    // pretty /{locale}/{slug}.json URLs that proxy.ts rewrites there.
    { source: "/openapi.json", headers: publicCorsHeaderList },
  ],
  redirects: async () => [
    {
      source: "/:path*",
      has: [{ type: "host", value: "transcripts.un-two-zero.org" }],
      destination: "https://transcripts.un.org/:path*",
      permanent: true,
    },
  ],
};

// Sentry build-time wrapping: uploads source maps so stack traces in the
// dashboard show original TypeScript instead of compiled JS, and silences the
// SDK's own console noise at build time. Auth via SENTRY_AUTH_TOKEN /
// SENTRY_ORG / SENTRY_PROJECT (set in Vercel env, leave unset locally).
// Source-map upload is skipped automatically when the auth token isn't set,
// so local builds and contributor PRs still succeed.
//
// Skipped in `next dev`: Sentry's bundler plugins + runtime instrumentation
// retain module-graph state under Turbopack HMR, which OOMs the dev server
// after ~25 min of idle polling. Prod builds (and `next start`) still wrap.
export default process.env.NODE_ENV === "development"
  ? withNextIntl(nextConfig)
  : withSentryConfig(withNextIntl(nextConfig), {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: !process.env.CI,
      // Route Sentry events through a same-origin path so ad-blockers and
      // privacy extensions don't drop them (they pattern-match on
      // *.ingest.sentry.io, and some lists also block the default `/monitoring`).
      // Using an app-specific path avoids those known patterns.
      tunnelRoute: "/api/internal/observability",
    });
