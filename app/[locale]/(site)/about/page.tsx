import { getLocale, getTranslations } from "next-intl/server";
import { SiteHeader } from "@/components/site-header";
import { ExternalLink } from "@/components/external-link";
import { Link } from "@/i18n/navigation";
import { alternatesFor } from "@/i18n/routing";
import { webtvUrl } from "@/lib/un-links";
import { typography } from "@/lib/typography";
import { pageWidth } from "@/lib/layout";
import { cn } from "@/lib/utils";
// import { STT_ROUTING } from "@/lib/providers/config";
// import { getProvider } from "@/lib/providers/registry";
// import { UN_LANGUAGES, getLanguageDisplayName } from "@/lib/languages";
import { getCurrentUser } from "@/lib/auth/service";
import { ExperimentalWaitlistButton } from "@/components/experimental-waitlist-button";

// Reads the current user to decide whether to render the experimental-features
// section (logged-in users only); must render dynamically per viewer.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    title: t("aboutTitle"),
    description: t("aboutDescription"),
    alternates: alternatesFor(locale, "/about"),
  };
}

/** Per-language transcription-model rows, derived from config. */
// const STT_ROWS = UN_LANGUAGES.map(({ code }) => ({
//   language: getLanguageDisplayName(code),
//   provider: getProvider(STT_ROUTING[code] ?? STT_ROUTING.floor).label,
// }));

