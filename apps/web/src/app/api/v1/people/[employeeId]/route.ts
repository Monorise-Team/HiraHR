import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { getPersonCard, updatePersonProfile } from "@/server/people-service";

export const dynamic = "force-dynamic";

const INVALID_ID = "Niepoprawny identyfikator osoby";

export const GET = route<{ employeeId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  return getPersonCard(caller, parseUuidParam(params.employeeId, "employeeId", INVALID_ID));
});

export const PATCH = route<{ employeeId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const employeeId = parseUuidParam(params.employeeId, "employeeId", INVALID_ID);
  return updatePersonProfile(caller, employeeId, await readJson(request));
});
