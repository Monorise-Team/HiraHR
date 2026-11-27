import { parseUuidParam, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getLeaveBalance } from "@/server/leave-service";

export const dynamic = "force-dynamic";

export const GET = route<{ employeeId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const employeeId = parseUuidParam(params.employeeId, "employeeId", "Niepoprawny identyfikator osoby");
  return getLeaveBalance(caller, employeeId, request.nextUrl.searchParams);
});
