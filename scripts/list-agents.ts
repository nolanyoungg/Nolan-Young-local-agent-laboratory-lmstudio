import { resolve } from "node:path";
import { listAgents } from "@local-agent-lab/agent-runtime";

for (const agent of await listAgents(resolve(import.meta.dirname, ".."))) console.log(agent);
