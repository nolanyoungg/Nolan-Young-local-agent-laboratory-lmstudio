import type { AvailableModel, ResolvedModel } from "./LocalModelClient.js";
import { ModelClientError, ModelClientErrorCode } from "./errors.js";

function normalizedModelName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^a-z0-9]+/gu, "");
}

function uniqueLogicalGroups(models: readonly AvailableModel[]): Map<string, AvailableModel[]> {
  const groups = new Map<string, AvailableModel[]>();
  for (const model of models) {
    const existing = groups.get(model.logicalKey) ?? [];
    existing.push(model);
    groups.set(model.logicalKey, existing);
  }
  return groups;
}

function resolved(
  requested: string,
  variants: readonly AvailableModel[],
  matchType: ResolvedModel["matchType"],
  selectedVariant?: AvailableModel,
): ResolvedModel {
  const first = variants[0];
  if (first === undefined) {
    throw new ModelClientError(
      ModelClientErrorCode.modelMissing,
      "No model variants were available.",
    );
  }
  const selected = selectedVariant ?? variants.find((model) => model.loaded === true) ?? first;
  return {
    requested,
    logicalKey: first.logicalKey,
    selectedVariantId: selected.variantId,
    displayName: first.displayName,
    variants: [...variants],
    matchType,
    routingMetadataAvailable: variants.some(
      (model) => model.device !== undefined || model.source !== undefined,
    ),
  };
}

function ambiguous(requested: string, keys: readonly string[]): never {
  throw new ModelClientError(
    ModelClientErrorCode.modelAmbiguous,
    `Requested model ${JSON.stringify(requested)} matches multiple logical model keys: ${keys.join(", ")}. Use an exact key or selected variant ID.`,
  );
}

export class LMStudioModelResolver {
  public resolve(requestedModel: string, models: readonly AvailableModel[]): ResolvedModel {
    const requested = requestedModel.trim();
    if (requested === "") {
      throw new ModelClientError(
        ModelClientErrorCode.modelMissing,
        "Requested model identifier is empty.",
      );
    }
    const groups = uniqueLogicalGroups(models);
    if (groups.size === 0) {
      throw new ModelClientError(
        ModelClientErrorCode.modelMissing,
        "LM Studio returned no visible language models.",
      );
    }

    const exactKeyVariants = groups.get(requested);
    if (exactKeyVariants !== undefined) {
      return resolved(requested, exactKeyVariants, "exact-key");
    }

    const exactVariantGroups = [...groups.values()].filter((variants) =>
      variants.some((model) => model.variantId === requested),
    );
    if (exactVariantGroups.length === 1) {
      const variants = exactVariantGroups[0] ?? [];
      return resolved(
        requested,
        variants,
        "exact-variant",
        variants.find((model) => model.variantId === requested),
      );
    }
    if (exactVariantGroups.length > 1) {
      ambiguous(
        requested,
        exactVariantGroups.flatMap((variants) => variants[0]?.logicalKey ?? []),
      );
    }

    const needle = normalizedModelName(requested);
    const normalizedGroups = [...groups.values()].filter((variants) =>
      variants.some(
        (model) =>
          normalizedModelName(model.logicalKey) === needle ||
          normalizedModelName(model.displayName) === needle,
      ),
    );
    if (normalizedGroups.length === 1) {
      return resolved(requested, normalizedGroups[0] ?? [], "normalized");
    }
    if (normalizedGroups.length > 1) {
      ambiguous(
        requested,
        normalizedGroups.flatMap((variants) => variants[0]?.logicalKey ?? []),
      );
    }

    throw new ModelClientError(
      ModelClientErrorCode.modelMissing,
      `Requested model ${JSON.stringify(requested)} is not visible through LM Studio. Run npm run models:lmstudio and configure the exact key.`,
    );
  }
}
