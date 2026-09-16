"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { ok, requireActionUser } from "@/lib/action-utils";

export async function toggleFavorite(modId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const existing = await (await getDb()).modFavorite.findUnique({
    where: { modId_userId: { modId, userId: user.id } },
  });

  if (existing) {
    await (await getDb()).$transaction([
      (await getDb()).modFavorite.delete({ where: { id: existing.id } }),
      (await getDb()).mod.update({
        where: { id: modId },
        data: { favoriteCount: { decrement: 1 } },
      }),
    ]);
    revalidatePath("/dashboard/favorites");
    return ok({ favorited: false });
  }

  await (await getDb()).$transaction([
    (await getDb()).modFavorite.create({ data: { modId, userId: user.id } }),
    (await getDb()).mod.update({
      where: { id: modId },
      data: { favoriteCount: { increment: 1 } },
    }),
  ]);

  revalidatePath("/dashboard/favorites");
  return ok({ favorited: true });
}

export async function getUserFavorites() {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const favorites = await (await getDb()).modFavorite.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: {
      mod: {
        include: {
          game: true,
          media: { orderBy: [{ isFeatured: "desc" }, { orderIndex: "asc" }] },
          screenshots: { take: 1, orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });

  return ok(favorites);
}
