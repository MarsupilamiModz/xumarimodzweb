"use server";

import { getDb } from "@/lib/db";
import { ok, fail, requireActionUser } from "@/lib/action-utils";
import { revalidatePath } from "next/cache";

export async function toggleTutorialLike(tutorialId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const existing = await (await getDb()).tutorialLike.findUnique({
    where: { tutorialId_userId: { tutorialId, userId: user.id } },
  });

  if (existing) {
    await (await getDb()).$transaction([
      (await getDb()).tutorialLike.delete({ where: { id: existing.id } }),
      (await getDb()).tutorial.update({
        where: { id: tutorialId },
        data: { likeCount: { decrement: 1 } },
      }),
    ]);
    revalidatePath("/tutorials");
    return ok({ liked: false });
  }

  await (await getDb()).$transaction([
    (await getDb()).tutorialLike.create({ data: { tutorialId, userId: user.id } }),
    (await getDb()).tutorial.update({
      where: { id: tutorialId },
      data: { likeCount: { increment: 1 } },
    }),
  ]);
  revalidatePath("/tutorials");
  return ok({ liked: true });
}

export async function postTutorialComment(tutorialId: string, content: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;
  const text = content.trim();
  if (text.length < 2) return fail("Comment too short");

  await (await getDb()).$transaction([
    (await getDb()).tutorialComment.create({
      data: { tutorialId, userId: user.id, content: text },
    }),
    (await getDb()).tutorial.update({
      where: { id: tutorialId },
      data: { commentCount: { increment: 1 } },
    }),
  ]);

  revalidatePath("/tutorials");
  return ok(true);
}

export async function recordTutorialWatch(tutorialId: string, watchSec: number) {
  const auth = await requireActionUser();
  const tutorial = await (await getDb()).tutorial.findUnique({ where: { id: tutorialId } });
  if (!tutorial) return fail("Not found");

  const nextAvg =
    tutorial.viewCount > 0
      ? (tutorial.avgWatchSec * tutorial.viewCount + watchSec) / (tutorial.viewCount + 1)
      : watchSec;

  await (await getDb()).tutorialView.create({
    data: { tutorialId, userId: auth.user?.id, watchSec },
  });
  await (await getDb()).tutorial.update({
    where: { id: tutorialId },
    data: { avgWatchSec: nextAvg },
  });

  return ok(true);
}
