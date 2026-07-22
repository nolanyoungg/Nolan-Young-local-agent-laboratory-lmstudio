import { resolve } from "node:path";
import { listAgents } from "./agent-library.js";

for (const agent of await listAgents(resolve(import.meta.dirname, "..", ".."))) console.log(agent);
