"use client";

import {
  AccountMenu,
  AccountSection,
} from "@un-eosg/ui/components/account-menu";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/hooks/use-auth";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";

/** Session and navigation belong to transcripts; the account presentation is shared. */
export function AuthControl({ inline = false }: { inline?: boolean }) {
  const { email, loaded } = useAuth();
  const t = useTranslations("header");
  const locale = useLocale();
  if (!loaded) return null;
  if (!email)
    return inline ? (
      <div className="border-t border-border pt-3">
        <Link
          href="/login"
          className={cn(
            typography.meta,
            "transition-colors hover:text-foreground",
          )}
        >
          {t("signIn")}
        </Link>
      </div>
    ) : (
      <Button variant="outline" size="sm" className="shadow-none" asChild>
        <Link href="/login">{t("signIn")}</Link>
      </Button>
    );

  async function signOut() {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("Sign-out request failed");
    // Refresh all session-aware navigation after clearing the cookie.
    window.location.assign("/");
  }
  const Component = inline ? AccountSection : AccountMenu;
  return (
    <Component
      email={email}
      dir={locale === "ar" ? "rtl" : "ltr"}
      labels={{
        accountMenu: t("accountMenu"),
        signedInAs: t("signedInAs"),
        signOut: t("signOut"),
        signingOut: t("signingOut"),
        signOutError: t("signOutError"),
      }}
      onSignOut={signOut}
      className={inline ? "border-t border-border pt-3" : undefined}
    />
  );
}
