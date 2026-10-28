# Search freshness with IndexNow

The app announces completed or reidentified public transcripts to Bing's
IndexNow endpoint. It sends the canonical HTML, text and JSON URLs, without
transcript content or user data. The hook runs after the completed row is saved,
including the resumed/reidentification pipeline and applied timestamp realignments.
Off-record-only, suppressed,
removed and non-public-language transcripts are excluded.

Automatic submissions require production `NODE_ENV`, canonical
`BASE_URL=https://transcripts.un.org`, and a production Vercel environment when
applicable. Development and preview deployments do not announce URLs.
`INDEXNOW_ENABLED=false` disables automatic submission.

The public ownership key is in `lib/indexnow.ts`; its matching UTF-8 file ships
in `public/`. It is a public verification token, not a credential. There is no
additional service or database migration to operate.

Each submission has a five-second timeout and up to three attempts for network
errors, HTTP 429 or server errors. Accepted batches produce structured
`type=indexnow` logs. Final automatic failures are logged and reported to Sentry
without failing the transcript. Retries are bounded within the publishing job;
there is no durable queue, so an exhausted failure/process crash requires a
manual resubmission. HTTP 200/202 confirms receipt, not crawling or indexing.

## Announce the visible HTML fix once

First deploy this change so the verification file is publicly reachable.
From a configured checkout, prepare a read-only manifest:

```sh
pnpm indexnow -- --html-fix --out=/tmp/indexnow-html-fix.json
```

Then submit the affected canonical HTML pages:

```sh
pnpm indexnow -- --html-fix --out=/tmp/indexnow-html-fix.json --submit
```

This command verifies the public key before submitting anything, deduplicates
URLs, and sends batches of at most 1,000. It selects completed, non-suppressed
transcripts in supported locales for non-removed videos. Text/JSON are not
included in this one-time operation because the reveal-script fix changed HTML
only. Do not schedule this full resubmission repeatedly.

For a failed individual notification, use repeated `--url=...` arguments:

```sh
pnpm indexnow -- --url=https://transcripts.un.org/en/sc/10245 --submit
```

## Sitemap dates

Meeting `lastmod` uses the latest video/transcript update for each language.
Unchanged schedule syncs and unchanged official-record availability checks
preserve the video's revision timestamp while still refreshing their check times.
Multiple completed transcript versions cannot overwrite
a newer sitemap date with an older one.

HTML dates also include the fixed revision in `lib/meeting-freshness.ts`, recording
the October 28, 2026 visible-HTML deployment. Advance this only for meaningful
meeting HTML changes, never for routine deploys. Text dates retain their own
content revision. Static pages omit `lastmod` until a reliable revision source
exists, rather than claiming a new edit every time the sitemap is generated.

Inspect Bing Webmaster Tools' indexed and live HTML, and correlate crawler
access logs after submissions. Copilot may still use a separate stale extraction;
IndexNow does not offer a maximum refresh delay.
