import { paginated, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getLeaveCalendar } from "@/server/leave-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  const page = await getLeaveCalendar(caller, request.nextUrl.searchParams);
  return paginated(page.items, page.nextCursor);
});
