"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import type { FileScanStatus, Prisma } from "@prisma/client";
import { getDb } from "@/lib/db";
import { fail, ok, requireActionPermission } from "@/lib/action-utils";
import {
  getMalwareScannerSettings,
  getMalwareScannerSettingsRaw,
  isVirusTotalEnvEnabled,
  saveMalwareScannerSettings,
  type MalwareScannerSettings,
} from "@/lib/malware-settings";
import { getVirusTotalQuota } from "@/lib/security/quota";
import { logSecurityEvent } from "@/lib/security/audit";
import { enqueueScan } from "@/lib/security/scan-queue";
import { isDownloadAllowed } from "@/lib/security/status";
import { CACHE_TAGS } from "@/lib/cache";
import { revalidateLocalizedPaths } from "@/lib/revalidate-locale";

export async function getMalwareSettingsAdmin() {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;
  const settings = await getMalwareScannerSettings();
  const raw = await getMalwareScannerSettingsRaw();
  return ok({
    ...settings,
    virusTotalApiKey: raw.virusTotalApiKey ? "••••••••" : "",
    hasKey: Boolean(raw.virusTotalApiKey || process.env.VIRUSTOTAL_API_KEY),
    envEnabled: isVirusTotalEnvEnabled(),
    envKeyConfigured: Boolean(process.env.VIRUSTOTAL_API_KEY),
  });
}

export async function updateMalwareSettingsAdmin(
  data: Partial<MalwareScannerSettings> & { virusTotalApiKey?: string }
) {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;

  const current = await getMalwareScannerSettingsRaw();
  const next: MalwareScannerSettings = {
    ...current,
    scanThreshold: data.scanThreshold ?? current.scanThreshold,
    autoApproveClean: data.autoApproveClean ?? current.autoApproveClean,
    requireManualReviewSuspicious:
      data.requireManualReviewSuspicious ?? current.requireManualReviewSuspicious,
    enabled: data.enabled ?? current.enabled,
    virusTotalApiKey:
      data.virusTotalApiKey && !data.virusTotalApiKey.startsWith("••")
        ? data.virusTotalApiKey
        : current.virusTotalApiKey,
  };

  await saveMalwareScannerSettings(next);
  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function getSecurityDashboardStats() {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    total,
    clean,
    suspicious,
    malware,
    blocked,
    pendingReviews,
    approved,
    rejected,
    failedScans,
    recent,
    pendingApprovals,
    pendingSounds,
    quota,
    auditRecent,
  ] = await Promise.all([
    (await getDb()).fileScanLog.count(),
    (await getDb()).fileScanLog.count({ where: { status: { in: ["CLEAN", "APPROVED"] } } }),
    (await getDb()).fileScanLog.count({
      where: { status: { in: ["SUSPICIOUS", "MANUAL_REVIEW"] } },
    }),
    (await getDb()).fileScanLog.count({ where: { status: "MALWARE" } }),
    (await getDb()).fileScanLog.count({ where: { blocked: true } }),
    (await getDb()).modVersion.count({
      where: { scanStatus: { in: ["MANUAL_REVIEW", "SUSPICIOUS", "PENDING", "SCANNING"] } },
    }),
    (await getDb()).modVersion.count({ where: { scanStatus: "APPROVED" } }),
    (await getDb()).modVersion.count({ where: { scanStatus: { in: ["REJECTED", "MALWARE"] } } }),
    (await getDb()).scanQueue.count({ where: { status: "FAILED" } }),
    (await getDb()).fileScanLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        modVersion: {
          select: {
            id: true,
            version: true,
            mod: { select: { slug: true, title: true } },
          },
        },
      },
    }),
    (await getDb()).modVersion.findMany({
      where: { scanStatus: { in: ["MANUAL_REVIEW", "SUSPICIOUS", "FAILED", "PENDING"] } },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        mod: { select: { id: true, slug: true, title: true } },
        trustedFile: true,
        fileScans: { orderBy: { scannedAt: "desc" }, take: 1 },
      },
    }),
    (await getDb()).mod.findMany({
      where: {
        productType: "SOUND",
        status: { in: ["PENDING", "DRAFT"] },
        soundProfile: {
          approvalStatus: {
            in: ["PENDING_REVIEW", "REVIEW_REQUIRED", "CHANGES_REQUESTED"],
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        author: { select: { id: true, username: true, displayName: true } },
        soundProfile: true,
      },
    }),
    getVirusTotalQuota(),
    (await getDb()).securityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { user: { select: { username: true, displayName: true } } },
    }),
  ]);

  const scannedToday = await (await getDb()).fileScanLog.count({
    where: { createdAt: { gte: todayStart } },
  });

  return ok({
    total,
    clean,
    suspicious,
    malware,
    blocked,
    pendingReviews,
    approved,
    rejected,
    failedScans,
    scannedToday,
    quota,
    recent,
    pendingApprovals,
    pendingSounds,
    auditRecent,
  });
}

