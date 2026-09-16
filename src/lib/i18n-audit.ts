import { locales, type Locale } from "@/i18n/config";
import { MESSAGE_MODULES } from "@/lib/translation-missing-keys";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

async function loadLocaleKeys(locale: Locale): Promise<Set<string>> {
  const merged: Record<string, unknown> = {};
  for (const mod of MESSAGE_MODULES) {
    try {
      const raw = await import(`../messages/${locale}/${mod}.json`);
      Object.assign(merged, raw.default as Record<string, unknown>);
    } catch {
      /* missing module file */
    }
  }
  return new Set(flattenKeys(merged));
}

export type TranslationAuditResult = {
  referenceLocale: Locale;
  totalReferenceKeys: number;
  locales: {
    locale: Locale;
    keyCount: number;
    missing: string[];
    extra: string[];
  }[];
  summary: string;
};

export async function auditTranslationKeys(
  referenceLocale: Locale = "en"
): Promise<TranslationAuditResult> {
  const reference = await loadLocaleKeys(referenceLocale);
  const refArr = Array.from(reference).sort();

  const localeResults = await Promise.all(
    locales
      .filter((l) => l !== referenceLocale)
      .map(async (locale) => {
        const keys = await loadLocaleKeys(locale);
        const missing = refArr.filter((k) => !keys.has(k));
        const extra = Array.from(keys)
          .filter((k) => !reference.has(k))
          .sort();
        return { locale, keyCount: keys.size, missing, extra };
      })
  );

  const totalMissing = localeResults.reduce((n, r) => n + r.missing.length, 0);

  return {
    referenceLocale,
    totalReferenceKeys: reference.size,
    locales: localeResults,
    summary:
      totalMissing === 0
        ? `All ${locales.length} locales match ${referenceLocale} (${reference.size} keys).`
        : `${totalMissing} missing key(s) across non-reference locales.`,
  };
}
