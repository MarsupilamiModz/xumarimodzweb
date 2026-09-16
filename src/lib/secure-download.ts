import { createHash } from "crypto";
import { getDb } from "@/lib/db";
import { signDownloadToken } from "@/lib/downloads";

export async function issueSecureDownloadToken(input: {
  modId: string;
  versionId: string;
  userId: string;
  ipHash?: string;
  userAgent?: string;
  ttlMs?: number;
}) {
  const ttl = input.ttlMs ?? 5 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttl);
  const payload = {
    modId: input.modId,
    versionId: input.versionId,
    userId: input.userId,
    exp: expiresAt.getTime(),
  };
  const token = signDownloadToken(payload);
  const tokenHash = createHash("sha256").update(token).digest("hex");

  await (await getDb()).secureDownloadToken.create({
    data: {
      modId: input.modId,
      versionId: input.versionId,
      userId: input.userId,
      tokenHash,
      ipHash: input.ipHash,
      userAgent: input.userAgent?.slice(0, 512),
      expiresAt,
    },
  });

  return { token, tokenHash, expiresAt };
}

export async function validateSecureDownloadToken(token: string, ipHash?: string) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const record = await (await getDb()).secureDownloadToken.findUnique({ where: { tokenHash } });
  if (!record) return null;
  if (record.usedAt) return null;
  if (record.expiresAt < new Date()) return null;
  if (ipHash && record.ipHash && record.ipHash !== ipHash) return null;

  await (await getDb()).secureDownloadToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record;
}

export async function userHasModLicense(userId: string, modId: string) {
  const activation = await (await getDb()).licenseActivation.findFirst({
    where: {
      userId,
      licenseKey: {
        modId,
        status: { in: ["ACTIVE", "REDEEMED"] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    },
  });
  return !!activation;
}
