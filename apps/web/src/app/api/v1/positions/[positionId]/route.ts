import { parseUuidParam, readJson, route } from "@/server/api";
import { requireUser } from "@/server/auth";
import { updatePosition } from "@/server/positions-service";

export const dynamic = "force-dynamic";

export const PATCH = route<{ positionId: string }>(async ({ request, params }) => {
  const caller = await requireUser(request);
  const positionId = parseUuidParam(params.positionId, "positionId", "Niepoprawny identyfikator stanowiska");
  return updatePosition(caller, positionId, await readJson(request));
});
