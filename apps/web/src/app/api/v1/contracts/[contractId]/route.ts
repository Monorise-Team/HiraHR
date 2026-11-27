import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { deleteContract, updateContract } from "@/server/people-service";

export const dynamic = "force-dynamic";

const INVALID_ID = "Niepoprawny identyfikator umowy";

export const PATCH = route<{ contractId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const contractId = parseUuidParam(params.contractId, "contractId", INVALID_ID);
  return updateContract(caller, contractId, await readJson(request));
});

export const DELETE = route<{ contractId: string }>(
  async ({ request, params }) => {
    const caller = await requireUser(request);
    await deleteContract(caller, parseUuidParam(params.contractId, "contractId", INVALID_ID));
  },
  { status: 204 },
);
