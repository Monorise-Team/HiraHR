import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getSensitiveData, updateSensitiveData } from "@/server/people-service";

export const dynamic = "force-dynamic";

const INVALID_ID = "Niepoprawny identyfikator osoby";

export const GET = route<{ employeeId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  return getSensitiveData(caller, parseUuidParam(params.employeeId, "employeeId", INVALID_ID));
});

export const PUT = route<{ employeeId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const employeeId = parseUuidParam(params.employeeId, "employeeId", INVALID_ID);
  return updateSensitiveData(caller, employeeId, await readJson(request));
});