async function approveVersionInternal(
  versionId: string,
  adminId: string,
  options?: { reason?: string; notes?: string; markTrusted?: boolean }
) {
  const version = await (await getDb()).modVersion.findUnique({
    where: { id: versionId },
    include: { mod: true, trustedFile: true },
  });
  if (!version) return fail("Version not found");
  if (version.scanStatus === "MALWARE") return fail("Cannot approve malware");

  await (await getDb()).$transaction(async (tx) => {
    await tx.modVersion.updateMany({
      where: { modId: version.modId, isPrimary: true },
      data: { isPrimary: false },
    });
    await tx.modVersion.update({
      where: { id: versionId },
      data: { isPrimary: true, scanStatus: "APPROVED", scannedAt: new Date() },
    });
    await tx.mod.update({
      where: { id: version.modId },
      data: { status: "PUBLISHED" },
    });
    await tx.securityReview.create({
      data: {
        modVersionId: versionId,
        status: "approved",
        approvedById: adminId,
        approvedAt: new Date(),
        reason: options?.reason ?? "Manual admin approval",
        notes: options?.notes,
        isTrusted: options?.markTrusted ?? false,
      },
    });
    if (options?.markTrusted && !version.trustedFile) {
      await tx.trustedFile.create({
        data: {
          modVersionId: versionId,
          approvedById: adminId,
          reason: options?.reason ?? "Marked trusted by security team",
          notes: options?.notes,
        },
      });
    }
  });

  await logSecurityEvent({
    action: "APPROVAL",
    modVersionId: versionId,
    modId: version.modId,
    userId: adminId,
    metadata: { reason: options?.reason, trusted: options?.markTrusted },
  });

  revalidatePath(`/mods/${version.mod.slug}`);
  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function approveScannedVersion(
  versionId: string,
  reason?: string,
  notes?: string
) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;
  return approveVersionInternal(versionId, user!.id, { reason, notes });
}

export async function markVersionTrusted(versionId: string, reason?: string, notes?: string) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;
  return approveVersionInternal(versionId, user!.id, {
    reason: reason ?? "Trusted by XUMARI MODZ Security Team",
    notes,
    markTrusted: true,
  });
}

export async function rejectScannedVersion(versionId: string, reason?: string) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;

  const version = await (await getDb()).modVersion.findUnique({
    where: { id: versionId },
    include: { mod: true },
  });
  if (!version) return fail("Version not found");

  await (await getDb()).$transaction([
    (await getDb()).modVersion.update({
      where: { id: versionId },
      data: { scanStatus: "REJECTED", isPrimary: false, isArchived: true },
    }),
    (await getDb()).mod.update({
      where: { id: version.modId },
      data: { status: "REJECTED" },
    }),
    (await getDb()).securityReview.create({
      data: {
        modVersionId: versionId,
        status: "rejected",
        approvedById: user!.id,
        approvedAt: new Date(),
        reason: reason ?? "Rejected by admin",
      },
    }),
  ]);

  await logSecurityEvent({
    action: "REJECTION",
    modVersionId: versionId,
    modId: version.modId,
    userId: user!.id,
    metadata: { reason },
  });

  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function requestVersionReview(versionId: string, notes?: string) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;

  const version = await (await getDb()).modVersion.findUnique({ where: { id: versionId } });
  if (!version) return fail("Version not found");

  await (await getDb()).$transaction([
    (await getDb()).modVersion.update({
      where: { id: versionId },
      data: { scanStatus: "MANUAL_REVIEW" },
    }),
    (await getDb()).securityReview.create({
      data: {
        modVersionId: versionId,
        status: "review_requested",
        approvedById: user!.id,
        notes,
      },
    }),
  ]);

  await logSecurityEvent({
    action: "REVIEW_REQUESTED",
    modVersionId: versionId,
    modId: version.modId,
    userId: user!.id,
    metadata: { notes },
  });

  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function reprocessVersionScan(versionId: string) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;

  const version = await (await getDb()).modVersion.findUnique({
    where: { id: versionId },
    include: { mod: true },
  });
  if (!version) return fail("Version not found");

  await (await getDb()).modVersion.update({
    where: { id: versionId },
    data: { scanStatus: "PENDING" },
  });

  await enqueueScan({
    modVersionId: versionId,
    modId: version.modId,
    fileKey: version.fileKey,
    fileName: version.fileName,
    fileSize: version.fileSize,
    sha256: version.sha256 ?? undefined,
    priority: 75,
  });

  await logSecurityEvent({
    action: "RE_SCAN",
    modVersionId: versionId,
    modId: version.modId,
    userId: user!.id,
  });

  void import("@/lib/security/scan-worker").then(({ processScanQueue }) =>
    processScanQueue(1).catch(console.error)
  );

  revalidatePath("/admin/security");
  return ok({ scanStatus: "PENDING" as FileScanStatus });
}

