import { describe, it, expect, vi } from "vitest";
import { AutoVisualRouter, StockVisualRejection } from "./visual-providers/router";
import { PexelsVisualProvider } from "./visual-providers/pexelsVisualProvider";
import { VeoVisualProvider } from "./visual-providers/veoVisualProvider";
import { FalVisualProvider } from "./visual-providers/falVisualProvider";
import type { ProductionSceneSpec, ProductionSpec } from "../../types/productionSpec";

describe("Visual Providers & AutoVisualRouter", () => {
  const dummyPexelsApi: any = {
    findVideo: vi.fn().mockResolvedValue({
      id: 12345,
      url: "https://videos.pexels.com/video-12345.mp4",
      duration: 6,
      width: 1080,
      height: 1920,
    }),
  };

  const dummyScene: ProductionSceneSpec = {
    sceneIndex: 0,
    purpose: "hook",
    durationSeconds: 6,
    narration: "Check this out",
    stockSearchTerms: ["urban", "fashion"],
    visualSource: "stock",
    transition: "cut",
  };

  const dummySpec: ProductionSpec = {
    id: "test-spec",
    creationMode: "prompt",
    title: "Test",
    language: "en",
    dialect: "none",
    tone: "cool",
    contentStyle: "advertisement",
    durationSeconds: 24,
    aspectRatio: "9:16",
    resolution: "1080p",
    quality: "standard",
    sceneCount: 4,
    visualMode: "auto",
    voiceProvider: "kokoro",
    voiceId: "af_heart",
    captionStyle: "bold",
    scenes: [dummyScene],
  };

  const mockStockRegistry: any = {
    searchQueries: vi.fn().mockResolvedValue([]),
    attributionFor: vi.fn().mockReturnValue(undefined),
  };

  it("routes to Pexels in stock mode", async () => {
    const pexelsProvider = new PexelsVisualProvider(dummyPexelsApi, "test-key");
    const router = new AutoVisualRouter(pexelsProvider, [], mockStockRegistry);

    const result = await router.resolveSceneVisual(
      dummyScene,
      { ...dummySpec, visualMode: "stock" },
      { tempDirPath: "/tmp" },
    );

    expect(result.provider).toBe("pexels");
    expect(result.source).toBe("stock");
    expect(result.fallbackUsed).toBe(false);
    expect(result.url).toContain("pexels");
  });

  it("falls back to Pexels when AI video provider fails", async () => {
    const pexelsProvider = new PexelsVisualProvider(dummyPexelsApi, "test-key");
    const brokenVeo = new VeoVisualProvider("configured-key");
    vi.spyOn(brokenVeo, "isConfigured").mockReturnValue(true);
    vi.spyOn(brokenVeo, "fetchOrGenerateScene").mockRejectedValue(new Error("Veo Quota Exceeded"));

    const router = new AutoVisualRouter(pexelsProvider, [brokenVeo], mockStockRegistry);

    const result = await router.resolveSceneVisual(
      { ...dummyScene, visualSource: "ai" },
      { ...dummySpec, visualMode: "ai" },
      { tempDirPath: "/tmp" },
    );

    expect(result.provider).toBe("pexels");
    expect(result.fallbackUsed).toBe(true);
    expect(result.metadata?.fallbackReason).toContain("Veo Quota Exceeded");
  });

  describe("weak-stock rejection evidence", () => {
    const abstractScene: ProductionSceneSpec = {
      sceneIndex: 0,
      purpose: "solution",
      durationSeconds: 6,
      narration: "الـ API بيعمل cache للردود عشان السيرفر ميتعبش.",
      visualPrompt: "server returning cached api response",
      stockSearchTerms: ["technology"],
      visualSource: "stock",
      transition: "cut",
    };

    const genericOnlyCandidate = {
      provider: "pexels",
      id: "gen-1",
      kind: "video",
      downloadUrl: "https://videos.pexels.com/typing.mp4",
      width: 1080,
      height: 1920,
      durationSeconds: 8,
      queryUsed: "technology",
      tags: ["office", "people", "typing"],
      contributor: "x",
      semanticScore: 80,
      qualityScore: 90,
      totalScore: 85,
      decisionBreakdown: { semantic: 80, technical: 90, durationFit: 100, orientationFit: 100 },
    };

    const groundedRegistry = (candidates: any[]): any => ({
      searchQueries: vi.fn().mockResolvedValue(candidates),
      configuredProviders: () => [{ id: "pexels" }],
      attributionFor: vi.fn().mockReturnValue(undefined),
    });

    it("rejects a candidate that only matched a generic fallback query with no intent grounding", async () => {
      const pexels = new PexelsVisualProvider(dummyPexelsApi, "");
      vi.spyOn(pexels, "isConfigured").mockReturnValue(false);
      const router = new AutoVisualRouter(pexels, [], groundedRegistry([genericOnlyCandidate]));

      await expect(
        router.resolveSceneVisual(abstractScene, dummySpec, {
          tempDirPath: "/tmp",
          genericStockTerms: ["technology"],
        }),
      ).rejects.toBeInstanceOf(StockVisualRejection);
    });

    it("persists rejection evidence: queries attempted, candidates, scores and reason", async () => {
      const pexels = new PexelsVisualProvider(dummyPexelsApi, "");
      vi.spyOn(pexels, "isConfigured").mockReturnValue(false);
      const router = new AutoVisualRouter(pexels, [], groundedRegistry([genericOnlyCandidate]));

      try {
        await router.resolveSceneVisual(abstractScene, dummySpec, {
          tempDirPath: "/tmp",
          genericStockTerms: ["technology"],
        });
        expect.unreachable("should have rejected");
      } catch (error) {
        const rejection = error as StockVisualRejection;
        expect(rejection.details.candidateCount).toBe(1);
        expect(rejection.details.queriesAttempted).toContain("technology");
        expect(rejection.details.topRejected.length).toBeGreaterThan(0);
      }
    });

    it("accepts a generic-query candidate when its own tags ground it in the scene intent", async () => {
      const grounded = {
        ...genericOnlyCandidate,
        tags: ["server", "cached", "api", "backend"],
      };
      const pexels = new PexelsVisualProvider(dummyPexelsApi, "");
      vi.spyOn(pexels, "isConfigured").mockReturnValue(false);
      const router = new AutoVisualRouter(pexels, [], groundedRegistry([grounded]));

      const result = await router.resolveSceneVisual(abstractScene, dummySpec, {
        tempDirPath: "/tmp",
        genericStockTerms: ["technology"],
      });
      expect(result.source).toBe("stock");
      expect(result.provider).toBe("pexels");
    });

    it("rejects with no_candidates_returned when configured providers return nothing", async () => {
      const pexels = new PexelsVisualProvider(dummyPexelsApi, "");
      vi.spyOn(pexels, "isConfigured").mockReturnValue(false);
      const router = new AutoVisualRouter(pexels, [], groundedRegistry([]));

      try {
        await router.resolveSceneVisual(abstractScene, dummySpec, {
          tempDirPath: "/tmp",
          genericStockTerms: ["technology"],
        });
        expect.unreachable("should have rejected");
      } catch (error) {
        const rejection = error as StockVisualRejection;
        expect(rejection).toBeInstanceOf(StockVisualRejection);
        expect(rejection.details.reason).toBe("no_candidates_returned");
      }
    });

    it("accepts a candidate from a specific query even when its tags are sparse", async () => {
      const specific = {
        ...genericOnlyCandidate,
        queryUsed: "server rack data center close up",
        tags: [],
        semanticScore: 55,
      };
      const pexels = new PexelsVisualProvider(dummyPexelsApi, "");
      vi.spyOn(pexels, "isConfigured").mockReturnValue(false);
      const router = new AutoVisualRouter(pexels, [], groundedRegistry([specific]));

      const result = await router.resolveSceneVisual(abstractScene, dummySpec, {
        tempDirPath: "/tmp",
        genericStockTerms: ["technology"],
      });
      expect(result.source).toBe("stock");
    });
  });

  it("reports not_configured when keys are missing", async () => {
    const veo = new VeoVisualProvider("");
    const fal = new FalVisualProvider("");

    const veoVal = await veo.validate();
    const falVal = await fal.validate();

    expect(veoVal.status).toBe("not_configured");
    expect(falVal.status).toBe("not_configured");
  });
});
