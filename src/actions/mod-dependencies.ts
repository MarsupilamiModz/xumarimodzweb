"use server";

import { revalidatePath } from "next/cache";
import { ModDependencyRelation } from "@prisma/client";
import { getDb } from "@/lib/db";
import { UserRole } from "@prisma/client";
import { fail, ok, requireActionUser } from "@/lib/action-utils";
import { hasPermission } from "@/lib/permissions";

async function canEditMod(userId: string, role: UserRole, modAuthorId: string) {
  if (modAuthorId === userId) return true;
  return hasPermission(role, "mods.write") || hasPermission(role, "mods.moderate");
}

export async function addModDependency(
  modId: string,
  dependencyId: string,
  isRequired = true,
  minVersion?: string,
  notes?: string,
  relation?: ModDependencyRelation
) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const mod = await (await getDb()).mod.findUnique({ where: { id: modId } });
  if (!mod) return fail("Mod not found");
  if (!(await canEditMod(user.id, user.role, mod.authorId))) return fail("Forbidden");
  if (modId === dependencyId) return fail("Mod cannot depend on itself");

  const dep = await (await getDb()).mod.findUnique({ where: { id: dependencyId } });
  if (!dep) return fail("Dependency mod not found");

  const rel = relation ?? (isRequired ? "REQUIRED" : "OPTIONAL");

  await (await getDb()).modDependency.upsert({
    where: { modId_dependencyId: { modId, dependencyId } },
    create: {
      modId,
      dependencyId,
      isRequired: rel === "REQUIRED",
      relation: rel,
      minVersion,
      notes,
    },
    update: {
      isRequired: rel === "REQUIRED",
      relation: rel,
      minVersion,
      notes,
    },
  });

  revalidatePath(`/mods/${mod.slug}`);
  return ok(undefined);
}

export async function removeModDependency(modId: string, dependencyId: string) {
  const { user, error } = await requireActionUser();
  if (error) return error;

  const mod = await (await getDb()).mod.findUnique({ where: { id: modId } });
  if (!mod) return fail("Mod not found");
  if (!(await canEditMod(user.id, user.role, mod.authorId))) return fail("Forbidden");

  await (await getDb()).modDependency.deleteMany({ where: { modId, dependencyId } });
  revalidatePath(`/mods/${mod.slug}`);
  return ok(undefined);
}

export async function searchModsForDependency(query: string, gameId?: string) {
  const { error } = await requireActionUser();
  if (error) return error;

  const mods = await (await getDb()).mod.findMany({
    where: {
      status: "PUBLISHED",
      ...(gameId && { gameId }),
      ...(query && {
        OR: [
          { title: { contains: query, mode: "insensitive" } },
          { slug: { contains: query, mode: "insensitive" } },
        ],
      }),
    },
    select: { id: true, title: true, slug: true },
    take: 20,
    orderBy: { downloadCount: "desc" },
  });

  return ok(mods);
}
