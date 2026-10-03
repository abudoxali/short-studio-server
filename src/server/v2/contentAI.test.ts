import { describe, it, expect } from "vitest";
import { LocalContentAIProvider } from "./content-ai/localProvider";
import { ContentAIRegistry } from "./content-ai/registry";
import { providerSecrets } from "./provider-vault/providerSecrets";

describe("Content AI Providers & Creative Director", () => {
  it("Local AI creates valid Egyptian Arabic production spec from prompt", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "اعمل اعلان 20 ثانية لبراند ملابس شبابي، البداية Hook قوي والختام واتساب",
      language: "ar",
      dialect: "egyptian",
    });

    expect(spec.creationMode).toBe("prompt");
    expect(spec.language).toBe("ar");
    expect(spec.dialect).toBe("egyptian");
    expect(spec.scenes.length).toBeGreaterThanOrEqual(3);
    expect(spec.scenes[0].purpose).toBe("hook");
    expect(spec.scenes[spec.scenes.length - 1].purpose).toBe("cta");
    expect(spec.scenes[0].stockSearchTerms.length).toBeGreaterThan(0);
    expect(spec.cta?.contact).toBe("WhatsApp");
  });

  it("Local AI (Basic mode) produces topic-anchored English scenes without canned vertical content", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "Create a 30-second educational short explaining why backups matter for small businesses",
      language: "en",
    });

    expect(spec.language).toBe("en");
    expect(spec.scenes.length).toBe(3);
    // Topic-anchored: the generated line references the customer's subject
    // ("backup"/"business"), never canned pack copy or the raw prompt.
    const narration = spec.scenes.map((s) => s.narration).join(" ").toLowerCase();
    expect(narration).toMatch(/backup|business/);
    expect(narration).not.toContain("explaining why backups matter");
    expect(spec.scenes[0].stockSearchTerms.length).toBeGreaterThan(0);
    expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
  });

  it("Local AI (Basic mode) anchors an English coffee prompt to the topic", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "Create a 20-second vertical Short for a modern coffee subscription with real cafe preparation footage",
      language: "en",
      durationSeconds: 20,
    });

    expect(spec.language).toBe("en");
    expect(spec.scenes).toHaveLength(3);
    expect(spec.scenes[0].stockSearchTerms.join(" ").toLowerCase()).toContain("coffee");
    expect(spec.scenes[0].onScreenText?.toLowerCase()).toContain("coffee");
    expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
  });

  it("Local AI (Basic mode) anchors an English fitness prompt to the topic", async () => {
    const provider = new LocalContentAIProvider();
    const spec = await provider.generateProductionSpec({
      prompt: "Create a 20-second vertical Short for a boutique fitness studio with real people training",
      language: "en",
      durationSeconds: 20,
    });

    expect(spec.language).toBe("en");
    expect(spec.scenes).toHaveLength(3);
    // Topic concepts are lightly stemmed ("fitness" -> "fitnes").
    expect(spec.scenes[0].stockSearchTerms.join(" ").toLowerCase()).toContain("fitnes");
    expect(spec.scenes[0].onScreenText?.toLowerCase()).toContain("fitnes");
  });

  it("Local AI enhances prompts with structured guidance without replacing original", async () => {
    const provider = new LocalContentAIProvider();
    const result = await provider.rewritePrompt("اعمل اعلان لكافيه");

    expect(result.originalPrompt).toBe("اعمل اعلان لكافيه");
    expect(result.enhancedPrompt.length).toBeGreaterThan(result.originalPrompt.length);
    expect(result.enhancedPrompt).toContain("Hook");
    expect(result.changesSummary.length).toBeGreaterThan(0);
  });

  it("ContentAIRegistry falls back gracefully to Local AI when Gemini is unconfigured", () => {
    const registry = new ContentAIRegistry();
    const provider = registry.getProvider();
    expect(provider.id).toBe("local_ai");
  });

  it("ContentAIRegistry prefers a Gemini credential resolved from Provider Vault over environment fallback", async () => {
    providerSecrets.registerResolver(async (providerId, credentialType) =>
      providerId === "gemini" && credentialType === "api_key" ? "vault-gemini-key-123" : null,
    );
    await providerSecrets.refresh("gemini", "api_key");

    try {
      const registry = new ContentAIRegistry();
      expect(registry.getProvider("gemini").id).toBe("gemini");
      expect(registry.getProvider().id).toBe("gemini");
    } finally {
      providerSecrets.unregisterResolver();
    }
  });
});
