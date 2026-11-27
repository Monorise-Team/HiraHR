import { paginated, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { createLeaveRequest, listLeaveRequests } from "@/server/leave-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  const page = await listLeaveRequests(caller, request.nextUrl.searchParams);
  return paginated(page.items, page.nextCursor);
});

export const POST = route(
  async ({ request }) => {
    const caller = await requireUser(request);
    return createLeaveRequest(caller, await readJson(request));
  },
  { status: 201 },
);
