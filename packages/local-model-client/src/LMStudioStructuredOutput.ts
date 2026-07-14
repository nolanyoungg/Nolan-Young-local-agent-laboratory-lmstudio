import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodIssue, ZodType } from "zod";

import type { ModelMessage } from "./LocalModelClient.js";
import { ModelClientError, ModelClientErrorCode } from "./errors.js";

export interface RawStructuredCompletion {
  readonly content: string;
  readonly parsed?: unknown;
}

export interface ParsedStructuredCompletion<T> {
  readonly value: T;
  readonly content: string;
}

function safeIssues(issues: readonly ZodIssue[]): string {
  return issues
    .slice(0, 12)
    .map((issue) => {
      const path = issue.path.map(String).join(".") || "root";
      return `${path}: ${issue.code}`;
    })
    .join("; ")
    .slice(0, 1_000);
}

export function parseStructuredCompletion<T>(
  completion: RawStructuredCompletion,
  outputSchema: ZodType<T>,
): ParsedStructuredCompletion<T> {
  const content = completion.content.trim();
  if (content === "" && completion.parsed === undefined) {
    throw new ModelClientError(
      ModelClientErrorCode.emptyResponse,
      "LM Studio returned an empty response.",
      {
        retryable: true,
      },
    );
  }

  let candidate = completion.parsed;
  if (candidate === undefined) {
    try {
      candidate = JSON.parse(content) as unknown;
    } catch (error) {
      throw new ModelClientError(
        ModelClientErrorCode.malformedResponse,
        "LM Studio returned content that is not valid JSON.",
        { cause: error },
      );
    }
  }

  const validation = outputSchema.safeParse(candidate);
  if (!validation.success) {
    throw new ModelClientError(
      ModelClientErrorCode.malformedResponse,
      `LM Studio structured output failed validation (${safeIssues(validation.error.issues)}).`,
    );
  }
  return {
    value: validation.data,
    content: content === "" ? JSON.stringify(validation.data) : content,
  };
}

export function appendStructuredRepairInstruction(
  originalMessages: readonly ModelMessage[],
  error: ModelClientError,
): readonly ModelMessage[] {
  const issueSummary = error.message
    .replace(/^.*?\(/u, "")
    .replace(/\)\.$/u, "")
    .slice(0, 1_000);
  return [
    ...originalMessages,
    {
      role: "user",
      content:
        "Return exactly one complete JSON value matching the required schema. Do not include markdown. " +
        `Validation issues from the prior attempt: ${issueSummary}`,
    },
  ];
}

export function schemaForRest(outputSchema: ZodType<unknown>): Readonly<Record<string, unknown>> {
  const converted = zodToJsonSchema(outputSchema, {
    $refStrategy: "none",
    name: "local_agent_response",
  });
  if (typeof converted !== "object" || converted === null || Array.isArray(converted)) {
    throw new ModelClientError(
      ModelClientErrorCode.configurationInvalid,
      "The requested Zod output schema could not be converted to JSON Schema.",
    );
  }
  const record = converted as Record<string, unknown>;
  const definitions = record["definitions"];
  if (typeof definitions === "object" && definitions !== null && !Array.isArray(definitions)) {
    const named = (definitions as Record<string, unknown>)["local_agent_response"];
    if (typeof named === "object" && named !== null && !Array.isArray(named)) {
      return named as Record<string, unknown>;
    }
  }
  return record;
}
