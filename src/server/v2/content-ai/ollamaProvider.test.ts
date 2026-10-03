import { describe, expect, it, afterEach } from "vitest";
import nock from "nock";

import { ContentPlannerError, OllamaContentAIProvider } from "./ollamaProvider";

/**
 * OLLAMA CREATIVE PLANNER - HONEST FAILURE + TRUTH SAFETY
 * ------------------------------------------------------
 * The planner must never silently fall back to canned deterministic content
 * while the UI presents the result as "AI Creative Director". A configured
 * but unreachable/broken Ollama endpoint raises ContentPlannerError so the
 * route can return an explicit, localized planner_unavailable failure. The
 * compact creative-plan contract is enforced per-field: a scene that
 * reintroduces an invented WhatsApp CTA is discarded without losing the
 * LLM's good scenes.
 */

const PROMPT = "Create a professional vertical social video for a small web-design service. Do not invent phone numbers or WhatsApp numbers.\nCTA: Make your business look professional.";

const GOOD_PLAN = {
  title: "Web Design That Wins",
  scenes: [
    { purpose: "hook", narration: "Is your website driving customers away?", onScreenText: "Outdated Website?", visualIntent: "Frustrated visitor leaving a cluttered site on a laptop", searchQueries: ["frustrated user laptop", "cluttered website screen", "person leaving website"] },
    { purpose: "solution", narration: "We build fast, modern, mobile-friendly sites.", onScreenText: "Fast & Modern", visualIntent: "Clean responsive website shown on phone and laptop", searchQueries: ["responsive website laptop", "modern web design screen", "mobile friendly website"] },
    { purpose: "cta", narration: "Make your business look professional.", onScreenText: "Make your business look professional.", visualIntent: "Confident business owner smiling at result", searchQueries: ["business owner smiling", "confident entrepreneur office"] },
  ],
};

afterEach(() => {
  nock.cleanAll();
});

describe("OllamaContentAIPlanner failure surface", () => {
  it("throws planner_unavailable when the endpoint is unreachable (no silent canned fallback)", async () => {
    const provider = new OllamaContentAIProvider("http://127.0.0.1:1", "test-model");
    await expect(
      provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 }),
    ).rejects.toMatchObject({ plannerCode: "planner_unavailable" });
  });

  it("throws planner_invalid_response when the endpoint returns malformed JSON", async () => {
    nock("http://ollama.test").post("/api/generate").twice().reply(200, { response: "not json at all" });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    await expect(
      provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 }),
    ).rejects.toMatchObject({ plannerCode: "planner_invalid_response" });
  });

  it("throws a ContentPlannerError when the endpoint errors (5xx)", async () => {
    nock("http://ollama.test").post("/api/generate").twice().reply(500, "internal error");
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    await expect(
      provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 }),
    ).rejects.toBeInstanceOf(ContentPlannerError);
  });

  it("throws planner_unavailable when generation exceeds the bounded timeout", async () => {
    const previous = process.env.OLLAMA_TIMEOUT_MS;
    process.env.OLLAMA_TIMEOUT_MS = "80";
    try {
      nock("http://ollama.test").post("/api/generate").delay(400).reply(200, { response: "{}" });
      nock("http://ollama.test").post("/api/generate").delay(400).reply(200, { response: "{}" });
      const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
      await expect(
        provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 }),
      ).rejects.toMatchObject({ plannerCode: "planner_unavailable" });
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_TIMEOUT_MS;
      else process.env.OLLAMA_TIMEOUT_MS = previous;
    }
  });

  it("throws planner_invalid_response when the configured model is not installed", async () => {
    nock("http://ollama.test")
      .post("/api/generate")
      .times(2)
      .reply(404, { error: "model 'test-model' not found" });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    await expect(
      provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 }),
    ).rejects.toMatchObject({ plannerCode: "planner_invalid_response" });
  });

  it("falls back to the labelled Basic planner only when Ollama is not configured at all", async () => {
    const provider = new OllamaContentAIProvider("", "test-model");
    const spec = await provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 });
    expect(spec.scenes.length).toBeGreaterThan(0);
    expect((spec.metadata as any)?.planner).toBe("LocalContentAIProvider");
    expect((spec.metadata as any)?.fallbackUsed).toBe(true);
    expect((spec.metadata as any)?.contentProvenance).toBe("BASIC_FALLBACK");
  });
});

