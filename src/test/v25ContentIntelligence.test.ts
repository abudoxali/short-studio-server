import { describe, expect, it } from "vitest";

import { detectContentStyle } from "../server/v2/content-ai/contentStyleDetector";
import { LocalContentAIProvider } from "../server/v2/content-ai/localProvider";
import { mediaIntelligenceService } from "../server/v2/media-intelligence/mediaIntelligenceService";

/**
 * CONTENT INTELLIGENCE - GENERALIZATION
 * --------------------------------------
 * Post-recovery the engine no longer ships hard-coded fact packs or a
 * TOPIC_REGISTRY of benchmark scripts. The deterministic Basic planner is
 * honest by construction: topic-anchored narration, BASIC_FALLBACK
 * provenance, low confidence, and never a verbatim copy of the brief. The
 * style detector still routes curiosity/explainer prompts correctly, and
 * the media planner still receives real scene specs.
 */

describe("Content style auto-detection", () => {
  it("detects a curiosity prompt with no explicit contentStyle field available", () => {
    expect(
      detectContentStyle(
        "Create a 25-second vertical curiosity video explaining why airplane windows are rounded instead of square.",
      ),
    ).toBe("viral_curiosity");
  });

  it("does not override an unambiguous business/ad prompt", () => {
    expect(
      detectContentStyle(
        "Create a professional vertical social video for a small web-design service. CTA: Make your business look professional.",
      ),
    ).toBeNull();
  });
});

describe("Basic planner honesty on arbitrary topics", () => {
  it("anchors narration to the topic and marks BASIC_FALLBACK provenance (curiosity prompt)", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "Create a 25-second vertical curiosity video explaining why airplane windows are rounded instead of square. Use highly relevant real footage, fast clean editing, natural narration and clean captions.",
      language: "en",
      requestedDurationSeconds: 25,
    });

    const allNarration = spec.scenes.map((s) => s.narration).join(" ").toLowerCase();
    // The brief's meta wording must never be spoken.
    expect(allNarration).not.toContain("curiosity video");
    expect(allNarration).not.toContain("create a");
    expect(allNarration).not.toContain("real footage");
    // And the topic itself must be materially present (topic-concept
    // anchoring), so the script is about airplanes/windows, not filler.
    expect(allNarration).toMatch(/airplane|window/);

    expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
    expect((spec.metadata as any)?.contentConfidence).toBe("low");
    expect((spec.metadata as any)?.basicMode).toBe(true);
  });

  it("handles an unrelated topic through the same generic mechanism", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "Why do phone batteries charge much slower after about 80%? Make it a 20-second explainer with real footage.",
      language: "en",
      requestedDurationSeconds: 20,
    });

    const allNarration = spec.scenes.map((s) => s.narration).join(" ").toLowerCase();
    expect(allNarration).not.toContain("make it a 20-second");
    expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
  });

  it("keeps a business prompt channel-safe and topic-anchored", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "Create a video explaining why our web design service is the best choice for small businesses.",
      language: "en",
      requestedDurationSeconds: 20,
    });
    expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
    const combined = spec.scenes.map((s) => s.narration).join(" ").toLowerCase() + " " + (spec.cta?.text || "").toLowerCase();
    expect(combined).not.toContain("whatsapp");
    expect(combined).toMatch(/web|design|business/);
  });
});

describe("Media planning still receives real scene specs", () => {
  it("produces a media plan from a basic-mode spec", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "Create a 25-second vertical curiosity video explaining why airplane windows are rounded instead of square.",
      language: "en",
      requestedDurationSeconds: 25,
    });
    const mediaPlan = mediaIntelligenceService.generateMediaPlan(spec);
    expect(mediaPlan.scenes.length).toBeGreaterThan(0);
    expect(mediaPlan.scenes.every((s) => (s.segments?.length || 0) > 0)).toBe(true);
  });
});