function Step({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-un-blue/10 text-sm font-bold text-un-blue-text">
        {number}
      </div>
      <div className="pt-0.5">
        <h3 className={cn(typography.subTitle, "mb-1.5")}>{title}</h3>
        <div className="text-sm leading-relaxed text-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

export default async function AboutPage() {
  // Only show the experimental-features section to logged-in users;
  // anonymous viewers don't see it at all.
  const user = await getCurrentUser();
  const t = await getTranslations("about");
  const tHome = await getTranslations("home");
  const locale = await getLocale();

  const whoForItems: string[] = [
    t("whoIsItFor.item1"),
    t("whoIsItFor.item2"),
    t("whoIsItFor.item3"),
    t("whoIsItFor.item4"),
    t("whoIsItFor.item5"),
  ];
  const coverageItems: string[] = [
    t("coverage.item1"),
    t("coverage.item2"),
    t("coverage.item3"),
    t("coverage.item4"),
    t("coverage.item5"),
  ];
  const accuracyIssues: string[] = [
    t("accuracy.issue1"),
    t("accuracy.issue2"),
    t("accuracy.issue3"),
  ];

  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-background">
      <SiteHeader />
      <div className={cn("mx-auto px-4 pb-12 sm:px-8", pageWidth)}>
        <nav className="py-3">
          <Link
            href="/"
            className={cn(
              typography.caption,
              "transition-colors hover:text-foreground",
            )}
          >
            {tHome("backToHomepage")}
          </Link>
        </nav>
        <div className="max-w-2xl">
          <div className="mb-10">
            <h1 className={cn(typography.pageTitle, "mb-3")}>
              {t("pageTitle")}
            </h1>
          </div>

          <div className={cn(typography.prose, "space-y-10")}>
            <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("whatIsThis.heading")}
              </h2>
              <p className="text-foreground">
                {t.rich("whatIsThis.body", {
                  webtvLink: (chunks) => (
                    <ExternalLink
                      href={webtvUrl("", locale)}
                      className="text-un-blue-text underline underline-offset-4 hover:opacity-75"
                    >
                      {chunks}
                    </ExternalLink>
                  ),
                })}
              </p>
            </section>

            <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("whoIsItFor.heading")}
              </h2>
              <p className="mb-3 text-foreground">{t("whoIsItFor.intro")}</p>
              <ul className="list-disc space-y-1.5 pl-5 text-foreground">
                {whoForItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("coverage.heading")}
              </h2>
              <p className="mb-3 text-foreground">{t("coverage.intro")}</p>
              <ul className="list-disc space-y-1.5 pl-5 text-foreground">
                {coverageItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="mt-3 text-foreground">{t("coverage.closed")}</p>
            </section>

            <section>
              <h2 className={cn(typography.sectionTitle, "mb-5")}>
                {t("howItWorks.heading")}
              </h2>
              <div className="space-y-6">
                <Step number="1" title={t("howItWorks.step1Title")}>
                  {t("howItWorks.step1Body")}
                </Step>
                <Step number="2" title={t("howItWorks.step2Title")}>
                  {t("howItWorks.step2Body")}
                </Step>
                <Step number="3" title={t("howItWorks.step3Title")}>
                  {t("howItWorks.step3Body")}
                </Step>
                <Step number="4" title={t("howItWorks.step4Title")}>
                  {t("howItWorks.step4Body")}
                </Step>
                <Step number="5" title={t("howItWorks.step5Title")}>
                  {t.rich("howItWorks.step5Body", {
                    pvLink: (chunks) => (
                      <ExternalLink
                        href="https://www.un.org/dgacm/en/content/verbatim-reporting"
                        className="text-un-blue-text underline underline-offset-4 hover:opacity-75"
                      >
                        {chunks}
                      </ExternalLink>
                    ),
                    srLink: (chunks) => (
                      <ExternalLink
                        href="https://research.un.org/en/docs/meetings"
                        className="text-un-blue-text underline underline-offset-4 hover:opacity-75"
                      >
                        {chunks}
                      </ExternalLink>
                    ),
                  })}
                </Step>
              </div>
            </section>

            {/* <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("models.heading")}
              </h2>
              <p className="mb-4 text-foreground">{t("models.intro")}</p>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-medium">
                        {t("models.colLanguage")}
                      </th>
                      <th className="px-4 py-2 font-medium">
                        {t("models.colModel")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {STT_ROWS.map((row) => (
                      <tr key={row.language} className="border-b last:border-0">
                        <td className="px-4 py-2">{row.language}</td>
                        <td className="px-4 py-2 text-foreground">
                          {row.provider}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-foreground">
                {t("models.postProcessing")}
              </p>
            </section> */}

            <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("accuracy.heading")}
              </h2>
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="mb-2 font-semibold">{t("accuracy.para1")}</p>
                <p>
                  {t.rich("accuracy.para2", {
                    odsLink: (chunks) => (
                      <ExternalLink
                        href="https://documents.un.org"
                        className="underline underline-offset-2 hover:opacity-75"
                      >
                        {chunks}
                      </ExternalLink>
                    ),
                  })}
                </p>
              </div>
              <p className="mb-3 text-foreground">
                {t("accuracy.issuesIntro")}
              </p>
              <ul className="space-y-2 text-foreground">
                {accuracyIssues.map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-un-blue/50" />
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("sources.heading")}
              </h2>
              <ul className="space-y-3 text-foreground">
                <li className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-un-blue" />
                  <span>
                    <strong>{t("sources.webtvLabel")}</strong>{" "}
                    {t("sources.webtvBody")}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-un-blue" />
                  <span>
                    <strong>{t("sources.odsLabel")}</strong>{" "}
                    {t("sources.odsBody")}
                  </span>
                </li>
              </ul>
            </section>

            <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("api.heading")}
              </h2>
              <p className="mb-4 text-foreground">
                {t.rich("api.intro", {
                  code: (chunks) => (
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">
                      {chunks}
                    </code>
                  ),
                })}
              </p>
              <p className="mb-4 text-foreground">
                {t.rich("api.search", {
                  locale,
                  code: (chunks) => (
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">
                      {chunks}
                    </code>
                  ),
                })}
              </p>
              <h3 className={cn(typography.subTitle, "mb-1.5")}>
                {t("api.forAgents.heading")}
              </h3>
              <p className="text-foreground">
                {t.rich("api.forAgents.body", {
                  llmsLink: (chunks) => (
                    <ExternalLink
                      href="/llms.txt"
                      className="text-un-blue-text underline underline-offset-4 hover:opacity-75"
                    >
                      {chunks}
                    </ExternalLink>
                  ),
                  openapiLink: (chunks) => (
                    <ExternalLink
                      href="/openapi"
                      className="text-un-blue-text underline underline-offset-4 hover:opacity-75"
                    >
                      {chunks}
                    </ExternalLink>
                  ),
                })}
              </p>
            </section>

            <section>
              <h2 className={cn(typography.sectionTitle, "mb-3")}>
                {t("status.heading")}
              </h2>
              <p className="text-foreground">
                {t.rich("status.body", {
                  publicPreview: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            </section>

            {user && (
              <section>
                <h2 className={cn(typography.sectionTitle, "mb-3")}>
                  {t("experimental.heading")}
                </h2>
                <p className="mb-3 text-foreground">{t("experimental.body")}</p>
                {user.experimentalAccess ? (
                  <p className="text-foreground">
                    {t("experimental.alreadyHaveAccess")}
                  </p>
                ) : (
                  <ExperimentalWaitlistButton
                    initialOnWaitlist={user.experimentalWaitlistAt !== null}
                  />
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