describe("OllamaContentAIPlanner creative output", () => {
  it("assembles a real spec from a compact creative plan", async () => {
    nock("http://ollama.test").post("/api/generate").reply(200, { response: JSON.stringify(GOOD_PLAN) });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    const spec = await provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 });

    expect((spec.metadata as any)?.planner).toBe("OllamaContentAIProvider");
    expect((spec.metadata as any)?.plannerModel).toBe("test-model");
    expect(typeof (spec.metadata as any)?.plannerLatencyMs).toBe("number");
    expect((spec.metadata as any)?.fallbackUsed).toBe(false);
    expect((spec.metadata as any)?.contentProvenance).toBe("MODEL_GENERATED");
    expect(spec.scenes[0].narration).toContain("driving customers away");
    expect(spec.scenes[0].purpose).toBe("hook");
    // Per-scene visual intent drives its own stock queries.
    expect(spec.scenes[0].stockSearchTerms.join(" ")).toContain("laptop");
    // The user's explicit CTA is honored verbatim.
    expect(spec.cta?.text).toBe("Make your business look professional.");
  });

  it("drops a scene line that reintroduces an invented WhatsApp CTA without losing the good scenes", async () => {
    const badPlan = {
      ...GOOD_PLAN,
      scenes: [
        GOOD_PLAN.scenes[0],
        GOOD_PLAN.scenes[1],
        { ...GOOD_PLAN.scenes[2], narration: "Message us on WhatsApp today!", onScreenText: "Message Us on WhatsApp" },
      ],
      cta: "Message us on WhatsApp today!",
    };
    nock("http://ollama.test").post("/api/generate").reply(200, { response: JSON.stringify(badPlan) });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    const spec = await provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 });

    const ctaScene = spec.scenes.find((s) => s.purpose === "cta");
    expect(ctaScene?.narration.toLowerCase()).not.toContain("whatsapp");
    expect((ctaScene?.onScreenText || "").toLowerCase()).not.toContain("whatsapp");
    expect(spec.cta?.text.toLowerCase()).not.toContain("whatsapp");
    expect(spec.cta?.contact).toBeUndefined();
    // The two scenes the LLM did NOT corrupt still come from its response.
    expect(spec.scenes[0].narration).toContain("driving customers away");
  });

  it("never lets prompt text leak verbatim into generated narration", async () => {
    const leakyPlan = {
      scenes: [
        { purpose: "hook", narration: PROMPT, visualIntent: "office", searchQueries: ["office desk"] },
        { purpose: "solution", narration: "Fresh, original line about web design.", searchQueries: ["web design screen"] },
      ],
    };
    nock("http://ollama.test").post("/api/generate").reply(200, { response: JSON.stringify(leakyPlan) });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    const spec = await provider.generateProductionSpec({ prompt: PROMPT, language: "en", requestedDurationSeconds: 20 });
    expect(spec.scenes[0].narration).not.toBe(PROMPT);
    expect(spec.scenes[0].narration).not.toContain("Do not invent phone numbers");
  });

  it("never speaks a duration fragment as the fallback topic entity", async () => {
    // Regression: a brief like "اعمل فيديو 15 ثانية عن X" left "15 ثانية" in
    // coreEntity, and a rejected scene line fell back to "النقطة المهمة عن
    // 15 ثانية." - duration text spoken aloud.
    const arPrompt = "عايز إعلان 15 ثانية عن غسيل العربيات المتنقل";
    const plan = {
      scenes: [
        { purpose: "hook", narration: arPrompt, searchQueries: ["car wash"] },
        { purpose: "solution", narration: "فريقنا بيغسل عربيتك في مكانك.", searchQueries: ["car cleaning"] },
      ],
    };
    nock("http://ollama.test").post("/api/generate").reply(200, { response: JSON.stringify(plan) });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    const spec = await provider.generateProductionSpec({ prompt: arPrompt, language: "ar", requestedDurationSeconds: 15 });
    expect(spec.scenes[0].narration).not.toContain("15");
    expect(spec.scenes[0].narration).not.toContain("ثانية");
  });

  it("preserves real negations in model narration (No soil needed must not invert)", async () => {
    const hydroPrompt = "Create a video about hydroponic gardening at home.";
    const plan = {
      scenes: [
        { purpose: "hook", narration: "Imagine growing vegetables in your kitchen!", searchQueries: ["hydroponic garden"] },
        { purpose: "solution", narration: "Hydroponics uses water and nutrients. No soil needed!", searchQueries: ["plant roots water"] },
      ],
    };
    nock("http://ollama.test").post("/api/generate").reply(200, { response: JSON.stringify(plan) });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    const spec = await provider.generateProductionSpec({ prompt: hydroPrompt, language: "en", requestedDurationSeconds: 15 });
    expect(spec.scenes[1].narration).toContain("No soil needed");
    expect(spec.scenes[1].narration).not.toMatch(/^\s*soil needed/i);
  });

  it("fallback narration uses the quoted brand entity, never prompt residue like عايزين فيديو إعلاني 15", async () => {
    const prompt =
      "عايزين فيديو إعلاني 15 ثانية لخدمة «لمعة» - غسيل و تلميع عربيات متنقل. بنوصل لحد البيت أو الشغل. ممنوع أي أرقام تليفونات أو أسعار.";
    const plan = {
      scenes: [
        { purpose: "hook", narration: "خدمة لمعة بتوصل لحد باب البيت!", searchQueries: ["car wash"] },
        { purpose: "problem", narration: "WhatsApp us at 01000000000 now!", searchQueries: ["mobile wash"] },
      ],
    };
    nock("http://ollama.test").post("/api/generate").reply(200, { response: JSON.stringify(plan) });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    const spec = await provider.generateProductionSpec({ prompt, language: "ar", dialect: "egyptian", requestedDurationSeconds: 15 });
    const fallback = spec.scenes[1].narration;
    expect(fallback).not.toMatch(/عايز|فيديو|إعلاني|\d+/);
    expect(fallback).toContain("لمعة");
  });

  it("strips the imperative explain-verb so it is not spoken as part of the topic", async () => {
    const arPrompt = "اشرح فكرة التوفير التلقائي في البنوك";
    const plan = {
      scenes: [
        { purpose: "hook", narration: arPrompt, searchQueries: ["bank office"] },
        { purpose: "solution", narration: "الفلوس بتتخصم لوحدها كل شهر.", searchQueries: ["savings app"] },
      ],
    };
    nock("http://ollama.test").post("/api/generate").reply(200, { response: JSON.stringify(plan) });
    const provider = new OllamaContentAIProvider("http://ollama.test", "test-model");
    const spec = await provider.generateProductionSpec({ prompt: arPrompt, language: "ar", requestedDurationSeconds: 15 });
    expect(spec.scenes[0].narration).not.toContain("اشرح");
  });
});