export async function removeVersionScan(versionId: string) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;

  await (await getDb()).$transaction([
    (await getDb()).scanQueue.deleteMany({ where: { modVersionId: versionId } }),
    (await getDb()).modVersion.update({
      where: { id: versionId },
      data: {
        scanStatus: "MANUAL_REVIEW",
        scanReport: { scanRemoved: true } as Prisma.InputJsonValue,
      },
    }),
  ]);

  await logSecurityEvent({
    action: "SCAN_REMOVED",
    modVersionId: versionId,
    userId: user!.id,
  });

  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function bulkApproveVersions(versionIds: string[]) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;

  for (const id of versionIds) {
    await approveVersionInternal(id, user!.id, { reason: "Bulk approval" });
  }

  await logSecurityEvent({
    action: "BULK_APPROVE",
    userId: user!.id,
    metadata: { count: versionIds.length, versionIds },
  });

  return ok({ count: versionIds.length });
}

export async function bulkRejectVersions(versionIds: string[]) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;

  for (const id of versionIds) {
    await rejectScannedVersion(id, "Bulk rejection");
  }

  await logSecurityEvent({
    action: "BULK_REJECT",
    userId: user!.id,
    metadata: { count: versionIds.length, versionIds },
  });

  return ok({ count: versionIds.length });
}

export async function exportSecurityReport() {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;

  const [logs, scans, reviews] = await Promise.all([
    (await getDb()).securityLog.findMany({ orderBy: { createdAt: "desc" }, take: 500 }),
    (await getDb()).fileScan.findMany({ orderBy: { scannedAt: "desc" }, take: 500 }),
    (await getDb()).securityReview.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
  ]);

  return ok({
    exportedAt: new Date().toISOString(),
    logs,
    scans,
    reviews,
  });
}

export async function getModSecurityInfo(modId: string) {
  const version = await (await getDb()).modVersion.findFirst({
    where: { modId, isPrimary: true, isArchived: false },
    include: {
      trustedFile: { include: { approvedBy: { select: { displayName: true, username: true } } } },
      fileScans: { orderBy: { scannedAt: "desc" }, take: 1 },
    },
  });
  if (!version) return null;

  return {
    scanStatus: version.scanStatus,
    scannedAt: version.scannedAt,
    sha256: version.sha256,
    isTrusted: !!version.trustedFile,
    isDownloadable: isDownloadAllowed(version.scanStatus),
    trustedFile: version.trustedFile,
    lastScan: version.fileScans[0] ?? null,
  };
}

