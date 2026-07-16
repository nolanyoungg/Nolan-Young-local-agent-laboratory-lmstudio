import { createLMStudioModelClient } from "@local-agent-lab/local-model-client";
import { z } from "zod";

const client = createLMStudioModelClient();
const health = await client.healthCheck();
if (!health.ok) {
  console.error(JSON.stringify(health));
  process.exitCode = 2;
} else {
  const models = await client.listModels();
  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : models[0]?.logicalKey;
  if (process.argv.includes("--inference")) {
    if (!model) throw new Error("No LM Studio model is available for the structured-output check.");
    const response = await client.complete(
      {
        model,
        messages: [
          {
            role: "user",
            content: "Return only the required JSON object with ready set to true.",
          },
        ],
        temperature: 0,
        maxTokens: 32,
        structuredOutput: true,
      },
      z.object({ ready: z.literal(true) }).strict(),
    );
    console.log(
      JSON.stringify(
        { ...health, models, inference: { model: response.model, value: response.value } },
        null,
        2,
      ),
    );
  } else console.log(JSON.stringify({ ...health, models }, null, 2));
}
