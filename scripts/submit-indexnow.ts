#!/usr/bin/env tsx
import "../lib/load-env";
import { writeFile } from "node:fs/promises";
import { routing } from "../i18n/routing";
import { getSitemapMeetingLanguages, pool } from "../lib/db";
import { videoUrl } from "../lib/video-url";
import {
  INDEXNOW_ORIGIN,
  indexNowUrls,
  submitIndexNow,
  verifyIndexNowKey,
} from "../lib/indexnow";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const htmlFix = args.includes("--html-fix");
const submit = args.includes("--submit");
const urls = args
  .filter((arg) => arg.startsWith("--url="))
  .map((arg) => arg.slice(6));
const output = args.find((arg) => arg.startsWith("--out="))?.slice(6);

async function main() {
  if (
    (htmlFix && urls.length) ||
    (!htmlFix && !urls.length) ||
    args.some(
      (arg) =>
        !["--html-fix", "--submit"].includes(arg) &&
        !arg.startsWith("--url=") &&
        !arg.startsWith("--out="),
    )
  ) {
    throw new Error(
      "Usage: pnpm indexnow -- (--html-fix | --url=https://transcripts.un.org/en/sc/10245) [--out=manifest.json] [--submit]\n" +
        "Default is dry-run. --html-fix announces the changed HTML of all completed public transcript pages once; run after deployment.",
    );
  }
  const targets = htmlFix
    ? (await getSitemapMeetingLanguages(routing.locales)).map(
        (row) => `${INDEXNOW_ORIGIN}/${row.languageCode}/${videoUrl(row)}`,
      )
    : urls;
  const urlList = indexNowUrls(targets);
  const manifest = {
    reason: htmlFix ? "visible-transcript-html-fix" : "explicit-urls",
    urlList,
  };
  if (output) await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    JSON.stringify({
      mode: submit ? "submit" : "dry-run",
      count: urlList.length,
      ...(!output ? manifest : { output }),
    }),
  );
  if (submit && urlList.length) {
    await verifyIndexNowKey();
    const count = await submitIndexNow(urlList);
    console.log(
      `IndexNow received ${count} URLs. This does not confirm crawling or indexing.`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
