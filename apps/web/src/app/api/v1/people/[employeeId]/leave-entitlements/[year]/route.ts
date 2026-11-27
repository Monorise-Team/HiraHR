import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { updateLeaveEntitlement } from "@/server/leave-service";

export const dynamic = "force-dynamic";

export const PUT = route<{ employeeId: string; year: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const employeeId = parseUuidParam(params.employeeId, "employeeId", "Niepoprawny identyfikator osoby");
  return updateLeaveEntitlement(caller, employeeId, params.year, await readJson(request));
});
