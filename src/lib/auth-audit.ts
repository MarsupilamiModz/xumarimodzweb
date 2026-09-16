import type { Prisma } from "@prisma/client";
import { getDb } from "@/lib/db";

/** Persist auth events for Owner diagnostics (non-blocking). */
export async function persistAuthAudit(
  action: string,
  metadata?: Record<string, unknown>
) {
  try {
    await (await getDb()).auditLog.create({
      data: {
        action,
        entityType: "Auth",
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch {
    /* audit table may be unavailable during migrations */
  }
}
