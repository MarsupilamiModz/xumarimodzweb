import { unstable_cache, revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";

export function getDashboardStats(userId: string) {
  return unstable_cache(
    async () => {
      const [downloads, favorites, unreadNotifications, progress] = await Promise.all([
        (await getDb()).download.count({ where: { userId } }),
        (await getDb()).modFavorite.count({ where: { userId } }),
        (await getDb()).notification.count({ where: { userId, read: false } }),
        (await getDb()).userProgress.findUnique({ where: { userId } }),
      ]);
      return { downloads, favorites, unreadNotifications, progress };
    },
    ["dashboard-stats", userId],
    { revalidate: 30, tags: ["dashboard-stats", `dashboard-stats-${userId}`] }
  )();
}

export function revalidateDashboardStats() {
  revalidateTag("dashboard-stats");
}
