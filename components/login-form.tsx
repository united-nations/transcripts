"use client";

import { useLocale, useTranslations } from "next-intl";
import { SignInCard } from "@un-eosg/ui/components/sign-in-card";

export function LoginForm() {
  const t = useTranslations("login");
  const locale = useLocale();
  async function submit(email: string) {
    const response = await fetch("/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, locale }),
    });
    const result = (await response.json()) as
      { ok: true } | { ok: false; error: string };
    return result.ok && response.ok
      ? { success: true }
      : {
          success: false,
          error: "error" in result ? result.error : t("errorSendFailed"),
        };
  }
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <SignInCard
        headingLevel="h1"
        onSubmit={submit}
        labels={{
          title: t("title"),
          intro: t("subtitle"),
          emailLabel: t("emailLabel"),
          emailPlaceholder: t("emailPlaceholder"),
          submit: t("submit"),
          submitting: t("submitting"),
          sentTitle: t("sentTitle"),
          sentBody: (email) => t("sentBody", { email }),
          sentHint: t("sentSpamHint"),
          errorMessage: t("errorSendFailed"),
        }}
      />
    </div>
  );
}
