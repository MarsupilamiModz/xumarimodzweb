import { getDb } from "@/lib/db";

export type ProfileType = "creator" | "partner";

export async function isFollowing(
  followerId: string,
  followingUserId: string,
  profileType: ProfileType
) {
  const row = await (await getDb()).profileFollow.findUnique({
    where: {
      followerId_followingId_profileType: {
        followerId,
        followingId: followingUserId,
        profileType,
      },
    },
  });
  return !!row;
}

export async function getFollowerCount(userId: string, profileType: ProfileType) {
  if (profileType === "creator") {
    const profile = await (await getDb()).creatorProfile.findUnique({
      where: { userId },
      select: { followerCount: true },
    });
    return profile?.followerCount ?? 0;
  }
  const profile = await (await getDb()).partnerProfile.findUnique({
    where: { userId },
    select: { followerCount: true },
  });
  return profile?.followerCount ?? 0;
}

export async function notifyCreatorFollowers(
  creatorUserId: string,
  payload: { title: string; body: string; link?: string }
) {
  const followers = await (await getDb()).profileFollow.findMany({
    where: { followingId: creatorUserId, profileType: "creator" },
    select: { followerId: true },
    take: 5000,
  });
  if (!followers.length) return;

  await (await getDb()).notification.createMany({
    data: followers.map((f) => ({
      userId: f.followerId,
      title: payload.title,
      body: payload.body,
      link: payload.link,
    })),
  });
}

export async function getFollowedCreators(userId: string, limit = 24) {
  const follows = await (await getDb()).profileFollow.findMany({
    where: { followerId: userId, profileType: "creator" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      following: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          creatorProfile: {
            select: { slug: true, tagline: true, followerCount: true, level: true },
          },
        },
      },
    },
  });
  return follows.map((f) => f.following).filter((u) => u.creatorProfile);
}

export async function getCreatorFollowAnalytics(creatorUserId: string) {
  const [profile, totalFollowers, recentFollows, modCount] = await Promise.all([
    (await getDb()).creatorProfile.findUnique({ where: { userId: creatorUserId } }),
    (await getDb()).profileFollow.count({
      where: { followingId: creatorUserId, profileType: "creator" },
    }),
    (await getDb()).profileFollow.count({
      where: {
        followingId: creatorUserId,
        profileType: "creator",
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    }),
    (await getDb()).mod.count({ where: { authorId: creatorUserId, status: "PUBLISHED" } }),
  ]);

  const downloads = profile?.totalDownloads ?? 0;
  const engagementRate =
    totalFollowers > 0 ? Math.round((downloads / totalFollowers) * 100) / 100 : 0;

  return {
    totalFollowers,
    followerGrowth30d: recentFollows,
    engagementRate,
    modCount,
    totalDownloads: downloads,
  };
}
