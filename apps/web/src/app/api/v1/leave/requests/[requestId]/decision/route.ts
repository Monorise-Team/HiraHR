import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { decideLeaveRequest } from "@/server/leave-service";

export const dynamic = "force-dynamic";

export const POST = route<{ requestId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const requestId = parseUuidParam(params.requestId, "requestId", "Niepoprawny identyfikator wniosku");
  return decideLeaveRequest(caller, requestId, await readJson(request));
});
