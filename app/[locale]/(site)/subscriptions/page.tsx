import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { alternatesFor } from "@/i18n/routing";
import { SiteHeader } from "@/components/site-header";
import { SubscriptionsManager } from "@/components/subscriptions-manager";
import { getCurrentUser } from "@/lib/auth/service";
import { typography } from "@/lib/typography";
import { pageWidth } from "@/lib/layout";
import { cn } from "@/lib/utils";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    title: t("subscriptionsTitle"),
    description: t("subscriptionsDescription"),
    alternates: alternatesFor(locale, "/subscriptions"),
    robots: { index: false, follow: false },
  };
}

export default async function SubscriptionsPage() {
  const user = await getCurrentUser();
  const t = await getTranslations("subscriptions");
  const tHome = await getTranslations("home");

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
            <h1 className={cn(typography.pageTitle, "mb-3")}>{t("title")}</h1>
            <p className={typography.lead}>{t("lead")}</p>
          </div>

          {user ? (
            <SubscriptionsManager />
          ) : (
            <p className={cn(typography.body, "text-muted-foreground")}>
              {t.rich("signInPrompt", {
                signInLink: (chunks) => (
                  <Link
                    href="/login"
                    className="text-un-blue-text hover:underline"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
