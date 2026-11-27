import { paginated, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { createPosition, listPositions } from "@/server/positions-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  const page = await listPositions(caller, request.nextUrl.searchParams);
  return paginated(page.items, page.nextCursor);
});

export const POST = route(
  async ({ request }) => {
    const caller = await requireUser(request);
    return createPosition(caller, await readJson(request));
  },
  { status: 201 },
);
