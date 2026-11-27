import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { createContract } from "@/server/people-service";

export const dynamic = "force-dynamic";

export const POST = route<{ employeeId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    const employeeId = parseUuidParam(params.employeeId, "employeeId", "Niepoprawny identyfikator osoby");
    return createContract(caller, employeeId, await readJson(request));
  },
  { status: 201 },
);
