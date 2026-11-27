import { route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { previewWorkingDays } from "@/server/leave-service";

export const dynamic = "force-dynamic";

export const GET = route(async ({ request }) => {
  const caller = await requireUser(request);
  return previewWorkingDays(caller, request.nextUrl.searchParams);
});
