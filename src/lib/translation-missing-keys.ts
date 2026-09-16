import { locales, type Locale } from "@/i18n/config";
import { getSiteSetting, setSiteSetting } from "@/lib/site-settings";
import { auditTranslationKeys } from "@/lib/i18n-audit";
import { setMessageOverride } from "@/lib/message-overrides";

const MESSAGE_MODULES = [
  "common",
  "landing",
  "catalog",
  "premium",
  "auth",
  "dashboard",
  "admin",
  "designer",
  "creator",
  "support",
  "licenses",
  "toast",
  "ecosystem",
  "media",
  "shop",
  "security",
  "sounds",
  "email",
  "chat",
  "search",
] as const;

const MISSING_LOG_KEY = "translation_missing_log";

type MissingLog = Record<string, { count: number; lastSeen: string; samples: string[] }>;

async function readModule(locale: Locale, mod: string): Promise<Record<string, unknown>> {
  try {
    const raw = await import(`../messages/${locale}/${mod}.json`);
    return raw.default as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || Array.isArray(acc)) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export async function logMissingTranslationKey(key: string) {
  const store = await getSiteSetting<MissingLog>(MISSING_LOG_KEY, {});
  const row = store[key] ?? { count: 0, lastSeen: "", samples: [] };
  row.count += 1;
  row.lastSeen = new Date().toISOString();
  if (!row.samples.includes(key)) row.samples = [key, ...row.samples].slice(0, 5);
  store[key] = row;
  await setSiteSetting(MISSING_LOG_KEY, store);
}

export async function getMissingTranslationReport() {
  const audit = await auditTranslationKeys("en");
  const runtimeLog = await getSiteSetting<MissingLog>(MISSING_LOG_KEY, {});
  const totalMissing = audit.locales.reduce((n, l) => n + l.missing.length, 0);
  return {
    uiMissingKeys: totalMissing,
    locales: audit.locales.map((l) => ({ locale: l.locale, missing: l.missing.length })),
    runtimeMissing: Object.keys(runtimeLog).length,
    topRuntimeKeys: Object.entries(runtimeLog)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([key, meta]) => ({ key, ...meta })),
  };
}

/**
 * Fill missing UI keys in other locales with the English placeholder, stored as
 * message overrides (DB) rather than writing to the shipped locale JSON files —
 * those files are bundled at build time and aren't writable at runtime.
 */
export async function syncMissingUiKeysFromEnglish() {
  const reference = await auditTranslationKeys("en");
  let added = 0;

  for (const localeResult of reference.locales) {
    const locale = localeResult.locale;
    if (!localeResult.missing.length) continue;

    const byModule: Record<string, string[]> = {};
    for (const key of localeResult.missing) {
      const mod = key.split(".")[0] ?? "common";
      if (!(MESSAGE_MODULES as readonly string[]).includes(mod)) continue;
      byModule[mod] = byModule[mod] ?? [];
      byModule[mod].push(key);
    }

    for (const [mod, keys] of Object.entries(byModule)) {
      const enData = await readModule("en", mod);
      for (const key of keys) {
        const enVal = getByPath(enData, key);
        if (typeof enVal === "string") {
          await setMessageOverride(locale, key, enVal);
          added++;
        }
      }
    }
  }

  return { added, locales: locales.filter((l) => l !== "en") };
}

export { MESSAGE_MODULES };
