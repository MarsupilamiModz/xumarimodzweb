"use server";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { requireActionPermission, ok } from "@/lib/action-utils";
import { CACHE_TAGS, REVALIDATE } from "@/lib/cache";

async function fetchAdminAnalytics() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    premiumUsers,
    activeSubscriptions,
    bannedUsers,
    openTickets,
    revenue,
    recentTickets,
    recentMods,
    recentPurchases,
    latestUsers,
  ] = await Promise.all([
    (await getDb()).user.count({ where: { deletedAt: null } }),
    (await getDb()).user.count({
      where: {
        deletedAt: null,
        OR: [
          { role: "PREMIUM" },
          { subscriptions: { some: { status: "ACTIVE" } } },
        ],
      },
    }),
    (await getDb()).subscription.count({ where: { status: "ACTIVE" } }),
    (await getDb()).user.count({ where: { isBanned: true, deletedAt: null } }),
    (await getDb()).supportTicket.count({
      where: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING_FOR_USER"] } },
    }),
    (await getDb()).modPurchase.aggregate({
      _sum: { amountCents: true },
      where: { createdAt: { gte: thirtyDaysAgo } },
    }),
    (await getDb()).supportTicket.findMany({
      take: 5,
      orderBy: { updatedAt: "desc" },
      include: { user: { select: { username: true } } },
    }),
    (await getDb()).mod.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { author: { select: { username: true } }, game: { select: { name: true } } },
    }),
    (await getDb()).modPurchase.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { user: { select: { username: true } }, mod: { select: { title: true } } },
    }),
    (await getDb()).user.findMany({
      take: 5,
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, username: true, email: true, role: true, createdAt: true },
    }),
  ]);

  return {
    totalUsers,
    premiumUsers,
    activeSubscriptions,
    bannedUsers,
    openTickets,
    revenue30d: (revenue._sum.amountCents ?? 0) / 100,
    recentTickets,
    recentMods,
    recentPurchases,
    latestUsers,
  };
}

const getCachedAdminAnalytics = unstable_cache(
  fetchAdminAnalytics,
  ["admin-analytics-overview"],
  { revalidate: REVALIDATE.adminStats, tags: [CACHE_TAGS.adminAnalytics] }
);

export async function getAdminAnalytics() {
  const { error } = await requireActionPermission("analytics.read");
  if (error) return error;

  return ok(await getCachedAdminAnalytics());
}
