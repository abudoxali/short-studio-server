import { describe, expect, it } from "vitest";

import { LocalContentAIProvider } from "../server/v2/content-ai/localProvider";
import { OllamaContentAIProvider } from "../server/v2/content-ai/ollamaProvider";
import { GeminiContentAIProvider } from "../server/v2/content-ai/geminiProvider";
import { ContentAIRegistry } from "../server/v2/content-ai/registry";
import { Config } from "../config";

/**
 * UNKNOWN TOPIC HONESTY
 * --------------------
 * These topics are deliberately NOT covered by any curated content (the old
 * hard-coded fact packs and TOPIC_REGISTRY benchmark scripts were removed in
 * the production-intelligence recovery - the engine must be honest about
 * coverage rather than pretend). The deterministic Basic planner never
 * fabricates an explanation: it marks output contentProvenance
 * BASIC_FALLBACK + contentConfidence low, anchors narration to the
 * customer's extracted topic, and never splices the raw question in as
 * spoken copy. The real creative answer for these topics is the Ollama
 * creative planner, which either produces MODEL_GENERATED content or fails
 * with an explicit planner error.
 */
const UNKNOWN_TOPICS = [
  "Why does metal feel colder than wood at the same room temperature?",
  "Why does bread become stale?",
  "Why do cats' eyes glow in the dark?",
];

describe("Basic planner is honest, not confidently fabricated, for unknown topics", () => {
  for (const topic of UNKNOWN_TOPICS) {
    it(`marks BASIC_FALLBACK / low confidence instead of inventing an explanation for: "${topic}"`, async () => {
      const provider = new LocalContentAIProvider();
      const spec = await provider.generateProductionSpec({
        prompt: topic,
        language: "en",
        requestedDurationSeconds: 20,
      });

      expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
      expect((spec.metadata as any)?.contentConfidence).toBe("low");
      expect((spec.metadata as any)?.basicMode).toBe(true);

      // The basic fallback must never splice the raw question text in as if
      // it were a written line - that would look like a fabricated fact.
      const allNarration = spec.scenes.map((s) => s.narration).join(" ").toLowerCase();
      expect(allNarration).not.toContain(topic.toLowerCase().replace(/[?.]/g, ""));
      expect(allNarration).not.toContain("create a");
    });
  }
});

describe("Registry precedence - Ollama/Gemini first when configured, labelled Basic otherwise", () => {
  it("an unconfigured Ollama degrades to the labelled Basic planner without throwing", async () => {
    const ollama = new OllamaContentAIProvider("", "test-model");
    const gemini = new GeminiContentAIProvider(undefined);
    expect(ollama.isConfigured).toBe(false);
    expect(gemini.isConfigured).toBe(false);

    const spec = await ollama.generateProductionSpec({
      prompt: UNKNOWN_TOPICS[0],
      language: "en",
      requestedDurationSeconds: 20,
    });
    expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
    expect((spec.metadata as any)?.fallbackUsed).toBe(true);
    expect((spec.metadata as any)?.fallbackReason).toMatch(/OLLAMA_BASE_URL/);
  });

  it("registry order is Ollama (if configured) -> Gemini (if configured) -> deterministic Local AI", () => {
    const registry = new ContentAIRegistry(new Config(), undefined);
    const provider = registry.getProvider();
    // Neither Ollama nor Gemini is configured in the test environment
    // (no OLLAMA_BASE_URL / GEMINI_API_KEY), so the registry must resolve
    // to the deterministic Local provider rather than a provider that
    // would fail or hang against an unreachable endpoint.
    expect(provider.id).toBe("local_ai");
  });
});