export async function updateCreatorTrustLevel(
  creatorProfileId: string,
  trustLevel: "NEW" | "VERIFIED" | "TRUSTED" | "ELITE",
  notes?: string
) {
  const { user, error } = await requireActionPermission("mods.write");
  if (error) return error;

  await (await getDb()).trustedCreator.upsert({
    where: { creatorProfileId },
    create: {
      creatorProfileId,
      trustLevel,
      approvedById: user!.id,
      approvedAt: new Date(),
      notes,
      priorityScan: trustLevel === "TRUSTED" || trustLevel === "ELITE",
      fastTrack: trustLevel === "ELITE",
    },
    update: {
      trustLevel,
      approvedById: user!.id,
      approvedAt: new Date(),
      notes,
      priorityScan: trustLevel === "TRUSTED" || trustLevel === "ELITE",
      fastTrack: trustLevel === "ELITE",
    },
  });

  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function triggerScanWorker() {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;

  const { processScanQueue } = await import("@/lib/security/scan-worker");
  const result = await processScanQueue(5);
  return ok(result);
}

export async function approveSound(modId: string, notes?: string) {
  const { user, error } = await requireActionPermission("settings.write");
  if (error) return error;

  const mod = await (await getDb()).mod.findUnique({
    where: { id: modId },
    include: { soundProfile: true },
  });
  if (!mod || mod.productType !== "SOUND" || !mod.soundProfile) return fail("Sound not found");

  await (await getDb()).$transaction([
    (await getDb()).mod.update({
      where: { id: modId },
      data: { status: "PUBLISHED", publishedAt: mod.publishedAt ?? new Date() },
    }),
    (await getDb()).soundProfile.update({
      where: { modId },
      data: {
        approvalStatus: "MANUALLY_APPROVED",
        previewScanStatus: "APPROVED",
        approvedAt: new Date(),
        approvedById: user!.id,
        reviewNotes: notes ?? null,
      },
    }),
  ]);

  await logSecurityEvent({
    action: "APPROVAL",
    modId,
    userId: user!.id,
    metadata: { type: "sound", notes },
  });

  revalidatePath("/admin/security");
  revalidateLocalizedPaths("/mods");
  revalidateLocalizedPaths(`/mods/${mod.slug}`);
  revalidateTag(CACHE_TAGS.mods);
  return ok(undefined);
}

export async function rejectSound(modId: string, reason?: string) {
  const { user, error } = await requireActionPermission("settings.write");
  if (error) return error;

  const mod = await (await getDb()).mod.findUnique({ where: { id: modId }, include: { soundProfile: true } });
  if (!mod || mod.productType !== "SOUND") return fail("Sound not found");

  await (await getDb()).$transaction([
    (await getDb()).mod.update({ where: { id: modId }, data: { status: "REJECTED" } }),
    (await getDb()).soundProfile.update({
      where: { modId },
      data: {
        approvalStatus: "REJECTED",
        previewScanStatus: "REJECTED",
        rejectionReason: reason ?? "Rejected by security review",
        approvedById: user!.id,
      },
    }),
  ]);

  await logSecurityEvent({
    action: "REJECTION",
    modId,
    userId: user!.id,
    metadata: { type: "sound", reason },
  });

  revalidatePath("/admin/security");
  revalidateLocalizedPaths("/mods");
  revalidateLocalizedPaths(`/mods/${mod.slug}`);
  revalidateTag(CACHE_TAGS.mods);
  return ok(undefined);
}

export async function requestSoundChanges(modId: string, notes: string) {
  const { user, error } = await requireActionPermission("settings.write");
  if (error) return error;

  await (await getDb()).soundProfile.update({
    where: { modId },
    data: {
      approvalStatus: "CHANGES_REQUESTED",
      reviewNotes: notes,
      approvedById: user!.id,
    },
  });

  await (await getDb()).mod.update({ where: { id: modId }, data: { status: "PENDING" } });

  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function requestSoundReview(modId: string) {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;

  await (await getDb()).soundProfile.update({
    where: { modId },
    data: { approvalStatus: "REVIEW_REQUIRED", previewScanStatus: "MANUAL_REVIEW" },
  });

  revalidatePath("/admin/security");
  return ok(undefined);
}

export async function rescanSoundPreview(modId: string) {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;

  const profile = await (await getDb()).soundProfile.findUnique({ where: { modId } });
  if (!profile?.previewFileKey) return fail("No preview file");

  await (await getDb()).soundProfile.update({
    where: { modId },
    data: { previewScanStatus: "PENDING", approvalStatus: "REVIEW_REQUIRED" },
  });

  revalidatePath("/admin/security");
  return ok(undefined);
}
