import { parseUuidParam, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { cancelLeaveRequest } from "@/server/leave-service";

export const dynamic = "force-dynamic";

export const POST = route<{ requestId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  return cancelLeaveRequest(caller, parseUuidParam(params.requestId, "requestId", "Niepoprawny identyfikator wniosku"));
});
