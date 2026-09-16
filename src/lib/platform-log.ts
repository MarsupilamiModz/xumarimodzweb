import { getDb } from "@/lib/db";

const KEY = "platform_errors";
const MAX = 100;

export type PlatformErrorEntry = {
  id: string;
  context: string;
  message: string;
  createdAt: string;
};

export async function logPlatformError(context: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[platform:${context}]`, err);

  try {
    const row = await (await getDb()).siteSetting.findUnique({ where: { key: KEY } });
    const existing = (row?.value as PlatformErrorEntry[] | undefined) ?? [];
    const entry: PlatformErrorEntry = {
      id: crypto.randomUUID(),
      context,
      message: message.slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    const next = [entry, ...existing].slice(0, MAX);
    await (await getDb()).siteSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: next as object },
      update: { value: next as object },
    });
  } catch {
    // logging must never throw
  }
}

export async function listPlatformErrors(limit = 50): Promise<PlatformErrorEntry[]> {
  try {
    const row = await (await getDb()).siteSetting.findUnique({ where: { key: KEY } });
    const existing = (row?.value as PlatformErrorEntry[] | undefined) ?? [];
    return existing.slice(0, Math.min(limit, MAX));
  } catch {
    return [];
  }
}

export async function clearPlatformErrors() {
  try {
    await (await getDb()).siteSetting.delete({ where: { key: KEY } });
  } catch {
    // ignore missing row
  }
}
