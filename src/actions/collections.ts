"use server";

import { revalidatePath } from "next/cache";
import { CollectionVisibility } from "@prisma/client";
import { getDb } from "@/lib/db";
import { fail, ok, requireActionUser, requireActionPermission } from "@/lib/action-utils";
import { isAdmin } from "@/lib/permissions";
import { slugify } from "@/lib/utils";

async function uniqueCollectionSlug(base: string) {
  let slug = slugify(base);
  let i = 0;
  while (await (await getDb()).modCollection.findUnique({ where: { slug } })) {
    slug = `${slugify(base)}-${++i}`;
  }
  return slug;
}

export async function createCollection(input: {
  title: string;
  description?: string;
  visibility?: CollectionVisibility;
  coverUrl?: string;
}) {
  const { user, error } = await requireActionUser();
  if (error) return error;
  if (!input.title.trim()) return fail("Title required");

  const creator = await (await getDb()).creatorProfile.findUnique({ where: { userId: user.id } });
  const slug = await uniqueCollectionSlug(input.title);

  const collection = await (await getDb()).modCollection.create({
    data: {
      slug,
      title: input.title.trim(),
      description: input.description,
      visibility: input.visibility ?? "PUBLIC",
      coverUrl: input.coverUrl,
      ownerId: user.id,
      creatorId: creator?.id,
    },
  });

  revalidatePath("/collections");
  return ok(collection);
}

export async function updateCollection(
  collectionId: string,
  input: Partial<{
    title: string;
    description: string;
    visibility: CollectionVisibility;
    coverUrl: string;
    isFeatured: boolean;
  }>
) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const collection = await (await getDb()).modCollection.findUnique({ where: { id: collectionId } });
  if (!collection) return fail("Not found");
  if (collection.ownerId !== user.id && !isAdmin(user.role)) return fail("Forbidden");

  const updated = await (await getDb()).modCollection.update({
    where: { id: collectionId },
    data: input,
  });

  revalidatePath(`/collections/${updated.slug}`);
  return ok(updated);
}

export async function deleteCollection(collectionId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const collection = await (await getDb()).modCollection.findUnique({ where: { id: collectionId } });
  if (!collection) return fail("Not found");
  if (collection.ownerId !== user.id && !isAdmin(user.role)) return fail("Forbidden");

  await (await getDb()).modCollection.delete({ where: { id: collectionId } });
  revalidatePath("/collections");
  return ok(undefined);
}

export async function addModToCollection(collectionId: string, modId: string, note?: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const collection = await (await getDb()).modCollection.findUnique({ where: { id: collectionId } });
  if (!collection) return fail("Not found");
  if (collection.ownerId !== user.id && !isAdmin(user.role)) return fail("Forbidden");

  const maxOrder = await (await getDb()).modCollectionItem.aggregate({
    where: { collectionId },
    _max: { sortOrder: true },
  });

  await (await getDb()).modCollectionItem.upsert({
    where: { collectionId_modId: { collectionId, modId } },
    create: { collectionId, modId, sortOrder: (maxOrder._max.sortOrder ?? -1) + 1, note },
    update: { note },
  });

  revalidatePath(`/collections/${collection.slug}`);
  return ok(undefined);
}

export async function removeModFromCollection(collectionId: string, modId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const collection = await (await getDb()).modCollection.findUnique({ where: { id: collectionId } });
  if (!collection) return fail("Not found");
  if (collection.ownerId !== user.id && !isAdmin(user.role)) return fail("Forbidden");

  await (await getDb()).modCollectionItem.deleteMany({ where: { collectionId, modId } });
  revalidatePath(`/collections/${collection.slug}`);
  return ok(undefined);
}

export async function reorderCollectionMods(collectionId: string, modIds: string[]) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const db = await getDb();
  const collection = await db.modCollection.findUnique({ where: { id: collectionId } });
  if (!collection) return fail("Not found");
  if (collection.ownerId !== user.id && !isAdmin(user.role)) return fail("Forbidden");

  await db.$transaction(
    modIds.map((modId, index) =>
      db.modCollectionItem.updateMany({
        where: { collectionId, modId },
        data: { sortOrder: index },
      })
    )
  );

  revalidatePath(`/collections/${collection.slug}`);
  return ok(undefined);
}

export async function followCollection(collectionId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const existing = await (await getDb()).modCollectionFollow.findUnique({
    where: { collectionId_userId: { collectionId, userId: user.id } },
  });
  if (existing) return ok(undefined);

  await (await getDb()).$transaction([
    (await getDb()).modCollectionFollow.create({
      data: { collectionId, userId: user.id },
    }),
    (await getDb()).modCollection.update({
      where: { id: collectionId },
      data: { followerCount: { increment: 1 } },
    }),
  ]);

  return ok(undefined);
}

export async function unfollowCollection(collectionId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const deleted = await (await getDb()).modCollectionFollow.deleteMany({
    where: { collectionId, userId: user.id },
  });

  if (deleted.count > 0) {
    await (await getDb()).modCollection.update({
      where: { id: collectionId },
      data: { followerCount: { decrement: 1 } },
    });
  }

  return ok(undefined);
}

export async function bulkDownloadCollection(collectionId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const collection = await (await getDb()).modCollection.findUnique({
    where: { id: collectionId },
    include: {
      items: {
        include: {
          mod: {
            include: { versions: { where: { isPrimary: true, isArchived: false }, take: 1 } },
          },
        },
      },
    },
  });
  if (!collection) return fail("Not found");

  const modIds = collection.items.map((i) => i.modId);
  await (await getDb()).modFavorite.createMany({
    data: modIds.map((modId) => ({ modId, userId: user.id })),
    skipDuplicates: true,
  });

  await (await getDb()).modCollection.update({
    where: { id: collectionId },
    data: { downloadCount: { increment: 1 } },
  });

  return ok({ modIds, count: modIds.length });
}

export async function featureCollectionAdmin(collectionId: string, featured: boolean) {
  const { error } = await requireActionPermission("settings.write");
  if (error) return error;

  const collection = await (await getDb()).modCollection.findUnique({ where: { id: collectionId } });
  if (!collection) return fail("Not found");

  await (await getDb()).modCollection.update({
    where: { id: collectionId },
    data: {
      isFeatured: featured,
      visibility: featured
        ? "FEATURED"
        : collection.visibility === "FEATURED"
          ? "PUBLIC"
          : collection.visibility,
    },
  });

  revalidatePath("/collections");
  return ok(undefined);
}
