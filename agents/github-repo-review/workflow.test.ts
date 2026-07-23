import { describe, expect, it } from "vitest";
import { fingerprintForFinding, reviewStages } from "./workflow.js";

describe("staged GitHub repository review", () => {
  it("defines all five required stages and stable fingerprints", () => {
    expect(reviewStages.map(([id]) => id)).toEqual(["inventory", "data-flow", "defects", "operational-quality", "evidence-validation"]);
    const finding = { severity: "high" as const, title: "Missing validation", path: "src/example.ts", evidence: "Input reaches the service unchanged", impact: "Invalid data may be processed", recommendation: "Validate at the boundary", confidence: "high" as const, limitations: [] };
    expect(fingerprintForFinding(finding)).toBe(fingerprintForFinding(finding));
  });
});
