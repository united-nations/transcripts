import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { SiteHeader } from "@/components/site-header";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth/service";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("metadata");
  return {
    title: t("loginTitle"),
    robots: { index: false, follow: false },
  };
}

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await getCurrentUser();
  if (user) redirect({ href: "/", locale });

  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-screen flex-col bg-background"
    >
      <SiteHeader />
      <LoginForm />
    </main>
  );
}
