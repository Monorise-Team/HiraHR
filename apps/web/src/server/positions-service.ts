import "server-only";
import {
  CreatePositionInput,
  HIRAHR_PERMISSIONS,
  PositionsQuery,
  UpdatePositionInput,
  type PaginatedResult,
  type Position,
} from "@hirahr/contracts";
import { Prisma, uuidv7, withUser } from "@hirahr/db";
import { ApiFailure } from "./api";
import type { Caller } from "./auth";
import { getDb } from "./db";
import { pageByOffset } from "./pagination";
import { assertPermission, assertProductAccess, getPermissionSnapshot } from "./permissions";

const DUPLICATE_NAME_MESSAGE = "Stanowisko o tej nazwie już istnieje";

type PositionRow = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toPosition(row: PositionRow): Position {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Unikalność aktywnej nazwy w firmie pilnuje indeks częściowy `positions_active_name_key`. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Katalog stanowisk firmy (dla formularzy umów); wymaga dostępu do produktu. */
export async function listPositions(caller: Caller, searchParams: URLSearchParams): Promise<PaginatedResult<Position>> {
  const snapshot = await getPermissionSnapshot(caller);
  assertProductAccess(snapshot);
  const { includeArchived, limit, cursor } = PositionsQuery.parse(Object.fromEntries(searchParams.entries()));
  const rows = await withUser(getDb(), caller, (tx) =>
    tx.position.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  );
  return pageByOffset(rows.map(toPosition), cursor, limit);
}

/** Nowe stanowisko (`hirahr.settings.manage`). */
export async function createPosition(caller: Caller, raw: unknown): Promise<Position> {
  await assertPermission(caller, HIRAHR_PERMISSIONS.keys["settings.manage"]);
  const input = CreatePositionInput.parse(raw);
  try {
    const row = await withUser(getDb(), caller, (tx) =>
      tx.position.create({
        data: {
          id: uuidv7(),
          organizationId: caller.organizationId,
          name: input.name,
          description: input.description || null,
        },
      }),
    );
    return toPosition(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiFailure(409, "CONFLICT", DUPLICATE_NAME_MESSAGE);
    throw error;
  }
}

/** Zmiana nazwy, opisu albo archiwizacja stanowiska (`hirahr.settings.manage`). */
export async function updatePosition(caller: Caller, positionId: string, raw: unknown): Promise<Position> {
  await assertPermission(caller, HIRAHR_PERMISSIONS.keys["settings.manage"]);
  const input = UpdatePositionInput.parse(raw);
  try {
    const row = await withUser(getDb(), caller, async (tx) => {
      const existing = await tx.position.findUnique({ where: { id: positionId } });
      if (!existing) throw new ApiFailure(404, "NOT_FOUND", "Nie znaleziono stanowiska");
      return tx.position.update({
        where: { id: positionId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description || null } : {}),
          ...(input.archived !== undefined
            ? { archivedAt: input.archived ? (existing.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
    });
    return toPosition(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiFailure(409, "CONFLICT", DUPLICATE_NAME_MESSAGE);
    throw error;
  }
}
