import Image from "next/image";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Menu } from "lucide-react";
import { LanguagePicker } from "@/components/language-picker";
import { TimezonePicker } from "@/components/timezone-picker";
import { AuthControl } from "@/components/auth-control";
import { AuthNavLinks } from "@/components/auth-nav-links";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { typography } from "@/lib/typography";
import { pageWidth, widePageWidth } from "@/lib/layout";
import { cn } from "@/lib/utils";

const navLinkClass = cn(
  typography.meta,
  "transition-colors hover:text-foreground",
);

// Page-level nav links: About + the auth-gated Speakers/Subscriptions.
// On mobile these collapse into the hamburger; on md+ they sit inline.
function HeaderPageLinks() {
  const t = useTranslations("header");
  return (
    <>
      <AuthNavLinks />
      <Link href="/about" className={navLinkClass}>
        {t("about")}
      </Link>
    </>
  );
}

// Preference cluster (timezone → language). Stays visible on mobile in a
// compact form (abbreviation + locale code, no chevron) rather than hiding
// behind the hamburger — switching language is a common first action for
// non-English visitors. Language is the rightmost preference because it sits
// closest to the account avatar; both belong to "this is your view of the
// site". gap-1 reads as one paired control rather than two floating pills.
function HeaderPickers({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <TimezonePicker compact={compact} />
      <LanguagePicker compact={compact} />
    </div>
  );
}

export function SiteHeader({ wide = false }: { wide?: boolean }) {
  const t = useTranslations("header");
  // Breakpoint above which the emblem moves outboard into the page margin.
  // - Default container is max-w-5xl (1024px); outboard needs ~46px of side
  //   margin → viewport ≥ ~1070px. We use 1152px for comfortable breathing.
  // - Wide container is max-w-7xl (1280px); we need ~1326px before the emblem
  //   even fits, so we wait for 1408px before folding outboard. Below that it
  //   stays inline next to the wordmark.
  const outboardOnly = wide
    ? "hidden min-[1408px]:block"
    : "hidden min-[1152px]:block";
  const inlineOnly = wide ? "min-[1408px]:hidden" : "min-[1152px]:hidden";
  return (
    <header className="relative border-b border-border py-3">
      <div
        className={cn(
          "relative mx-auto flex items-center gap-4 px-4 sm:px-8",
          wide ? widePageWidth : pageWidth,
        )}
      >
        {/* On wide viewports the square emblem sits in the page margin
            immediately to the left of the centered container; on smaller
            viewports it folds back inline with the wordmark. Both branches
            share the same logical Link so the entire branding click target
            stays unified. */}
        {/* Emblem aspect is ≈1.198:1 (wider than tall); arbitrary widths
            below = round(height × 1.198). Explicit width is also required on
            the absolutely-positioned anchor since the global
            `img, video { max-width: 100% }` reset would otherwise clamp to the
            parent's containing-block width — and an absolute parent with no
            defined width collapses to 0.

            The 24.74px right offset overshoots into the container's px-8
            padding zone so the visible gap between emblem and "United Nations"
            equals the original horizontal logo's emblem-wordmark gap
            (23.01/126.89 ≈ 18.14% of emblem height → 7.26px at h-10). */}
        <Link
          href="/"
          aria-label={t("logoAlt")}
          className={cn(
            "absolute end-[calc(100%-24.74px)] top-1/2 h-10 w-[47.9px] -translate-y-1/2 transition-opacity hover:opacity-75",
            outboardOnly,
          )}
        >
          <Image
            src="/images/un-emblem-colour.svg"
            alt=""
            width={152}
            height={127}
            className="h-10 w-[47.9px] shrink-0 select-none"
            draggable={false}
          />
        </Link>
        <Link
          href="/"
          aria-label={t("logoAlt")}
          className="inline-flex items-center gap-2.5 transition-opacity hover:opacity-75"
        >
          <Image
            src="/images/un-emblem-colour.svg"
            alt=""
            width={152}
            height={127}
            className={cn("h-10 w-[47.9px] shrink-0 select-none", inlineOnly)}
            draggable={false}
          />
          {/* Mobile: wordmark + "Public Preview" badge stack vertically so the
              title can shrink and the badge stays visible without competing for
              row width with the pickers/menu. md+: original inline layout. */}
          <span className="flex flex-col items-start gap-1 md:flex-row md:items-center md:gap-2.5">
            {/* Both words are real text so the baseline lines up perfectly;
                same size, only the weight differs. Brand-first wordmark
                regardless of locale grammar — this is a logotype, not a sentence. */}
            <span className="text-lg leading-none tracking-tight text-foreground md:text-[23.83px]">
              <span className="hidden font-bold md:inline">
                {t("wordmarkBrand")}{" "}
              </span>
              <span className="font-light">{t("wordmarkDescriptor")}</span>
            </span>
            <span className="rounded-md bg-un-blue/10 px-1.5 py-0.5 text-[10px] leading-none font-semibold whitespace-nowrap text-un-blue md:px-2 md:py-1 md:text-xs">
              {t("publicPreview")}
            </span>
          </span>
        </Link>
        <div className="ms-auto flex items-center gap-3">
          {/* md+: full inline nav (page links + full-width pickers).
              Below md the page links collapse into the hamburger but the
              pickers stay visible in a compact form — switching language is
              a common first action for non-English visitors and shouldn't
              hide behind a menu.
              gap-3 (12 px) instead of gap-4 (16 px): the language and timezone
              pills carry internal horizontal padding, so the perceived gap
              between two pills is gap + 2·pad. gap-3 keeps the pill-to-pill
              spacing legible without the row feeling loose. */}
          <div className="hidden items-center gap-3 md:flex">
            <HeaderPageLinks />
            <HeaderPickers />
          </div>
          <div className="flex items-center md:hidden">
            <HeaderPickers compact />
          </div>
          <Popover>
            <PopoverTrigger
              aria-label={t("openMenu")}
              className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:hidden"
            >
              <Menu className="h-5 w-5" />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="flex w-56 flex-col gap-3 p-3"
            >
              <HeaderPageLinks />
              <AuthControl inline />
            </PopoverContent>
          </Popover>
          <div className="hidden md:flex">
            <AuthControl />
          </div>
        </div>
      </div>
    </header>
  );
}
