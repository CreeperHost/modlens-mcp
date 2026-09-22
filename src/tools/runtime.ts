import { join } from "node:path";
import { CACHE_ROOT } from "../cache.js";
import { RuntimeHub, RUNTIME_HELP } from "../runtime/hub.js";
import { executeRuntime, runtimeRequest, type RuntimeRequest } from "../runtime/requests.js";
import { localExecutionPlan } from "../runtime/guidance.js";

export { runtimeToolSchema } from "../runtime/requests.js";
export const runtimeHub = new RuntimeHub(join(CACHE_ROOT, "runtime"));

export async function runtimeAction(raw: RuntimeRequest) {
    const request = runtimeRequest.parse(raw);
    if (process.env.MCP_PORT) {
        if (request.action === "help")
            return { ...RUNTIME_HELP, localExecution: localExecutionPlan(request) };
        // A remote tool supplies instructions, never executes paths on the user's PC.
        return localExecutionPlan(request);
    }
    return executeRuntime(runtimeHub, request);
}
