import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { buildAdsTxtLine, resolveAdsenseClientId } from "@/lib/adsense-config";
import type { AdProviderSettings } from "@/lib/ads";

/**
 * Pre-generates public/ads.txt as a static file for fast CDN serving. Only
 * possible on a writable filesystem (e.g. the Node/PM2 deployment) — on
 * Cloudflare Workers there is none, so this silently no-ops and the dynamic
 * `/ads.txt` route (which reads the same settings from the DB) serves instead.
 */
export function writeAdsTxtFile(settings?: AdProviderSettings) {
  const publisherId = resolveAdsenseClientId(settings);
  const content = `${buildAdsTxtLine(publisherId)}\n`;
  try {
    const publicDir = path.join(process.cwd(), "public");
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(path.join(publicDir, "ads.txt"), content, "utf8");
  } catch {
    /* no writable filesystem (e.g. Cloudflare Workers) — dynamic route covers this */
  }
  return content.trim();
}
