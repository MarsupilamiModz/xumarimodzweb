import { createHash, randomBytes } from "crypto";
import { getDb } from "@/lib/db";
import type { Prisma, UserSecurityEventType } from "@prisma/client";

export const STAFF_MFA_REQUIRED_ROLES = [
  "OWNER",
  "ADMIN",
  "MODERATOR",
  "SUPPORT",
  "CREATOR",
  "PARTNER",
  "DESIGNER",
] as const;

export function requiresMfa(role: string): boolean {
  return (STAFF_MFA_REQUIRED_ROLES as readonly string[]).includes(role);
}

export async function logSecurityEvent(params: {
  userId: string;
  eventType: UserSecurityEventType;
  ipHash?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}) {
  return (await getDb()).userSecurityEvent.create({
    data: {
      userId: params.userId,
      eventType: params.eventType,
      ipHash: params.ipHash,
      userAgent: params.userAgent?.slice(0, 512),
      metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(4).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-")
  );
}

export async function storeBackupCodes(userId: string, codes: string[]) {
  await (await getDb()).userMfaBackupCode.deleteMany({ where: { userId } });
  await (await getDb()).userMfaBackupCode.createMany({
    data: codes.map((code) => ({
      userId,
      codeHash: hashBackupCode(code.replace(/-/g, "").toLowerCase()),
    })),
  });
}

export async function verifyBackupCode(userId: string, code: string): Promise<boolean> {
  const normalized = code.replace(/-/g, "").toLowerCase();
  const hash = hashBackupCode(normalized);
  const row = await (await getDb()).userMfaBackupCode.findFirst({
    where: { userId, codeHash: hash, usedAt: null },
  });
  if (!row) return false;
  await (await getDb()).userMfaBackupCode.update({
    where: { id: row.id },
    data: { usedAt: new Date() },
  });
  return true;
}

export async function getSecurityDashboard(userId: string) {
  const [user, events, backupCount] = await Promise.all([
    (await getDb()).user.findUnique({
      where: { id: userId },
      select: { mfaEnabled: true, mfaEnabledAt: true, emailVerified: true, role: true },
    }),
    (await getDb()).userSecurityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    (await getDb()).userMfaBackupCode.count({ where: { userId, usedAt: null } }),
  ]);

  const failedLogins = events.filter((e) => e.eventType === "LOGIN_FAILED").length;

  return {
    mfaEnabled: user?.mfaEnabled ?? false,
    mfaEnabledAt: user?.mfaEnabledAt,
    mfaRequired: user ? requiresMfa(user.role) : false,
    backupCodesRemaining: backupCount,
    failedLoginAttempts: failedLogins,
    recentEvents: events,
  };
}
