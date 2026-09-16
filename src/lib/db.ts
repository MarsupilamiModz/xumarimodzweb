import { PrismaClient } from "@prisma/client";
import { cache } from "react";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaConnecting: Promise<void> | undefined;
};

const ON_CLOUDFLARE = process.env.NEXT_RUNTIME_TARGET === "cloudflare";

function createNodeClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

/**
 * Builds a Prisma client backed by Cloudflare Hyperdrive. Hyperdrive pools
 * connections server-side, so this is intentionally cheap to construct —
 * `maxUses: 1` tells the local pg Pool to hand back a fresh connection per
 * query rather than hold one open across a Worker isolate that can be
 * recycled at any time.
 */
async function createCloudflareClient(): Promise<PrismaClient> {
  const [{ getCloudflareContext }, { PrismaPg }] = await Promise.all([
    import("@opennextjs/cloudflare"),
    import("@prisma/adapter-pg"),
  ]);
  const { env } = await getCloudflareContext({ async: true });
  const adapter = new PrismaPg({
    connectionString: (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE
      .connectionString,
    maxUses: 1,
  });
  return new PrismaClient({ adapter });
}

/**
 * Resolves the active Prisma client for the current request. On Cloudflare
 * Workers, `React.cache()` dedupes this within a single request so callers
 * can call `getDb()` freely without building a new adapter per query; on the
 * Node/PM2 deployment it resolves to one process-wide singleton, matching
 * standard Prisma guidance for long-lived servers.
 */
export const getDb = cache(async (): Promise<PrismaClient> => {
  if (ON_CLOUDFLARE) return createCloudflareClient();
  globalForPrisma.prisma ??= createNodeClient();
  return globalForPrisma.prisma;
});

/** Warm connection before critical auth paths (pooler cold start). No-op on Cloudflare. */
export async function warmDbConnection() {
  if (ON_CLOUDFLARE) return;
  if (!globalForPrisma.prismaConnecting) {
    globalForPrisma.prismaConnecting = (async () => {
      const db = await getDb();
      try {
        await db.$connect();
      } catch {
        /* already connected or connecting */
      }
      await db.$queryRaw`SELECT 1`;
    })();
  }
  await globalForPrisma.prismaConnecting;
}

const RETRYABLE =
  /connection|timeout|pool|econnrefused|can't reach|server has closed|too many clients|engine is not yet connected|not yet connected|p1001|p1002|p1008|p1017/i;

export function isRetryableDbError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: string }).code);
    if (/^P100[128]|^P1017/.test(code)) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE.test(msg);
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; delayMs?: number; label?: string } = {}
): Promise<T> {
  const { retries = 4, delayMs = 250, label = "db" } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) await warmDbConnection();
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableDbError(err) || attempt === retries) throw err;
      console.warn(`[${label}] retry ${attempt + 1}/${retries}`, err instanceof Error ? err.message : err);
      if (!ON_CLOUDFLARE) {
        globalForPrisma.prismaConnecting = undefined;
        try {
          await (await getDb()).$connect();
        } catch {
          /* reconnect best-effort */
        }
      }
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }

  throw lastError;
}

/** Use inside unstable_cache callbacks so revalidation waits for a live Prisma engine. */
export async function runCachedQuery<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await warmDbConnection();
  return withDbRetry(fn, { label, retries: 3 });
}

export async function checkDbHealth(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await warmDbConnection();
    await withDbRetry(async () => (await getDb()).$queryRaw`SELECT 1`, {
      retries: 2,
      label: "health",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "Connection failed",
    };
  }
}

if (typeof window === "undefined") {
  void warmDbConnection().catch(() => undefined);
}
