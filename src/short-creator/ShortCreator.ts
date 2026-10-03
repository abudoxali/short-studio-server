/* eslint-disable @remotion/deterministic-randomness */
import fs from "fs-extra";
import cuid from "cuid";
import path from "path";
import https from "https";
import http from "http";
import axios from "axios";
import { exec as execCb } from "child_process";
import { promisify } from "util";
const execAsync = promisify(execCb);

import { Kokoro } from "./libraries/Kokoro";
import { Remotion } from "./libraries/Remotion";
import { Whisper } from "./libraries/Whisper";
import {
  isAlignmentConfident,
  mapAlignmentToCaptionTokens,
} from "../server/v2/voice-providers/elevenLabsAlignment";
import {
  alignWhisperToNarration,
  WHISPER_SCRIPT_SIMILARITY_THRESHOLD,
} from "./libraries/whisperAlignment";
import { validateScriptQuality, validateSentenceCompleteness } from "../server/v2/content-ai/scriptQuality";
import { decideCorrectionAction } from "../server/v2/content-ai/scriptDurationController";
import { renderArabicCaptions } from "../server/v2/captions/arabicCaptionRendererV3";
import { runCaptionQa } from "../server/v2/captions/captionQa";
import { resolveCaptionStyle } from "../server/v2/captions/captionStyles";
import {
  buildEditDecisionList,
  intentForPurpose,
  type VisualShot,
} from "../server/v2/editing/editDecisionList";
import { composeVisualBed } from "../server/v2/editing/visualBedComposer";
import { mockupForIntent } from "../server/v2/mockups/websiteMockupRenderer";
import {
  buildCreativePlan,
  creativePlanFacts,
  type CreativePlan,
  type CreativeStylePresetId,
} from "../server/v2/creative/creativePlan";
import {
  isMotionTreatment,
  TREATMENT_MOTION_TEMPLATE,
  TREATMENT_RUNTIME,
  sceneRendersAsMotion,
  buildTreatmentAvailabilityPredicate,
  type VisualTreatment,
} from "../server/v2/creative/visualTreatment";
import { splitNarrationBeats } from "../server/v2/creative/visualIntentClassifier";
import { resolveBrandStyle } from "../server/v2/creative/brandStyle";
import {
  buildStockQueryFamilies,
  queryFamilyTerms,
} from "../server/v2/creative/stockQueryFamilies";
import { preprocessArabicSpeech } from "../server/v2/voice-providers/arabicSpeechPreprocessor";
import {
  cropMetadata,
  planSmartCrop,
  probeVisualFocus,
  type SmartCropPlan,
} from "../server/v2/media-intelligence/smartCrop";
import {
  analyzeVideoSemanticSimilarity,
  arePerceptuallyNearDuplicate,
} from "../server/v2/media-intelligence/semanticSimilarity";
import { applyVisualIntentPolicy } from "../server/v2/media-intelligence/visualIntentPolicy";
import { getSharedOpenClipWorkerPool } from "../server/v2/media-intelligence/openClipWorkerPool";
import { detectShots, selectBestWindow } from "../server/v2/quality/sceneDetectionAdapter";
import { FFMpeg } from "./libraries/FFmpeg";
import { PexelsAPI } from "./libraries/Pexels";
import { Config } from "../config";
import { logger } from "../logger";
import { MusicManager, pickQuietestSafeMusicStart } from "./music";
import {
  readMetadata,
  writeMetadata,
  deleteMetadata,
  type VideoMetadata,
} from "../server/videoMetadata";
import {
  OrientationEnum,
  type Caption,
  type RenderConfig,
  type Scene,
  type VideoStatus,
  type MusicMoodEnum,
  type MusicTag,
  type MusicForVideo,
  type SceneInputWithFallback,
  type BusinessTemplateId,
} from "../types/shorts";
import {
  type ProductionSpec,
  type ProductionSceneSpec,
  type ResolvedProductionTimeline,
  compactNarrationToBudget,
  planSceneVisualDurationSeconds,
  resolveProductionTimeline,
  validateProductionSpec,
} from "../types/productionSpec";
import { convertTemplateToProductionSpec } from "../server/v2/templateToSpec";
import { VisualRegistry } from "../server/v2/visual-providers/registry";
import { VoiceRegistry } from "../server/v2/voice-providers/registry";
import type { VoiceProviderId, VoiceQualityProfile } from "../server/v2/voice-providers/types";
import { AutoVisualRouter, StockVisualRejection } from "../server/v2/visual-providers/router";
import { sceneSourceRouter } from "../server/v2/visual-providers/sceneSourceRouter";
import { mediaIntelligenceService } from "../server/v2/media-intelligence/mediaIntelligenceService";
import { mediaCache } from "../server/v2/media-cache/mediaCache";
import { providerSecrets } from "../server/v2/provider-vault/providerSecrets";
import { AudioMasteringService } from "./audioMasteringService";
import { postProductionPipeline } from "../server/v2/post-production/postProductionPipeline";
import { qualityEngine } from "../server/v2/quality/qualityEngine";
import { calculateProfessionalVisualQualityReport } from "../server/v2/quality/professionalVisualQuality";
import { assessFinalQuality } from "../server/v2/quality/finalQualityContract";
import { MediaUploadService } from "../server/v2/media/mediaUploadService";
import type { ResolvedSceneAsset } from "../server/v2/visual-providers/router";
import {
  planCustomerMedia,
  resolveCustomerMediaMode,
  type CustomerMediaCandidate,
  type CustomerMediaPlan,
  type CustomerSceneAssignment,
} from "../server/v2/media/customerMediaPlanner";

/**
 * Provider id recorded for a visual that came from the customer's own Media
 * Library. It is a real provenance value, persisted into output metadata and
 * asserted by the customer-media regressions.
 */
const CUSTOMER_MEDIA_PROVIDER = "customer_media";
import { evaluateVisualCoherence } from "../server/v2/quality/visualCoherence";
import { motionEngine, type MotionTemplateType } from "../server/v2/motion/motionEngine";
import { mediaUploadService } from "../server/v2/media/mediaUploadService";
import { capabilityManager } from "../server/v2/capabilities/capabilityManager";
import {
  DurableArtifactStore,
  type DurableSceneArtifact,
  createCaptionInputHash,
  createMediaInputHash,
  createVoiceInputHash,
  filterReusableArtifacts,
  sha256Text,
  type RetryReuseManifest,
} from "../server/v2/artifacts/durableArtifacts";
import { assertStorageReady } from "../server/v2/storage/storagePolicy";
import { decideRenderStrategy, type RenderStrategyDecision } from "../server/v2/rendering/renderStrategy";
import { renderFfmpegFast, type FastRenderClip, type FastRenderVoice } from "../server/v2/rendering/ffmpegFastRenderer";
import {
  productionTimelineFromLegacyScenes,
  clampCaptionWordsToNarration,
  type LegacySceneInput,
} from "../video-core/fromLegacyScenes";
import { RevideoRenderer } from "../video-core/renderers/revideoRenderer";
import type { ProductionTemplate } from "../video-core/types";

type RenderProgressEvent = {
  status:
  | "preparing"
  | "generating_content"
  | "searching_assets"
  | "generating_voice"
  | "generating_captions"
  | "rendering"
  | "finalizing";
  progress: number;
  currentStage: string;
  message: string;
  stageKey?: "planning" | "media" | "voice" | "captions" | "render" | "mastering" | "validation";
  checkpointStatus?: "running" | "completed" | "failed";
  provider?: string;
  artifacts?: Record<string, unknown>;
  inputHashSource?: unknown;
  timingMs?: number;
};

type RenderProgressCallback = (event: RenderProgressEvent) => Promise<void> | void;

export const RETRY_ARTIFACT_REUSE_INVALID = "RETRY_ARTIFACT_REUSE_INVALID";

type ExplicitRetryReuseValidationInput = {
  artifact: DurableSceneArtifact;
  expectedType: DurableSceneArtifact["type"];
  expectedSceneIndex: number;
  expectedProvider?: string;
  expectedModel?: string;
  expectedVoiceId?: string;
  canonicalSpokenContentFingerprint?: string;
  displayContentFingerprint?: string;
};

export type ExplicitRetryReuseValidationResult = {
  valid: boolean;
  reason?: string;
};

function artifactVoiceId(artifact: DurableSceneArtifact): string | undefined {
  const retryManifest = (artifact.metadata?.retryReuseManifest || {}) as Partial<RetryReuseManifest>;
  const reuseKey = (artifact.metadata?.reuseKey || {}) as Record<string, unknown>;
  const voiceArtifact = (artifact.metadata?.voiceArtifact || {}) as Record<string, unknown>;
  return String(retryManifest.voiceId || reuseKey.voiceId || voiceArtifact.voiceId || "").trim() || undefined;
}

function artifactVoiceStrategy(artifact: DurableSceneArtifact): string | undefined {
  const retryManifest = (artifact.metadata?.retryReuseManifest || {}) as Partial<RetryReuseManifest>;
  const reuseKey = (artifact.metadata?.reuseKey || {}) as Record<string, unknown>;
  const voiceArtifact = (artifact.metadata?.voiceArtifact || {}) as Record<string, unknown>;
  return String(retryManifest.voiceStrategy || reuseKey.voiceStrategy || voiceArtifact.voiceStrategy || "").trim() || undefined;
}

export function retryContentFingerprint(input: {
  text: string;
  language?: string;
  dialect?: string;
}): string {
  return sha256Text({
    text: String(input.text || "").trim(),
    language: input.language || "auto",
    dialect: input.dialect || "none",
  });
}

export function validateExplicitRetryReuseArtifact(
  input: ExplicitRetryReuseValidationInput,
): ExplicitRetryReuseValidationResult {
  const { artifact } = input;
  const manifest = (artifact.metadata?.retryReuseManifest || {}) as Partial<RetryReuseManifest>;
  if (!artifact.valid) return { valid: false, reason: "artifact is not valid" };
  if (artifact.supersededAt) return { valid: false, reason: "artifact is superseded" };
  if (artifact.type !== input.expectedType) return { valid: false, reason: `expected ${input.expectedType}, got ${artifact.type}` };
  if (artifact.sceneIndex !== input.expectedSceneIndex) {
    return { valid: false, reason: `expected scene ${input.expectedSceneIndex}, got ${artifact.sceneIndex}` };
  }
  if (!artifact.sourceJobId) return { valid: false, reason: "missing source job id" };
  if (
    !artifact.storageRef ||
    !artifact.storageRef.replace(/\\/g, "/").startsWith("artifacts/scene/") ||
    artifact.storageRef.includes("..") ||
    artifact.storageRef.startsWith("/") ||
    /^[a-zA-Z]:/.test(artifact.storageRef)
  ) {
    return { valid: false, reason: "unsafe storage ref" };
  }
  if (!/^[a-f0-9]{64}$/i.test(artifact.checksum || "")) {
    return { valid: false, reason: "invalid checksum metadata" };
  }
  if (manifest.compatibilityDecision !== "planner_bound") {
    return { valid: false, reason: "missing planner-bound retry reuse manifest" };
  }
  if (manifest.compatibilityVersion !== "retry-reuse-v1") {
    return { valid: false, reason: "unsupported retry reuse manifest version" };
  }
  if (manifest.artifactId && manifest.artifactId !== artifact.artifactId) {
    return { valid: false, reason: "manifest artifact id mismatch" };
  }
  if (manifest.artifactType && manifest.artifactType !== artifact.type) {
    return { valid: false, reason: "manifest artifact type mismatch" };
  }
  if (typeof manifest.sceneIndex === "number" && manifest.sceneIndex !== artifact.sceneIndex) {
    return { valid: false, reason: "manifest scene index mismatch" };
  }
  if (manifest.checksum && manifest.checksum !== artifact.checksum) {
    return { valid: false, reason: "manifest checksum mismatch" };
  }
  if (
    manifest.canonicalSpokenContentFingerprint &&
    input.canonicalSpokenContentFingerprint &&
    manifest.canonicalSpokenContentFingerprint !== input.canonicalSpokenContentFingerprint
  ) {
    return { valid: false, reason: "canonical spoken content changed" };
  }
  if (
    manifest.displayContentFingerprint &&
    input.displayContentFingerprint &&
    manifest.displayContentFingerprint !== input.displayContentFingerprint
  ) {
    return { valid: false, reason: "display content changed" };
  }
  const artifactProvider = artifact.provider || manifest.provider;
  if (input.expectedProvider && input.expectedProvider !== "auto" && artifactProvider && artifactProvider !== input.expectedProvider) {
    return { valid: false, reason: `provider mismatch: ${artifactProvider}` };
  }
  const artifactModel = artifact.model || manifest.model;
  if (input.expectedModel && artifactModel && artifactModel !== input.expectedModel) {
    return { valid: false, reason: `model mismatch: ${artifactModel}` };
  }
  if (input.expectedType === "voice" && input.expectedVoiceId) {
    const voiceId = artifactVoiceId(artifact);
    if (!voiceId) return { valid: false, reason: "missing voice id metadata" };
    if (voiceId !== input.expectedVoiceId) return { valid: false, reason: `voice mismatch: ${voiceId}` };
  }
  const voiceStrategy = artifactVoiceStrategy(artifact);
  if (input.expectedType === "voice" && voiceStrategy && !["plain_tts", "timestamps"].includes(voiceStrategy)) {
    return { valid: false, reason: `voice strategy mismatch: ${voiceStrategy}` };
  }
  return { valid: true };
}

function failExplicitRetryReuse(
  artifact: DurableSceneArtifact,
  expectedType: DurableSceneArtifact["type"],
  sceneIndex: number,
  reason: string,
): never {
  const error = new Error(
    `${RETRY_ARTIFACT_REUSE_INVALID}: scene=${sceneIndex} type=${expectedType} artifact=${artifact.artifactId} reason=${reason}`,
  );
  (error as any).code = RETRY_ARTIFACT_REUSE_INVALID;
  throw error;
}

/**
 * Bottom band of a 9:16 frame commonly covered by TikTok / Reels UI. Captions
 * are held above it so the platform chrome cannot sit on the words.
 */
const PLATFORM_SAFE_BOTTOM_RATIO = 0.14;

export class ShortCreator {
  private queue: {
    spec: ProductionSpec;
    id: string;
  }[] = [];

  private visualRegistry: VisualRegistry;
  private voiceRegistry: VoiceRegistry;
  private visualRouter: AutoVisualRouter;
  private audioMastering: AudioMasteringService;

  constructor(
    private config: Config,
    private remotion: Remotion,
    private kokoro: Kokoro,
    private whisper: Whisper,
    private ffmpeg: FFMpeg,
    private pexelsApi: PexelsAPI,
    private musicManager: MusicManager,
  ) {
    this.visualRegistry = new VisualRegistry(this.pexelsApi, this.config);
    this.visualRouter = this.visualRegistry.getRouter();
    this.voiceRegistry = new VoiceRegistry(this.kokoro);
    this.audioMastering = new AudioMasteringService(this.ffmpeg);
  }

  public status(id: string): VideoStatus {
    const videoPath = this.getVideoPath(id);
    if (this.queue.find((item) => item.id === id)) {
      return "processing";
    }
    const sidecar = readMetadata(this.config.videosDirPath, id);
    // V2.5.1: a reviewable video is a delivered video. It keeps its own status
    // so the library can show it truthfully instead of flattening it to
    // "ready" (which would hide the notes) or "failed" (which would hide the
    // video).
    if (
      (sidecar?.status === "needs_review" || sidecar?.finalQuality?.outcome === "needs_review") &&
      fs.existsSync(videoPath)
    ) {
      return "needs_review";
    }
    if (sidecar?.status === "failed") {
      return "failed";
    }
    if (fs.existsSync(videoPath)) {
      return "ready";
    }
    return "failed";
  }

  public addToQueue(
    sceneInput: SceneInputWithFallback[],
    config: RenderConfig,
    businessTemplateId?: string,
    businessTemplateData?: Record<string, string>,
  ): string {
    const id = cuid();
    let spec: ProductionSpec;
    if (businessTemplateId) {
      spec = convertTemplateToProductionSpec({
        templateId: businessTemplateId as BusinessTemplateId,
        templateData: businessTemplateData,
        config,
        id,
      });
    } else {
      spec = this.legacyInputToSpec(id, sceneInput, config);
    }

    this.queue.push({ spec, id });
    if (this.queue.length === 1) {
      this.processQueue();
    }
    return id;
  }

  public async createShortNow(
    videoId: string,
    input: any,
    onProgress?: RenderProgressCallback,
  ): Promise<string> {
    const spec = this.resolveInputToSpec(videoId, input);
    return this.renderProductionSpec(videoId, spec, onProgress);
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    const { spec, id } = this.queue[0];
    logger.debug({ id, title: spec.title }, "Processing video item in the queue");
    try {
      await this.renderProductionSpec(id, spec);
      logger.debug({ id }, "Video created successfully");
    } catch (error: unknown) {
      logger.error(error, "Error creating video");
      try {
        this.saveFailureMetadata(id, spec, error);
      } catch (metaErr) {
        logger.error(metaErr, "Error saving failure metadata");
      }
    } finally {
      this.queue.shift();
      this.processQueue();
    }
  }

  private resolveInputToSpec(videoId: string, input: any): ProductionSpec {
    if (input && input.scenes && input.scenes.length > 0 && typeof input.scenes[0].narration === "string") {
      return validateProductionSpec({ ...input, id: videoId });
    }
    if (input && input.productionSpec) {
      return validateProductionSpec({ ...input.productionSpec, id: videoId });
    }
    if (input && input.businessTemplateId) {
      return convertTemplateToProductionSpec({
        templateId: input.businessTemplateId as BusinessTemplateId,
        templateData: input.businessTemplateData,
        config: input.config,
        title: input.title,
        id: videoId,
      });
    }
    if (input && input.scenes && input.scenes.length > 0 && typeof input.scenes[0].text === "string") {
      return this.legacyInputToSpec(videoId, input.scenes, input.config || {});
    }
    throw new Error("Invalid video render input. Could not resolve ProductionSpec.");
  }

  private legacyInputToSpec(
    videoId: string,
    scenes: SceneInputWithFallback[],
    config: RenderConfig,
  ): ProductionSpec {
    const brandKit = config.brandKit;
    const productionScenes: ProductionSceneSpec[] = scenes.map((s, idx) => ({
      sceneIndex: idx,
      purpose: idx === 0 ? "hook" : idx === scenes.length - 1 ? "cta" : "solution",
      durationSeconds: 6,
      narration: s.text,
      stockSearchTerms: s.searchTerms && s.searchTerms.length > 0 ? s.searchTerms : ["video"],
      visualSource: "stock",
      visualProvider: "pexels",
      transition: "cut",
    }));

    return validateProductionSpec({
      id: videoId,
      creationMode: "template",
      title: brandKit?.brandName || "Video Production",
      language: "auto",
      dialect: "none",
      tone: "energetic",
      contentStyle: "advertisement",
      durationSeconds: scenes.length * 6,
      aspectRatio: config.orientation === OrientationEnum.landscape ? "16:9" : "9:16",
      resolution: "1080p",
      quality: "standard",
      sceneCount: productionScenes.length,
      visualMode: "stock",
      voiceProvider: "kokoro",
      voiceId: config.voice || "af_heart",
      captionStyle: brandKit?.captionStyle || "bold",
      scenes: productionScenes,
      brandKit,
    });
  }

  private async renderProductionSpec(
    videoId: string,
    spec: ProductionSpec,
    onProgress?: RenderProgressCallback,
  ): Promise<string> {
    await assertStorageReady(this.config);
    const totalStartedAt = Date.now();
    const planningStartedAt = Date.now();
    const timeline: ResolvedProductionTimeline = resolveProductionTimeline(spec, 25);
    const mediaPlan = mediaIntelligenceService.generateMediaPlan(spec, {
      pacingProfile: (spec.metadata?.pacing as any) || (spec.quality === "high" || spec.quality === "premium" || spec.quality === "max_quality_local" ? "fast" : undefined),
      captionPreset: (spec.captionStyle as any) || "bold",
    });
    const sceneSourceDecisions = sceneSourceRouter.routeSpec(spec);
    const postProductionProcessors = postProductionPipeline.listProcessors();

    logger.info(
      {
        videoId,
        title: spec.title,
        requestedDuration: timeline.requestedDurationSeconds,
        targetDuration: timeline.targetDurationSeconds,
        contentDuration: timeline.contentDurationSeconds,
        outroDuration: timeline.outroDurationSeconds,
        expectedDuration: timeline.finalExpectedDurationSeconds,
        sceneCount: timeline.scenes.length,
        pacingProfile: mediaPlan.pacingProfile,
        mode: spec.creationMode,
      },
      "Rendering Production Spec video with Media Intelligence & Resolved Timeline",
    );

    // Music and its beat map are resolved before the scene loop so the shot
    // planner can use beats as cutting hints. Neither depends on scene work.
    const selectedMusic = this.findMusic(
      timeline.finalExpectedDurationSeconds,
      mediaPlan.recommendedMusicMood as any,
    );
    let beatMap: any = null;
    if (capabilityManager.isPythonQualityVenvInstalled() && selectedMusic?.file) {
      try {
        const musicPath = path.join(this.config.musicDirPath, selectedMusic.file);
        if (fs.existsSync(musicPath) && fs.statSync(musicPath).size > 1024) {
          beatMap = await qualityEngine.analyzeBeats(musicPath);
        }
      } catch (beatErr) {
        logger.warn(beatErr, "Beat analysis notice; proceeding with standard timeline");
      }
    }
    // qualityEngine returns beatTimestamps; this previously read beatMap.beats,
    // which never existed, so every production reported beatMapUsed:false and
    // no cut was ever beat-aware even with librosa installed and working.
    const beatTimestamps: number[] = Array.isArray(beatMap?.beatTimestamps)
      ? (beatMap.beatTimestamps as number[])
      : Array.isArray((beatMap as any)?.beats)
        ? ((beatMap as any).beats as number[])
        : [];

    // ------------------------------------------------------------------
    // CREATIVE PLAN
    // One resolved description of creative intent for the whole production,
    // built before any scene work so every shot decision can be traced back to
    // it. Availability is reported honestly: a treatment whose runtime is not
    // configured is never planned, it falls back and records why.
    // ------------------------------------------------------------------
    // V2.5.1: the customer's own Media Library selection, resolved into a real
    // per-scene assignment. Before this, `metadata.selectedMediaIds` was
    // written by Create Video and read by nothing - "My Media" changed the form
    // and not the video. See media/customerMediaPlanner.ts.
    const customerMediaPlan = await this.planCustomerMediaForSpec(spec);
    if (customerMediaPlan.blockedReason === "no_usable_customer_media") {
      throw new Error(
        "This production was set to use only your own media, but none of the selected items can be used in a video. Choose usable media or switch the visual source.",
      );
    }
    const customerMediaByScene = new Map(
      customerMediaPlan.assignments.map((item) => [item.sceneIndex, item]),
    );
    if (customerMediaPlan.assignments.length > 0) {
      logger.info(
        {
          mode: customerMediaPlan.mode,
          assigned: customerMediaPlan.assignments.length,
          stockProvidersBlocked: customerMediaPlan.stockProvidersBlocked,
          unusable: customerMediaPlan.unusableIds,
        },
        "Customer media plan resolved",
      );
    }

    const hasUploadedMediaForProduction = Boolean(
      (spec.metadata as any)?.uploadedMediaId ||
      customerMediaPlan.assignments.length > 0 ||
      spec.scenes.some((scene: any) => scene.uploadedMediaId || scene.visualProvider === "uploaded_media"),
    );
    const hasProductMediaForProduction = Boolean(
      (spec.metadata as any)?.productImageId || spec.productionMode === "product_ad",
    );
    const motionRuntimeAvailable = capabilityManager.isPythonQualityVenvInstalled();
    const pexelsVaultKey = await providerSecrets.refresh("pexels", "api_key").catch(() => undefined);
    const pixabayVaultKey = await providerSecrets.refresh("pixabay", "api_key").catch(() => undefined);
    const stockRuntimeAvailable = Boolean(
      this.config.pexelsApiKey ||
      process.env.PIXABAY_API_KEY ||
      pexelsVaultKey ||
      pixabayVaultKey ||
      providerSecrets.peek("pexels", "api_key") ||
      providerSecrets.peek("pixabay", "api_key"),
    );

    // An explicitly graphic production must not depend on stock footage: asking
    // for Motion Graphics and receiving four stock clips is not the mode the
    // customer chose. Auto Hybrid keeps every source available.
    const graphicOnlyMode =
      spec.productionMode === "motion_graphics" || spec.productionMode === "animated_explainer";
    const requestedVisualSource = String(
      (spec.metadata as any)?.uiContract?.visualSource ||
      (spec as any).visualSource ||
      "",
    );
    const forceStockFootage =
      spec.visualMode === "stock" ||
      requestedVisualSource === "stock" ||
      requestedVisualSource === "auto_free";

    // V2.4 Pass 4 true-visual-bed invariant - see buildTreatmentAvailabilityPredicate
    // for why this must not simply key off `motionRuntimeAvailable`.
    const isTreatmentAvailable = buildTreatmentAvailabilityPredicate({
      graphicOnlyMode,
      forceStockFootage,
      motionRuntimeAvailable,
      stockRuntimeAvailable,
      hasUploadedMedia: hasUploadedMediaForProduction,
      hasProductMedia: hasProductMediaForProduction,
    });

    const creativePlan: CreativePlan = buildCreativePlan({
      productionMode: spec.productionMode,
      stylePreset: ((spec as any).creativeStyle as CreativeStylePresetId) || undefined,
      motionIntensity: ((spec as any).animationIntensity as any) || undefined,
      scenes: spec.scenes.map((scene: any, sceneIdx: number) => ({
        sceneIndex: sceneIdx,
        narration: String(scene.narration || ""),
        purpose: scene.purpose,
        durationSeconds: Number(scene.durationSeconds) || 0,
      })),
      hasProductMedia: hasProductMediaForProduction,
      hasUploadedMedia: hasUploadedMediaForProduction,
      hasBrandProfile: Boolean(spec.brandKit?.brandName),
      isTreatmentAvailable,
    });
    logger.info(
      { facts: creativePlanFacts(creativePlan), preset: creativePlan.stylePreset },
      "Creative plan resolved",
    );

    // Brand system for every generated graphic in this production. Fields the
    // customer did not supply are reported as derived or default rather than
    // presented as their choice, and every text/surface pairing is contrast
    // checked before a template can draw with it.
    const brandStyle = resolveBrandStyle({
      brandKit: spec.brandKit,
      ctaText: spec.cta?.text,
      contactText: spec.contact,
      presence: creativePlan.brandPresence,
    });
    logger.info(
      {
        hasBrand: brandStyle.hasBrand,
        sources: brandStyle.sources,
        contrastCorrections: brandStyle.contrastCorrections,
      },
      "Brand style resolved for generated graphics",
    );
    const motionBrandFields = {
      brandName: brandStyle.sources.brandName === "customer" ? brandStyle.brandName : undefined,
      website: brandStyle.sources.website === "customer" ? brandStyle.website : undefined,
      socialHandle:
        brandStyle.sources.socialHandle === "customer" ? brandStyle.socialHandle : undefined,
    };
    const motionPalette = {
      primary: brandStyle.palette.primary,
      secondary: brandStyle.palette.secondary,
      accent: brandStyle.palette.accent,
      background: brandStyle.palette.background,
      surface: brandStyle.palette.surface,
      text: brandStyle.palette.text,
      textMuted: brandStyle.palette.textMuted,
      onPrimary: brandStyle.palette.onPrimary,
      onAccent: brandStyle.palette.onAccent,
    };

    /**
     * True when the production is advertising websites or web design. Only then
     * does a programmatic site mockup beat real footage; a generic coding clip
     * is not what "modern website" means.
     */
    const websiteAdContext = (() => {
      const haystack = [
        spec.title,
        spec.userPrompt,
        ...(spec.scenes || []).map((scene: any) => scene.narration),
        ...(spec.scenes || []).flatMap((scene: any) => scene.stockSearchTerms || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return /website|web design|webdesign|landing page|موقع|مواقع|ويب/.test(haystack);
    })();

    // libass owns spoken captions whenever the bundled font pack is present.
    // Without it we keep the Remotion caption layer rather than shipping a
    // video with no captions at all. Decided before the scene loop because
    // scene assembly must know which engine will draw the words.
    const captionStyleSpec = resolveCaptionStyle(spec.captionStyle as string);
    const bundledFontsDir = "/usr/share/fonts/truetype/abud";
    const fontsDir = process.env.ABUD_FONT_DIR || (fs.existsSync(bundledFontsDir) ? bundledFontsDir : "");
    const burnCaptionsWithLibass =
      Boolean(fontsDir) && fs.existsSync(fontsDir) && spec.captionStyle !== "none";

    const scenes: any[] = [];
    /** Caption words per scene, kept out of the Remotion payload when libass draws them. */
    const sceneCaptionWords: Array<Array<{ text: string; startMs: number; endMs: number }>> = [];
    const excludeVideoIds: (string | number)[] = [];
    const previousVisualCandidates: any[] = [];
    const tempFiles: string[] = [];
    // V2.4 Pass 5 wall-clock accounting (section 12): fine-grained timings
    // the coarse per-stage `emitProgress` buckets could not see, e.g. the
    // "media" stage swinging 6.8s-50.1s across otherwise-similar benchmarks
    // in Pass 4 with no visibility into why. Populated by AutoVisualRouter's
    // optional `onPerf` callback; purely additive instrumentation.
    const perfAccumulatorMs: Record<string, number> = {};
    const perfCounts: Record<string, number> = {};
    const onVisualPerf = (event: { stage: string; ms: number }) => {
      perfAccumulatorMs[event.stage] = (perfAccumulatorMs[event.stage] || 0) + event.ms;
      perfCounts[event.stage] = (perfCounts[event.stage] || 0) + 1;
    };
    const visualProvidersUsed = new Set<string>();
    const voiceProvidersUsed = new Set<string>();
    const captionTimingSources = new Set<string>();
    const plannedShots: VisualShot[] = [];
    const visualIntentPolicyLog: Array<Record<string, unknown>> = [];
    /** Which query families were asked for each scene, and what came back. */
    const stockQueryLog: Array<Record<string, unknown>> = [];
    const shotSourceCounts: Record<string, number> = {};
    const voiceArtifacts: any[] = [];
    // Single-speaker guarantee: the first synthesized scene pins the concrete
    // voice ID (ElevenLabs resolves account voices at generation time) and every
    // later scene - including narration-fitting retries - reuses exactly it.
    let pinnedVoiceId: string | undefined;
    const selectedVisuals: any[] = [];
    const sceneQa: any[] = [];
    const durableArtifacts: DurableSceneArtifact[] = [];
    const artifactReuse = {
      reusedArtifacts: [] as DurableSceneArtifact[],
      regeneratedArtifacts: [] as DurableSceneArtifact[],
      providerInvocations: { piper: 0, kokoro: 0, google_cloud_tts: 0, elevenlabs: 0, whisper: 0, pexels: 0 },
    };
    const artifactStore = new DurableArtifactStore(this.config);
    const revision = (spec.metadata?.revision || {}) as any;
    const reusableMediaAssets = Array.isArray(revision.reuseMediaAssets) ? revision.reuseMediaAssets : [];
    const revisionReuseArtifacts = Array.isArray(revision.reuseArtifacts)
      ? revision.reuseArtifacts as DurableSceneArtifact[]
      : [];
    const reusableArtifacts = filterReusableArtifacts({
      artifacts: revisionReuseArtifacts,
    });
    const explicitRetryArtifactFor = (
      type: DurableSceneArtifact["type"],
      sceneIndex: number,
    ) =>
      String(revision.type || "") === "retry"
        ? revisionReuseArtifacts.find((artifact) =>
          artifact.type === type &&
          artifact.sceneIndex === sceneIndex,
        )
        : undefined;
    const reusableArtifactFor = (
      type: DurableSceneArtifact["type"],
      sceneIndex: number,
      predicate?: (artifact: DurableSceneArtifact) => boolean,
    ) =>
      reusableArtifacts.find((artifact) =>
        artifact.type === type &&
        artifact.sceneIndex === sceneIndex &&
        artifact.valid === true &&
        (!predicate || predicate(artifact)),
      );

    const orientation: OrientationEnum =
      spec.aspectRatio === "16:9" ? OrientationEnum.landscape : OrientationEnum.portrait;

    await this.emitProgress(onProgress, {
      status: "generating_content",
      progress: 10,
      currentStage: "Generating content",
      message: "Media Intelligence plan, pacing profile, and canonical timeline are resolved.",
      stageKey: "planning",
      checkpointStatus: "completed",
      provider: String(spec.metadata?.planner || "local_ai"),
      artifacts: { mediaPlanId: mediaPlan.id, sceneCount: mediaPlan.scenes.length },
      inputHashSource: spec,
      timingMs: Date.now() - planningStartedAt,
    });

    // Continuous-narration wrapping (V2.3-03) sizes each scene to its spoken
    // audio so there is no dead air between scenes. That only holds the total
    // duration when the narration actually fills the requested budget, so the
    // per-scene narration is now fitted to (not shrunk below) the resolved
    // scene budget, a scene whose spoken audio still lands short is gently
    // slowed rather than left with a silent gap, and a bounded visual hold
    // keeps the video from collapsing far below the request.
    let renderedContentSeconds = 0;

    let index = 0;
    for (const sceneTimeline of timeline.scenes) {
      const originalSceneSpec = spec.scenes[sceneTimeline.sceneIndex] || {
        ...sceneTimeline,
        stockSearchTerms: ["video"],
        visualSource: "stock",
      };

      const sceneMediaPlan = mediaPlan.scenes[index] || {
        sceneIndex: index,
        purpose: originalSceneSpec.purpose,
        visualIntent: "lifestyle",
        targetDurationSeconds: sceneTimeline.durationSeconds,
        segments: [],
        preferredVisualSource: originalSceneSpec.visualSource || "stock",
        motion: "slow_zoom",
        transitionToNext: "cut",
        needsTextOverlay: false,
        searchTerms: originalSceneSpec.stockSearchTerms || ["video"],
      };

      // The creative plan already decided how this scene is shown. When it
      // resolved the scene to a motion treatment - which is what happens for
      // every scene once no stock provider is configured - the renderer has to
      // follow that decision. Before v2.3.1 only an explicitly graphic
      // production took the motion path here, so an Auto production with no
      // Pexels key still tried to pull stock footage and failed the whole job.
      const plannedSceneTreatment = creativePlan.sceneTreatments.find(
        (entry) => entry.sceneIndex === index,
      );
      // A scene the customer assigned their own media to is shown with that
      // media. Rendering a generated motion card over an asset the customer
      // deliberately picked is the substitution "My Media" exists to prevent.
      const sceneResolvedToMotion =
        !customerMediaByScene.has(index) &&
        sceneRendersAsMotion({
          productionMode: spec.productionMode,
          visualMode: spec.visualMode,
          sceneVisualSource: (originalSceneSpec as any).visualSource,
          plannedTreatmentRuntime: plannedSceneTreatment?.runtime,
        });

      const sceneProgressBase = 15 + Math.round((index / timeline.scenes.length) * 55);

      const voiceStartedAt = Date.now();
      await this.emitProgress(onProgress, {
        status: "generating_voice",
        progress: sceneProgressBase,
        currentStage: "Generating voice",
        message: `Generating narration audio for scene ${index + 1}/${timeline.scenes.length}.`,
        stageKey: "voice",
        checkpointStatus: "running",
        inputHashSource: { sceneIndex: index, narration: sceneTimeline.narration, voiceProvider: spec.voiceProvider },
      });

      const brandVoiceProfile = spec.brandKit?.voiceProfile as any;
      const jobPronunciationOverrides =
        (spec as any).pronunciationOverrides ||
        (spec as any).metadata?.pronunciationOverrides ||
        (spec as any).pronunciations ||
        undefined;
      const requestedSpokenNarration = String((originalSceneSpec as any).spokenNarration || originalSceneSpec.narration || sceneTimeline.narration);
      let targetSceneDuration = sceneTimeline.durationSeconds;
      const requestedVoiceQuality = this.mapVoiceQuality(spec.quality);
      const requestedVoiceProvider = ((brandVoiceProfile?.provider || spec.voiceProvider || "auto") as VoiceProviderId | "auto");
      const requestedVoiceId = pinnedVoiceId || brandVoiceProfile?.voiceId || spec.voiceId || undefined;
      // The preset is the delivery setting a human approved in the Voice Lab.
      // It travels on the spec so every scene narrates identically and a retry
      // cannot quietly drop back to the provider's "natural" default.
      const requestedVoicePreset = spec.voicePreset || undefined;
      const requestedVoiceModelId = spec.voiceModelId || undefined;
      const requestedDialect = (brandVoiceProfile?.dialect || spec.dialect) as string | undefined;
      const retryReuseSpokenNarration =
        spec.language === "ar"
          ? preprocessArabicSpeech(requestedSpokenNarration, {
            dialect: requestedDialect as any,
            pronunciationOverrides: jobPronunciationOverrides,
            brandPronunciations: brandVoiceProfile?.pronunciationDictionary,
          }).ttsNormalizedText
          : requestedSpokenNarration.trim();
      const canonicalSpokenContentFingerprint = retryContentFingerprint({
        text: retryReuseSpokenNarration,
        language: spec.language,
        dialect: requestedDialect,
      });
      const displayContentFingerprint = retryContentFingerprint({
        text: String(originalSceneSpec.narration || ""),
        language: spec.language,
        dialect: requestedDialect,
      });

      const tempId = cuid();
      const tempWavFileName = `${tempId}.wav`;
      const tempMasteredWavFileName = `${tempId}.mastered.wav`;
      const tempMp3FileName = `${tempId}.mp3`;
      const tempWavPath = path.join(this.config.tempDirPath, tempWavFileName);
      const tempMasteredWavPath = path.join(this.config.tempDirPath, tempMasteredWavFileName);
      const tempMp3Path = path.join(this.config.tempDirPath, tempMp3FileName);
      tempFiles.push(tempWavPath, tempMasteredWavPath, tempMp3Path);

      let voiceAudio: any = null;
      let voiceMastering: any = null;
      let speedFactor = 1.0;
      let actualVoiceDuration = targetSceneDuration;
      let captionAudioPath = tempMasteredWavPath;
      let voiceArtifact: DurableSceneArtifact | undefined;
      const revisionType = String(revision.type || "");
      const upstreamVoiceIsExplicitlyReusable = ["media", "caption", "display_text", "music"].includes(revisionType);
      const explicitRetryVoice = explicitRetryArtifactFor("voice", index);
      const reusableVoice = explicitRetryVoice || reusableArtifactFor("voice", index, (artifact) => {
        if (upstreamVoiceIsExplicitlyReusable) return true;
        const key = (artifact.metadata?.reuseKey || {}) as Record<string, unknown>;
        const artifactProvider = artifact.provider || key.provider;
        const providerCompatible = requestedVoiceProvider === "auto" ||
          artifactProvider === requestedVoiceProvider ||
          (spec.language === "ar" && requestedVoiceProvider === "kokoro" && artifactProvider === "piper");
        return (
          key.spokenNarration === requestedSpokenNarration &&
          key.language === spec.language &&
          key.dialect === (brandVoiceProfile?.dialect || spec.dialect) &&
          key.qualityProfile === requestedVoiceQuality &&
          (!requestedVoiceId || key.voiceId === requestedVoiceId) &&
          (key.voicePreset || undefined) === requestedVoicePreset &&
          providerCompatible
        );
      });

      if (explicitRetryVoice) {
        const validation = validateExplicitRetryReuseArtifact({
          artifact: explicitRetryVoice,
          expectedType: "voice",
          expectedSceneIndex: index,
          expectedProvider: requestedVoiceProvider,
          expectedModel: requestedVoiceModelId,
          expectedVoiceId: requestedVoiceId,
          canonicalSpokenContentFingerprint,
          displayContentFingerprint,
        });
        if (!validation.valid) {
          failExplicitRetryReuse(explicitRetryVoice, "voice", index, validation.reason || "invalid retry voice artifact");
        }
      }

      if (reusableVoice) {
        try {
          artifactStore.copyToTemp(reusableVoice, tempMp3Path);
        } catch (error: any) {
          if (explicitRetryVoice) {
            failExplicitRetryReuse(
              explicitRetryVoice,
              "voice",
              index,
              error?.message || "retry voice artifact could not be copied",
            );
          }
          throw error;
        }
        actualVoiceDuration = reusableVoice.duration || await this.ffmpeg.getMediaDuration(tempMp3Path);
        captionAudioPath = tempMp3Path;
        voiceArtifact = reusableVoice;
        artifactReuse.reusedArtifacts.push(reusableVoice);
        voiceProvidersUsed.add(String(reusableVoice.provider || "reused"));
        const priorVoice = (reusableVoice.metadata?.voiceArtifact || {}) as Record<string, unknown>;
        voiceArtifacts.push({
          ...priorVoice,
          sceneIndex: index,
          artifactId: reusableVoice.artifactId,
          reused: true,
          reuseSourceJobId: reusableVoice.sourceJobId,
          reuseSourceRevisionId: reusableVoice.sourceRevisionId,
        });
      } else {
        voiceAudio = await this.voiceRegistry.synthesize({
          text: requestedSpokenNarration,
          language: spec.language,
          dialect: (brandVoiceProfile?.dialect || spec.dialect) as any,
          qualityProfile: requestedVoiceQuality,
          requestedProvider: requestedVoiceProvider,
          voiceId: requestedVoiceId,
          voicePreset: requestedVoicePreset,
          modelId: requestedVoiceModelId,
          // Arabic ElevenLabs production defaults to Plain TTS + local Whisper timing for stability and single-call guarantee.
          // Non-Arabic or explicit timestamp routes retain native alignment.
          requestAlignment: spec.language === "ar" ? false : true,
          voiceStrategy: spec.language === "ar" ? "plain_tts" : "timestamps",
          fallbackPolicy: "local",
          brandPronunciations: brandVoiceProfile?.pronunciationDictionary,
          pronunciationOverrides: jobPronunciationOverrides,
        });
        pinnedVoiceId = voiceAudio.voiceId || voiceAudio.decision.voiceId || pinnedVoiceId;
        const firstProvider = voiceAudio.provider || voiceAudio.decision.providerId;
        if (firstProvider in artifactReuse.providerInvocations) {
          artifactReuse.providerInvocations[firstProvider as keyof typeof artifactReuse.providerInvocations]++;
        }

        let normalized = await this.ffmpeg.saveNormalizedAudioWithSpeed(
          voiceAudio.audio,
          tempWavPath,
          1,
        );
        let measuredVoiceDuration = normalized.duration || voiceAudio.audioLength || targetSceneDuration;

        if (measuredVoiceDuration > targetSceneDuration * 1.2) {
          // Only rewrite when the narration clearly overflows, and fit it to the
          // whole scene budget rather than a shrunken fraction of it - the old
          // 0.88 target plus a tight trigger cut ~15-word lines to ~8 words,
          // which the local voice then rushed through, collapsing the timeline.
          const compactedText = compactNarrationToBudget(
            voiceAudio.processedText || requestedSpokenNarration,
            Math.max(2, targetSceneDuration),
            spec.language === "ar",
          );
          if (compactedText && compactedText !== (voiceAudio.processedText || requestedSpokenNarration)) {
            voiceAudio = await this.voiceRegistry.synthesize({
              text: compactedText,
              language: spec.language,
              dialect: (brandVoiceProfile?.dialect || spec.dialect) as any,
              qualityProfile: requestedVoiceQuality,
              requestedProvider: requestedVoiceProvider,
              // Retries must never change the speaker or the delivery settings.
              voiceId: pinnedVoiceId || requestedVoiceId,
              voicePreset: requestedVoicePreset,
              modelId: requestedVoiceModelId,
              requestAlignment: spec.language === "ar" ? false : true,
              voiceStrategy: spec.language === "ar" ? "plain_tts" : "timestamps",
              fallbackPolicy: "local",
              brandPronunciations: brandVoiceProfile?.pronunciationDictionary,
              pronunciationOverrides: jobPronunciationOverrides,
            });
            const retryProvider = voiceAudio.provider || voiceAudio.decision.providerId;
            if (retryProvider in artifactReuse.providerInvocations) {
              artifactReuse.providerInvocations[retryProvider as keyof typeof artifactReuse.providerInvocations]++;
            }
            normalized = await this.ffmpeg.saveNormalizedAudioWithSpeed(
              voiceAudio.audio,
              tempWavPath,
              1,
            );
            measuredVoiceDuration = normalized.duration || voiceAudio.audioLength || measuredVoiceDuration;
          }
        }

        // Keep any final tempo correction small; rewriting narration is the main fitting strategy.
        if (measuredVoiceDuration > targetSceneDuration * 1.08) {
          speedFactor = Math.min(1.08, measuredVoiceDuration / targetSceneDuration);
          normalized = await this.ffmpeg.saveNormalizedAudioWithSpeed(
            voiceAudio.audio,
            tempWavPath,
            speedFactor,
          );
          measuredVoiceDuration = normalized.duration || measuredVoiceDuration;
        } else if (measuredVoiceDuration > 0 && measuredVoiceDuration < targetSceneDuration * 0.85) {
          // Narration landed short of the scene budget (a terse generated script,
          // or the fast local voice). Slow it toward the budget - bounded to
          // 0.82x so it still sounds natural - so speech fills the scene instead
          // of leaving a silent gap the dead-air analyzer would flag.
          speedFactor = Math.max(0.82, measuredVoiceDuration / (targetSceneDuration * 0.96));
          normalized = await this.ffmpeg.saveNormalizedAudioWithSpeed(
            voiceAudio.audio,
            tempWavPath,
            speedFactor,
          );
          measuredVoiceDuration = normalized.duration || measuredVoiceDuration;
        }

        voiceMastering = await this.audioMastering.masterVoice(tempWavPath, tempMasteredWavPath);
        await this.ffmpeg.saveWavToMp3(tempMasteredWavPath, tempMp3Path);
        actualVoiceDuration = await this.ffmpeg.getMediaDuration(tempMasteredWavPath);
        captionAudioPath = tempMasteredWavPath;

        // Second-chance slowdown using the POST-mastering measurement (Kokoro
        // duration closure pass). The speed-adjust above only ever saw the
        // PRE-mastering duration, so a scene that looked close enough to
        // target before mastering (no slowdown applied) can still land short
        // once mastering's own real leading/trailing-silence trim removes
        // more than expected. Re-checking here catches that class of small
        // shortfall with the SAME safe, already-natural-sounding 0.82x-floor
        // mechanism, before ever falling through to content expansion below -
        // adding a whole extra sentence to close what is often just a 5-15%
        // gap was overshooting badly (proven: a 5.94s-target scene's required
        // text measured 4.77s post-mastering; one added sentence overshot to
        // 10.37s, worse than the original shortfall in the other direction).
        if (actualVoiceDuration > 0 && actualVoiceDuration < targetSceneDuration * 0.85) {
          const strongerSpeedFactor = Math.max(0.82, actualVoiceDuration / (targetSceneDuration * 0.96));
          if (strongerSpeedFactor < 1 && strongerSpeedFactor < speedFactor) {
            const reSlowed = await this.ffmpeg.saveNormalizedAudioWithSpeed(
              voiceAudio.audio,
              tempWavPath,
              strongerSpeedFactor,
            );
            speedFactor = strongerSpeedFactor;
            voiceMastering = await this.audioMastering.masterVoice(tempWavPath, tempMasteredWavPath);
            await this.ffmpeg.saveWavToMp3(tempMasteredWavPath, tempMp3Path);
            actualVoiceDuration = await this.ffmpeg.getMediaDuration(tempMasteredWavPath);
            captionAudioPath = tempMasteredWavPath;
          }
        }

        // Bounded, SYMMETRIC post-TTS duration correction (ABUD_SHORTS_ENGINE_
        // STATUS.md sections 7 and the Short Studio 2.5 Arabic duration-defect
        // closure pass). The speed-stretch above is deliberately capped at
        // 0.82x to avoid unnatural-sounding audio, so it cannot close a large
        // gap on its own. When this scene came from a duration-aware content
        // generator that offered real, grounded expansion sentences
        // (narrationExpansionUnits), decideCorrectionAction (already written
        // and tested in scriptDurationController.ts, but never called from
        // here until this pass - the actual root cause of the 18s Arabic
        // overshoot) drives a bounded expand/condense loop off the REAL
        // measured audio duration each round: too_short -> append the next
        // unit and re-synthesize; too_long -> DROP the last-added unit and
        // re-synthesize (walk back the exact over-correction that previously
        // had no way to reverse); accept or give_up otherwise. Never by
        // padding/truncating audio, inventing silence, or cutting a sentence
        // mid-thought - only by choosing how many of the already-written,
        // real narration units to speak. Bounded to `maxRetries` correction
        // attempts total (never an unbounded loop). Other scenes' voice/
        // media/Whisper artifacts are untouched.
        const expansionUnits: string[] = Array.isArray((originalSceneSpec as any).narrationExpansionUnits)
          ? [...((originalSceneSpec as any).narrationExpansionUnits as string[])]
          : [];
        const durationUnits = [requestedSpokenNarration, ...expansionUnits];
        let unitsUsed = 1;
        let correctionRetries = 0;
        let expandedSpokenNarration = requestedSpokenNarration;
        let gaveUpReason: string | undefined;
        for (; ;) {
          const decision = decideCorrectionAction({
            actualSeconds: actualVoiceDuration,
            targetSeconds: targetSceneDuration,
            unitsUsed,
            unitsAvailable: durationUnits.length,
            retriesSoFar: correctionRetries,
            maxRetries: 2,
          });
          if (decision.action === "accept") break;
          if (decision.action === "give_up") {
            gaveUpReason = decision.reason;
            break;
          }
          unitsUsed = decision.action === "expand" ? unitsUsed + 1 : unitsUsed - 1;
          expandedSpokenNarration = durationUnits.slice(0, unitsUsed).join(" ").trim();
          voiceAudio = await this.voiceRegistry.synthesize({
            text: expandedSpokenNarration,
            language: spec.language,
            dialect: (brandVoiceProfile?.dialect || spec.dialect) as any,
            qualityProfile: requestedVoiceQuality,
            requestedProvider: requestedVoiceProvider,
            // Retries must never change the speaker or the delivery settings.
            voiceId: pinnedVoiceId || requestedVoiceId,
            voicePreset: requestedVoicePreset,
            modelId: requestedVoiceModelId,
            requestAlignment: spec.language === "ar" ? false : true,
            voiceStrategy: spec.language === "ar" ? "plain_tts" : "timestamps",
            fallbackPolicy: "local",
            brandPronunciations: brandVoiceProfile?.pronunciationDictionary,
            pronunciationOverrides: jobPronunciationOverrides,
          });
          const correctionProvider = voiceAudio.provider || voiceAudio.decision.providerId;
          if (correctionProvider in artifactReuse.providerInvocations) {
            artifactReuse.providerInvocations[correctionProvider as keyof typeof artifactReuse.providerInvocations]++;
          }
          let correctedNormalized = await this.ffmpeg.saveNormalizedAudioWithSpeed(voiceAudio.audio, tempWavPath, 1);
          let correctedDuration = correctedNormalized.duration || voiceAudio.audioLength || actualVoiceDuration;
          if (correctedDuration > targetSceneDuration * 1.08) {
            speedFactor = Math.min(1.08, correctedDuration / targetSceneDuration);
            correctedNormalized = await this.ffmpeg.saveNormalizedAudioWithSpeed(voiceAudio.audio, tempWavPath, speedFactor);
            correctedDuration = correctedNormalized.duration || correctedDuration;
          } else {
            speedFactor = 1.0;
          }
          voiceMastering = await this.audioMastering.masterVoice(tempWavPath, tempMasteredWavPath);
          await this.ffmpeg.saveWavToMp3(tempMasteredWavPath, tempMp3Path);
          actualVoiceDuration = await this.ffmpeg.getMediaDuration(tempMasteredWavPath);
          captionAudioPath = tempMasteredWavPath;
          correctionRetries++;
          logger.info(
            {
              sceneIndex: index,
              action: decision.action,
              correctionRetries,
              actualVoiceDuration,
              targetSceneDuration,
              unitsUsed,
              unitsAvailable: durationUnits.length,
              expandedSpokenNarration,
              expandedSpokenNarrationChars: expandedSpokenNarration.length,
              preSpeedAdjustDuration: correctedNormalized.duration || voiceAudio.audioLength,
              speedFactor,
            },
            "Bounded duration correction: adjusted scene narration and re-synthesized",
          );
        }
        if (gaveUpReason) {
          logger.warn(
            { sceneIndex: index, targetSceneDuration, actualVoiceDuration, gaveUpReason },
            "Bounded duration correction gave up; scene duration may fall outside the accepted range",
          );
        }
        if (correctionRetries > 0) {
          // Keep captions and the displayed/canonical narration in sync with
          // what was actually spoken - otherwise captions would silently
          // truncate before the audio finishes, reintroducing a caption/audio
          // mismatch of the same class this migration exists to eliminate.
          sceneTimeline.narration = expandedSpokenNarration;
        }
      }

      // Canonical continuous narration timeline calculation:
      // Chain spoken scenes with bounded natural breath pauses (160ms) and
      // eliminate dead silence between scenes, while holding toward the resolved
      // scene budget so the video keeps the requested duration.
      const isLastScene = index === timeline.scenes.length - 1;
      const sceneSpeechDuration = actualVoiceDuration || sceneTimeline.durationSeconds;
      const calculatedVisualDuration = planSceneVisualDurationSeconds({
        speechSeconds: sceneSpeechDuration,
        resolvedSceneBudgetSeconds: sceneTimeline.durationSeconds || sceneSpeechDuration,
        isLastScene,
      });
      renderedContentSeconds += calculatedVisualDuration;
      targetSceneDuration = calculatedVisualDuration;
      sceneTimeline.actualSpeechDurationSeconds = sceneSpeechDuration;
      sceneTimeline.durationSeconds = calculatedVisualDuration;
      sceneTimeline.audioSpeedFactor = speedFactor;
      const speechWindowStartMs = 0;
      const speechWindowEndMs = Math.round(sceneSpeechDuration * 1000);

      if (!voiceArtifact && voiceAudio && voiceMastering) {
        voiceProvidersUsed.add(voiceAudio.provider || voiceAudio.decision.providerId);
        const resolvedVoiceStrategy = (voiceAudio.decision as any)?.voiceStrategy || (spec.language === "ar" ? "plain_tts" : undefined);
        const resolvedVoiceSynthesisStrategy = (voiceAudio.decision as any)?.voiceSynthesisStrategy || (spec.language === "ar" ? "elevenlabs_plain_tts_whisper" : "elevenlabs_timestamps_native");
        const voiceInputHash = createVoiceInputHash({
          spokenNarration: requestedSpokenNarration,
          provider: voiceAudio.provider || voiceAudio.decision.providerId,
          model: voiceAudio.model,
          voiceId: voiceAudio.voiceId,
          voicePreset: requestedVoicePreset,
          language: voiceAudio.language,
          dialect: voiceAudio.dialect,
          qualityProfile: requestedVoiceQuality,
          pace: brandVoiceProfile?.pace,
          style: brandVoiceProfile?.style,
          voiceStrategy: resolvedVoiceStrategy,
        });
        const voiceArtifactDetails = {
          sceneIndex: index,
          provider: voiceAudio.provider || voiceAudio.decision.providerId,
          model: voiceAudio.model,
          voiceId: voiceAudio.voiceId,
          voiceFamily: voiceAudio.voiceFamily,
          language: voiceAudio.language,
          dialect: voiceAudio.dialect,
          estimatedCostTier: voiceAudio.estimatedCostTier || (voiceAudio.provider === "google_cloud_tts" ? "cloud_free_tier" : voiceAudio.provider === "elevenlabs" ? "premium" : "local_free"),
          usageBasedCost: Boolean(voiceAudio.usageBasedCost),
          charactersBilled: voiceAudio.charactersBilled,
          modelId: voiceAudio.modelId,
          voicePreset: requestedVoicePreset,
          voiceSettings: voiceAudio.voiceSettings,
          voiceStrategy: resolvedVoiceStrategy,
          voiceSynthesisStrategy: resolvedVoiceSynthesisStrategy,
          generationMs: voiceAudio.generationMs,
          sampleRate: voiceAudio.sampleRate,
          processedText: voiceAudio.processedText,
          textFingerprint: voiceAudio.textFingerprint,
          requestedSpokenNarration,
          displayText: (originalSceneSpec as any).displayText || originalSceneSpec.onScreenText,
          captionText: (originalSceneSpec as any).captionText || originalSceneSpec.narration,
          visualIntent: sceneMediaPlan.visualIntent,
          routingReason: voiceAudio.decision.reason,
          warnings: voiceAudio.decision.warnings,
          inputVoiceLufs: voiceMastering.inputMetrics.integratedLufs,
          masteredVoiceLufs: voiceMastering.masteredMetrics.integratedLufs,
          masteredTruePeakDbtp: voiceMastering.masteredMetrics.truePeakDbtp,
          masteringIssues: voiceMastering.issues,
          speechWindowMs: { startMs: speechWindowStartMs, endMs: speechWindowEndMs },
        };
        voiceArtifact = artifactStore.persistFile({
          type: "voice",
          sceneIndex: index,
          sourceJobId: videoId,
          sourceRevisionId: revision.revisionId,
          provider: voiceArtifactDetails.provider,
          model: voiceArtifactDetails.model,
          inputHash: voiceInputHash,
          sourcePath: tempMp3Path,
          extension: "mp3",
          duration: actualVoiceDuration,
          metadata: {
            voiceArtifact: voiceArtifactDetails,
            reuseKey: {
              spokenNarration: requestedSpokenNarration,
              voicePreset: requestedVoicePreset,
              provider: voiceArtifactDetails.provider,
              model: voiceArtifactDetails.model,
              voiceId: voiceArtifactDetails.voiceId,
              language: voiceArtifactDetails.language,
              dialect: voiceArtifactDetails.dialect,
              qualityProfile: requestedVoiceQuality,
              pace: brandVoiceProfile?.pace || "normal",
              style: brandVoiceProfile?.style || "default",
              preprocessingVersion: "arabic-preprocessor-v2",
              textFingerprint: voiceAudio.textFingerprint,
            },
          },
        });
        durableArtifacts.push(voiceArtifact);
        artifactReuse.regeneratedArtifacts.push(voiceArtifact);
        voiceArtifacts.push({ ...voiceArtifactDetails, artifactId: voiceArtifact.artifactId, reused: false });
      }
      await this.emitProgress(onProgress, {
        status: "generating_voice",
        progress: Math.min(sceneProgressBase + 6, 68),
        currentStage: reusableVoice ? "Voice reused" : "Voice generated",
        message: reusableVoice ? `Reused voice artifact for scene ${index + 1}.` : `Voice completed for scene ${index + 1}.`,
        stageKey: "voice",
        checkpointStatus: "completed",
        provider: String(voiceArtifact?.provider || voiceAudio?.provider || voiceAudio?.decision?.providerId || "reused"),
        artifacts: {
          sceneIndex: index,
          artifactId: voiceArtifact?.artifactId,
          reused: Boolean(reusableVoice),
          type: "voice",
          sourceRevisionId: voiceArtifact?.sourceRevisionId,
          provider: voiceArtifact?.provider || voiceAudio?.provider || voiceAudio?.decision?.providerId,
          model: voiceArtifact?.model || voiceAudio?.model,
          voiceId: voiceAudio?.voiceId || (voiceArtifact?.metadata?.reuseKey as any)?.voiceId,
          durationSeconds: actualVoiceDuration,
        },
        timingMs: Date.now() - voiceStartedAt,
      });

      const captionsStartedAt = Date.now();
      await this.emitProgress(onProgress, {
        status: "generating_captions",
        progress: Math.min(sceneProgressBase + 8, 70),
        currentStage: "Generating captions",
        message: `Generating Whisper captions for scene ${index + 1}.`,
        stageKey: "captions",
        checkpointStatus: "running",
        inputHashSource: { sceneIndex: index, audioDuration: actualVoiceDuration },
      });
      let rawCaptions: Caption[] = [];
      // Canonical vocabulary persisted as captionTimingSource.
      let timingSource: "elevenlabs_alignment" | "whisper" | "deterministic_fallback" = "deterministic_fallback";
      let alignmentConfidence: number | undefined;
      let alignmentUnmapped: string[] | undefined;
      let captionScriptSimilarity: number | undefined;
      let captionArtifact: DurableSceneArtifact | undefined;
      const captionInputHash = createCaptionInputHash({
        voiceChecksum: voiceArtifact?.checksum || "",
        whisperModel: this.config.whisperModel,
        language: spec.language,
      });
      const explicitRetryCaption = explicitRetryArtifactFor("captions", index);
      const reusableCaption = explicitRetryCaption || reusableArtifactFor("captions", index, (artifact) =>
        artifact.inputHash === captionInputHash &&
        (artifact.metadata as any)?.voiceArtifactId === voiceArtifact?.artifactId,
      );
      if (explicitRetryCaption) {
        const validation = validateExplicitRetryReuseArtifact({
          artifact: explicitRetryCaption,
          expectedType: "captions",
          expectedSceneIndex: index,
          canonicalSpokenContentFingerprint,
          displayContentFingerprint,
        });
        if (!validation.valid) {
          failExplicitRetryReuse(explicitRetryCaption, "captions", index, validation.reason || "invalid retry caption artifact");
        }
        const captionVoiceArtifactId = String((explicitRetryCaption.metadata as any)?.voiceArtifactId || "");
        if (captionVoiceArtifactId && captionVoiceArtifactId !== voiceArtifact?.artifactId) {
          failExplicitRetryReuse(explicitRetryCaption, "captions", index, "caption voice artifact mismatch");
        }
        const captionVoiceChecksum = String((explicitRetryCaption.metadata as any)?.voiceChecksum || "");
        if (captionVoiceChecksum && captionVoiceChecksum !== voiceArtifact?.checksum) {
          failExplicitRetryReuse(explicitRetryCaption, "captions", index, "caption voice checksum mismatch");
        }
      }
      if (reusableCaption) {
        let payload: { captions: Caption[]; timingSource?: typeof timingSource };
        try {
          payload = artifactStore.readJsonArtifact<{ captions: Caption[]; timingSource?: typeof timingSource }>(reusableCaption);
        } catch (error: any) {
          if (explicitRetryCaption) {
            failExplicitRetryReuse(
              explicitRetryCaption,
              "captions",
              index,
              error?.message || "retry caption artifact could not be read",
            );
          }
          throw error;
        }
        rawCaptions = payload.captions || [];
        timingSource = payload.timingSource || "whisper";
        captionArtifact = reusableCaption;
        artifactReuse.reusedArtifacts.push(reusableCaption);
      }

      // 1. ElevenLabs native character alignment, mapped onto the DISPLAY
      //    caption tokens. The alignment describes the TTS string, which may
      //    contain pronunciation expansions the viewer must never see, so a
      //    segment whose mapping is not confident falls through to Whisper
      //    rather than showing a spoken form or a guessed time.
      if (!captionArtifact && voiceAudio?.characterAlignment && voiceAudio.alignmentText) {
        const displayText = String(
          (originalSceneSpec as any).captionText || sceneTimeline.narration || "",
        );
        const displayTokens = displayText.trim().split(/\s+/).filter(Boolean);
        const mapping = mapAlignmentToCaptionTokens(
          voiceAudio.characterAlignment,
          voiceAudio.alignmentText,
          displayTokens,
        );
        alignmentConfidence = mapping.confidence;
        alignmentUnmapped = mapping.unmappedTokens;
        if (isAlignmentConfident(mapping)) {
          rawCaptions = mapping.timings.map((timing) => ({
            text: timing.word,
            startMs: timing.startMs,
            endMs: timing.endMs,
          }));
          timingSource = "elevenlabs_alignment";
        } else {
          logger.info(
            { sceneIndex: index, confidence: mapping.confidence, unmapped: mapping.unmappedTokens },
            "ElevenLabs alignment mapping below confidence threshold; using Whisper for this scene",
          );
        }
      }

      // 2. Whisper: a TIMING/ALIGNMENT source only. Whisper transcribes the
      //    actual rendered audio, so its own words can mishear, drop, or add
      //    words relative to the canonical narration that was actually sent
      //    to TTS - that canonical text is what gets burned into the video,
      //    never Whisper's transcript. Whisper's timestamps are aligned onto
      //    the canonical words via the same LCS pairing already used for
      //    ElevenLabs alignment above (see whisperAlignment.ts). If Whisper's
      //    transcript diverges too far from the canonical text to trust its
      //    timing at all, this falls through to the deterministic fallback
      //    below rather than anchor known-correct words to an untrustworthy
      //    transcript.
      if (!captionArtifact && rawCaptions.length === 0) {
        const canonicalText = String((originalSceneSpec as any).captionText || sceneTimeline.narration || "");
        try {
          artifactReuse.providerInvocations.whisper++;
          const whisperCaptions = await this.whisper.CreateCaption(
            captionAudioPath,
            voiceAudio?.language || (voiceArtifact?.metadata?.reuseKey as any)?.language || spec.language,
          );
          if (whisperCaptions.length > 0 && canonicalText.trim()) {
            const aligned = alignWhisperToNarration(whisperCaptions, canonicalText);
            captionScriptSimilarity = aligned.scriptSimilarity;
            if (aligned.captions.length > 0 && aligned.scriptSimilarity >= WHISPER_SCRIPT_SIMILARITY_THRESHOLD) {
              rawCaptions = aligned.captions;
              alignmentConfidence = aligned.confidence;
              timingSource = "whisper";
            } else {
              logger.info(
                { sceneIndex: index, scriptSimilarity: aligned.scriptSimilarity },
                "Whisper transcript diverged too far from the canonical narration; using deterministic timing for this scene",
              );
            }
          }
        } catch (whisperErr) {
          logger.warn(whisperErr, `Whisper transcription notice for scene ${index + 1}; using deterministic word timestamps`);
        }
      }

      // 3. Deterministic fallback: the canonical narration, evenly
      //    distributed across the scene. Used whenever no timing source
      //    above is trustworthy - the canonical text is always what gets
      //    shown, never invented and never a mistranscription.
      //
      //    Distributed across the REAL measured audio duration
      //    (actualVoiceDuration), never the pre-correction planned
      //    targetSceneDuration: a scene whose narration was expanded/
      //    condensed above can end with real audio well outside its
      //    original target, and distributing word timing against the
      //    stale target then clamping each endMs to that same stale total
      //    produced inverted windows (startMs > endMs) for every word past
      //    the point where wIdx*wordMs first exceeds it - degenerate
      //    caption timing that fed corrupted phrase/highlight boundaries
      //    into the ASS builder (the real root cause isolated for the
      //    Short Studio 2.5 Arabic glyph-defect closure pass).
      if (!rawCaptions || rawCaptions.length === 0) {
        timingSource = "deterministic_fallback";
        const captionText = String((originalSceneSpec as any).captionText || sceneTimeline.narration || "");
        const words = captionText.trim().split(/\s+/).filter(Boolean);
        if (words.length > 0) {
          const totalMs = Math.round((actualVoiceDuration > 0 ? actualVoiceDuration : targetSceneDuration) * 1000);
          const wordMs = Math.max(1, Math.floor(totalMs / words.length));
          rawCaptions = words.map((w, wIdx) => {
            const startMs = wIdx * wordMs;
            const endMs = wIdx === words.length - 1 ? totalMs : startMs + wordMs;
            return {
              text: (wIdx > 0 ? " " : "") + w,
              startMs,
              endMs,
            };
          });
        }
      }
      voiceArtifacts[voiceArtifacts.length - 1].timingSource = timingSource;
      voiceArtifacts[voiceArtifacts.length - 1].captionTimingSource = timingSource;
      // Always canonical_narration: every path above (alignment, whisper,
      // deterministic fallback) burns the known narration script, never a
      // transcription - only the timing strategy differs.
      voiceArtifacts[voiceArtifacts.length - 1].captionTextSource = "canonical_narration";
      if (alignmentConfidence !== undefined) {
        voiceArtifacts[voiceArtifacts.length - 1].alignmentConfidence = alignmentConfidence;
        voiceArtifacts[voiceArtifacts.length - 1].captionAlignmentConfidence = alignmentConfidence;
        voiceArtifacts[voiceArtifacts.length - 1].alignmentUnmappedTokens = alignmentUnmapped;
      }
      if (captionScriptSimilarity !== undefined) {
        voiceArtifacts[voiceArtifacts.length - 1].captionScriptSimilarity = captionScriptSimilarity;
      }
      captionTimingSources.add(timingSource);

      // Fit the caption timeline inside the scene duration WITHOUT ever
      // dropping canonical words. Filtering out anything past the boundary
      // (the previous approach) silently truncated the visible sentence
      // whenever real timing (Whisper or alignment) ran a little long
      // relative to the scene's planned duration - proportionally
      // compressing the whole timeline keeps every word on screen instead.
      const maxSceneMs = Math.round(targetSceneDuration * 1000) + 100;
      const lastRawEndMs = rawCaptions.reduce((max, c) => Math.max(max, c.endMs), 0);
      const captionScale = lastRawEndMs > maxSceneMs ? maxSceneMs / lastRawEndMs : 1;
      const captions: Caption[] = rawCaptions.map((c) => {
        const startMs = Math.round(c.startMs * captionScale);
        return {
          ...c,
          startMs,
          endMs: Math.max(startMs, Math.round(c.endMs * captionScale)),
        };
      });
      if (!captionArtifact && voiceArtifact) {
        captionArtifact = artifactStore.persistJson({
          type: "captions",
          sceneIndex: index,
          sourceJobId: videoId,
          sourceRevisionId: revision.revisionId,
          provider: timingSource,
          model: timingSource === "whisper" ? this.config.whisperModel : timingSource,
          inputHash: captionInputHash,
          payload: {
            captions,
            timingSource,
            sceneIndex: index,
            voiceArtifactId: voiceArtifact.artifactId,
          },
          duration: targetSceneDuration,
          metadata: {
            voiceArtifactId: voiceArtifact.artifactId,
            voiceChecksum: voiceArtifact.checksum,
            timingConfig: "word-timings-v1",
          },
        });
        durableArtifacts.push(captionArtifact);
        artifactReuse.regeneratedArtifacts.push(captionArtifact);
      }
      await this.emitProgress(onProgress, {
        status: "generating_captions",
        progress: Math.min(sceneProgressBase + 12, 72),
        currentStage: reusableCaption ? "Captions reused" : "Captions generated",
        message: reusableCaption ? `Reused caption timing artifact for scene ${index + 1}.` : `Caption timing completed for scene ${index + 1}.`,
        stageKey: "captions",
        checkpointStatus: "completed",
        provider: timingSource,
        artifacts: {
          sceneIndex: index,
          artifactId: captionArtifact?.artifactId,
          reused: Boolean(reusableCaption),
          type: "captions",
          sourceRevisionId: captionArtifact?.sourceRevisionId,
          timingSource,
          captionCount: captions.length,
        },
        timingMs: Date.now() - captionsStartedAt,
      });

      const mediaStartedAt = Date.now();
      await this.emitProgress(onProgress, {
        status: "searching_assets",
        progress: Math.min(sceneProgressBase + 15, 75),
        currentStage: "Searching footage",
        message: `Resolving media asset(s) for scene ${index + 1} (${sceneMediaPlan.visualIntent || "stock"}).`,
        stageKey: "media",
        checkpointStatus: "running",
        inputHashSource: {
          sceneIndex: index,
          searchTerms: sceneMediaPlan.searchCandidates || sceneMediaPlan.searchTerms,
          visualIntent: sceneMediaPlan.visualIntent,
        },
      });

      // Handle multi-asset segment scenes if planned. A scene the plan resolved
      // to motion is rendered as a single generated clip and never enters the
      // stock-only segment path.
      if (!sceneResolvedToMotion && sceneMediaPlan.segments && sceneMediaPlan.segments.length > 1) {
        // Strict invariant: sum(segment durations) strictly equals targetSceneDuration
        const normalizedSegments = mediaIntelligenceService.normalizeSceneSegments(
          sceneMediaPlan.segments,
          targetSceneDuration,
        );
        const renderedSegments: { video: string; duration: number; motion?: string }[] = [];
        let segmentCursorSeconds = 0;

        for (const seg of normalizedSegments) {
          const segTempId = cuid();
          const segVideoFileName = `${segTempId}.mp4`;
          const segVideoPath = path.join(this.config.tempDirPath, segVideoFileName);
          tempFiles.push(segVideoPath);

          const reusableMediaArtifact = reusableArtifacts.find((artifact) =>
            artifact.type === "media" &&
            artifact.sceneIndex === index &&
            artifact.segmentIndex === seg.segmentIndex &&
            artifact.valid === true,
          );
          const reusedSeg = reusableMediaAssets.find((asset: any) => asset.sceneIndex === index && asset.segmentIndex === seg.segmentIndex);
          let segAsset: any = reusableMediaArtifact?.metadata?.visualAsset || reusedSeg;
          let mediaArtifact: DurableSceneArtifact | undefined = reusableMediaArtifact;
          if (reusableMediaArtifact) {
            artifactStore.copyToTemp(reusableMediaArtifact, segVideoPath);
            artifactReuse.reusedArtifacts.push(reusableMediaArtifact);
          } else {
            const segCustomerAssignment = customerMediaByScene.get(index);
            const segCustomerAsset = segCustomerAssignment
              ? await this.resolveCustomerSceneAsset(segCustomerAssignment, seg.durationSeconds, orientation)
              : null;
            if (!segCustomerAsset && customerMediaPlan.stockProvidersBlocked) {
              throw new Error(
                "This production was set to use only your own media, but a scene could not be prepared from the selected items.",
              );
            }
            if (reusedSeg || segCustomerAsset) {
              segAsset = reusedSeg || segCustomerAsset;
            } else {
              try {
                segAsset = await this.visualRouter.resolveSceneVisual(
                  {
                    ...originalSceneSpec,
                    stockSearchTerms: sceneMediaPlan.searchCandidates || seg.searchTerms,
                    visualPrompt: seg.visualPrompt || originalSceneSpec.visualPrompt,
                  } as any,
                  spec,
                  {
                    excludeIds: excludeVideoIds,
                    orientation,
                    tempDirPath: this.config.tempDirPath,
                    targetDurationSeconds: seg.durationSeconds,
                    previousCandidates: previousVisualCandidates,
                    onPerf: onVisualPerf,
                  },
                );
              } catch (segRejection) {
                if (!(segRejection instanceof StockVisualRejection)) throw segRejection;
                logger.info(
                  { sceneIndex: index, segmentIndex: seg.segmentIndex, reason: segRejection.details.reason },
                  "Stock could not honestly illustrate this segment; rendering a purposeful motion-graphics segment instead",
                );
                const segMotion = await motionEngine.renderMotionScene({
                  template: "kinetic_typography",
                  title: String(originalSceneSpec.onScreenText || sceneTimeline.narration || spec.title || ""),
                  subtitle: String((originalSceneSpec as any).displayText || ""),
                  durationSeconds: seg.durationSeconds,
                  width: orientation === "portrait" ? 1080 : 1920,
                  height: orientation === "portrait" ? 1920 : 1080,
                  fps: 25,
                  brandColors: motionPalette,
                  brand: motionBrandFields,
                  language: spec.language,
                });
                fs.copySync(segMotion.absolutePath, segVideoPath);
                segAsset = {
                  sceneIndex: index,
                  provider: "motion_canvas",
                  source: "motion",
                  url: `file://${segMotion.absolutePath}`,
                  durationSeconds: seg.durationSeconds,
                  fallbackUsed: true,
                  estimatedCost: 0,
                  metadata: {
                    template: "kinetic_typography",
                    source: "motion_canvas",
                    stockRequired: false,
                    stockFallback: {
                      decision: "purposeful_motion_graphics",
                      attempt: segRejection.details,
                    },
                  },
                };
              }
            }
            if (!reusedSeg && segAsset.provider === "pexels") artifactReuse.providerInvocations.pexels++;
            if (segAsset.provider !== "motion_canvas") {
              const cacheId =
                segAsset.metadata?.providerAssetId ||
                segAsset.metadata?.stockAssetId ||
                segAsset.metadata?.pexelsVideoId ||
                segAsset.metadata?.pixabayVideoId ||
                segAsset.url;
              const cached = cacheId ? mediaCache.getCachedAsset(segAsset.provider, cacheId as any) : null;
              if (cached) {
                fs.copySync(cached.filePath, segVideoPath);
              } else {
                await this.downloadFile(segAsset.url, segVideoPath);
                if (cacheId) mediaCache.saveCachedAsset(segAsset.provider, cacheId as any, segVideoPath);
              }
            }
            const mediaInputHash = createMediaInputHash({
              provider: segAsset.provider,
              sourceId: segAsset.metadata?.providerAssetId || segAsset.metadata?.stockAssetId || segAsset.metadata?.pexelsVideoId || segAsset.metadata?.pixabayVideoId,
              url: segAsset.url,
              selectedClip: segAsset.metadata?.smartClip,
              crop: segAsset.metadata?.smartCrop,
              visualIntent: sceneMediaPlan.visualIntent,
              sceneIndex: index,
              segmentIndex: seg.segmentIndex,
            });
            mediaArtifact = artifactStore.persistFile({
              type: "media",
              sceneIndex: index,
              segmentIndex: seg.segmentIndex,
              sourceJobId: videoId,
              sourceRevisionId: revision.revisionId,
              provider: segAsset.provider,
              model: segAsset.metadata?.pexelsVideoId,
              inputHash: mediaInputHash,
              sourcePath: segVideoPath,
              extension: "mp4",
              duration: seg.durationSeconds,
              metadata: { visualAsset: segAsset, visualIntent: sceneMediaPlan.visualIntent },
            });
            durableArtifacts.push(mediaArtifact);
            artifactReuse.regeneratedArtifacts.push(mediaArtifact);
          }

          visualProvidersUsed.add(segAsset.provider || mediaArtifact?.provider || "reused");

          const segAssetId = segAsset.metadata?.providerAssetId || segAsset.metadata?.stockAssetId || segAsset.metadata?.pexelsVideoId || segAsset.metadata?.pixabayVideoId;
          if (segAssetId) {
            excludeVideoIds.push(segAssetId as string | number);
          }
          previousVisualCandidates.push({
            id: segAssetId || segAsset.url,
            url: segAsset.url,
            width: segAsset.metadata?.width || 0,
            height: segAsset.metadata?.height || 0,
            duration: segAsset.durationSeconds,
            tags: segAsset.metadata?.searchTermsUsed,
            provider: segAsset.provider,
          });
          selectedVisuals.push({
            sceneIndex: index,
            segmentIndex: seg.segmentIndex,
            artifactId: mediaArtifact?.artifactId,
            reused: Boolean(reusableMediaArtifact),
            provider: segAsset.provider,
            source: segAsset.source,
            url: segAsset.url,
            durationSeconds: segAsset.durationSeconds,
            metadata: segAsset.metadata,
          });

          // This segment-based multi-shot path (sceneMediaPlan.segments) is a
          // second, older shot mechanism alongside the EDL/composeVisualBed
          // path used below for scenes without pre-planned segments. It
          // never recorded anything into `plannedShots` - the sole source of
          // truth for `professionalVisualQuality`'s real-visual-coverage
          // calculation - so any production that took this path (curiosity/
          // "fast"-pacing content routes here more often) always measured
          // realVisualCoveragePercent: 0% regardless of what actually
          // rendered, and was wrongly rejected by the professionalReady gate
          // even when built entirely from real stock footage (found via live
          // benchmark cmteyemae000p07n19o5egdlw - real airplane/cabin footage
          // throughout, independently verified, reported professionalReady:
          // false). Recorded the same way the EDL path records its shots.
          const segSourceType: "stock" | "mockup" | "motion" | "upload" | "image" =
            segAsset.source === "motion"
              ? "motion"
              : segAsset.source === "uploaded"
                ? "upload"
                : segAsset.source === "ai" || segAsset.source === "local_ai"
                  ? "image"
                  : "stock";
          const segIntent =
            originalSceneSpec.purpose === "hook" ? "hook"
              : originalSceneSpec.purpose === "cta" ? "cta"
                : originalSceneSpec.purpose === "solution" ? "solution"
                  : "detail";
          plannedShots.push({
            shotId: `${index}-${seg.segmentIndex}`,
            narrationSceneId: `scene${index}`,
            narrationSceneIndex: index,
            sceneIndex: index,
            purpose: String(originalSceneSpec.purpose || ""),
            intent: segIntent,
            sourceType: segSourceType,
            sourceId: segAssetId ? String(segAssetId) : undefined,
            provider: segAsset.provider,
            start: (sceneTimeline.startSeconds || 0) + segmentCursorSeconds,
            duration: seg.durationSeconds,
          });
          shotSourceCounts[segSourceType] = (shotSourceCounts[segSourceType] || 0) + 1;
          segmentCursorSeconds += seg.durationSeconds;

          renderedSegments.push({
            video: `http://localhost:${this.config.port}/api/tmp/${segVideoFileName}`,
            duration: seg.durationSeconds,
            motion: seg.motion || sceneMediaPlan.motion,
          });
        }

        sceneCaptionWords[index] = captions.map((caption) => ({
          text: String(caption.text || ""),
          startMs: caption.startMs,
          endMs: caption.endMs,
        }));
        scenes.push({
          // Remotion cannot draw captions it was never given. Passing an empty
          // list is what actually prevents a second caption layer under the
          // libass one; suppressing captionPreset alone did not.
          captions: burnCaptionsWithLibass ? [] : captions,
          video: renderedSegments[0].video,
          motion: sceneMediaPlan.motion,
          transition: sceneMediaPlan.transitionToNext,
          segments: renderedSegments,
          audio: {
            url: `http://localhost:${this.config.port}/api/tmp/${tempMp3FileName}`,
            duration: targetSceneDuration,
          },
          // See the single-segment branch below for why this - not
          // `audio.duration` above - is what an audio-first renderer must use.
          realNarrationDurationMs: Math.round(sceneSpeechDuration * 1000),
          speechWindowsMs: [{ startMs: speechWindowStartMs, endMs: speechWindowEndMs }],
        });
      } else {
        // Single segment scene
        const tempVideoFileName = `${tempId}.mp4`;
        const tempVideoPath = path.join(this.config.tempDirPath, tempVideoFileName);
        tempFiles.push(tempVideoPath);

        const reusableMediaArtifact = reusableArtifactFor("media", index, (artifact) => artifact.segmentIndex === undefined);
        let visualAsset: any;
        let mediaArtifact: DurableSceneArtifact | undefined;

        // Explicit graphic modes and any scene the creative plan resolved to a
        // motion treatment (see sceneResolvedToMotion above).
        const isMotionGraphics = sceneResolvedToMotion;

        const isProductAd =
          spec.productionMode === "product_ad" ||
          spec.visualMode === "product_ad" ||
          originalSceneSpec.visualSource === "product_composition";

        /**
         * Renders this scene through the local Motion Canvas runtime into
         * tempVideoPath. Used both when the creative plan resolved the scene
         * to a motion treatment and - the weak-stock case - when the stock
         * router refused every candidate and a designed graphic is the honest
         * visual for the beat. `stockFallback` carries the rejection evidence
         * so the decision can be explained afterwards.
         */
        const renderSceneAsMotionClip = async (
          forcedTreatment?: string,
          stockFallback?: Record<string, unknown>,
        ) => {
          const plannedTreatment = creativePlan.sceneTreatments.find(
            (entry) => entry.sceneIndex === index,
          );
          const motionTemplate: MotionTemplateType =
            (forcedTreatment &&
              TREATMENT_MOTION_TEMPLATE[forcedTreatment as keyof typeof TREATMENT_MOTION_TEMPLATE]) ||
            (plannedTreatment && TREATMENT_MOTION_TEMPLATE[plannedTreatment.treatment]) ||
            (spec.productionMode === "animated_explainer"
              ? index === 0
                ? "kinetic_typography"
                : index === 1
                  ? "explainer_diagram"
                  : "cta_card"
              : index === 0
                ? "kinetic_typography"
                : index === 1
                  ? "stat_animation"
                  : "cta_card");

          // Every value drawn comes from the script or the classifier. The
          // rejected build hardcoded "99.9%" and a fixed feature list, so a
          // motion-graphics video asserted statistics nobody had claimed.
          const narrationBeats = splitNarrationBeats(String(sceneTimeline.narration || ""));
          const extracted = plannedTreatment?.extracted;
          const motionResult = await motionEngine.renderMotionScene({
            template: motionTemplate,
            title:
              (originalSceneSpec as any).displayText ||
              originalSceneSpec.onScreenText ||
              originalSceneSpec.narration.slice(0, 60),
            subtitle:
              originalSceneSpec.narration.length > 60
                ? originalSceneSpec.narration.slice(0, 120)
                : undefined,
            numberStat: extracted?.statValue
              ? {
                value: extracted.statValue,
                label: String(originalSceneSpec.onScreenText || ""),
                suffix: extracted.statSuffix,
              }
              : undefined,
            features:
              motionTemplate === "feature_list"
                ? narrationBeats.slice(0, extracted?.stepCount || 3)
                : undefined,
            steps:
              motionTemplate === "explainer_diagram"
                ? narrationBeats.slice(0, extracted?.stepCount || 3)
                : undefined,
            ctaText: brandStyle.ctaText,
            contactText: spec.contact || spec.brandKit?.contactText,
            durationSeconds: targetSceneDuration,
            width: orientation === OrientationEnum.portrait ? 1080 : 1920,
            height: orientation === OrientationEnum.portrait ? 1920 : 1080,
            brandColors: motionPalette,
            brand: motionBrandFields,
            language: spec.language,
          });

          fs.copySync(motionResult.absolutePath, tempVideoPath);
          return {
            sceneIndex: index,
            provider: "motion_canvas",
            source: "motion_graphics",
            url: `file://${motionResult.absolutePath}`,
            durationSeconds: targetSceneDuration,
            fallbackUsed: Boolean(stockFallback),
            estimatedCost: 0,
            metadata: {
              template: motionTemplate,
              motionArtifactId: motionResult.artifactId,
              durationSeconds: targetSceneDuration,
              source: "motion_canvas",
              stockRequired: false,
              fontPath: motionResult.fontPath,
              preShapedArabic: motionResult.preShapedArabic,
              missingGlyphs: motionResult.missingGlyphs,
              brandFieldsDrawn: motionResult.brandFieldsDrawn,
              stockFallback,
            },
          } as any;
        };

        if (reusableMediaArtifact) {
          artifactStore.copyToTemp(reusableMediaArtifact, tempVideoPath);
          mediaArtifact = reusableMediaArtifact;
          artifactReuse.reusedArtifacts.push(reusableMediaArtifact);
          visualAsset = (reusableMediaArtifact.metadata?.visualAsset || reusableMediaArtifact.metadata || {}) as any;
        } else if (isMotionGraphics) {
          visualAsset = await renderSceneAsMotionClip();
        } else if (isProductAd) {
          let productMedia = null;
          const prodId = (spec.metadata as any)?.productImageId || (originalSceneSpec as any).productImageId;
          if (prodId) {
            productMedia = await mediaUploadService.getProductImage(prodId);
          }

          let nobgUrl: string | undefined;
          let productImageUrl: string | undefined;

          if (productMedia) {
            if (productMedia.nobgRelativePath) {
              const baseDataDir = this.config.dataDirPath || path.resolve(process.cwd(), "data-dev");
              const nobgAbs = path.resolve(baseDataDir, productMedia.nobgRelativePath);
              if (fs.existsSync(nobgAbs)) {
                const nobgTemp = path.join(this.config.tempDirPath, `${cuid()}-nobg.png`);
                fs.copySync(nobgAbs, nobgTemp);
                tempFiles.push(nobgTemp);
                nobgUrl = `http://localhost:${this.config.port}/api/tmp/${path.basename(nobgTemp)}`;
              }
            }
            if (productMedia.storagePath && fs.existsSync(productMedia.storagePath)) {
              const prodTemp = path.join(this.config.tempDirPath, `${cuid()}-prod${path.extname(productMedia.storagePath)}`);
              fs.copySync(productMedia.storagePath, prodTemp);
              tempFiles.push(prodTemp);
              productImageUrl = `http://localhost:${this.config.port}/api/tmp/${path.basename(prodTemp)}`;
            }
          }

          await this.ffmpeg.createSolidVideo(
            tempVideoPath,
            targetSceneDuration,
            orientation === OrientationEnum.landscape ? 1920 : 1080,
            orientation === OrientationEnum.landscape ? 1080 : 1920,
            spec.brandKit?.primaryColor || "#020617",
          );

          visualAsset = {
            sceneIndex: index,
            provider: "product_composition",
            source: "product_ad",
            url: nobgUrl || productImageUrl || "product_composition",
            durationSeconds: targetSceneDuration,
            fallbackUsed: false,
            estimatedCost: 0,
            metadata: {
              productNobgUrl: nobgUrl,
              productImageUrl,
              productHeadline: (originalSceneSpec as any).productHeadline || originalSceneSpec.narration.slice(0, 30),
              productOffer: (originalSceneSpec as any).productOffer || (spec.metadata as any)?.productOffer || "عرض خاص",
              productPrice: (originalSceneSpec as any).productPrice || (spec.metadata as any)?.productPrice,
              productCta: (originalSceneSpec as any).productCta || spec.brandKit?.outroText || (spec.metadata as any)?.productCta || "اطلب الآن عبر واتساب",
              productPlacement: (originalSceneSpec as any).productPlacement || (spec.metadata as any)?.productPlacement || "center",
              source: "product_composition",
            },
          };
        } else {
          const reusedAsset = reusableMediaAssets.find((asset: any) => asset.sceneIndex === index && asset.segmentIndex === undefined);
          // "Modern website" must not be illustrated with a screen of code.
          // The policy only fires for website ads whose narration is not about
          // engineering; everything else passes through unchanged.
          const plannedTerms =
            sceneMediaPlan.searchCandidates || sceneMediaPlan.searchTerms || originalSceneSpec.stockSearchTerms || [];

          // One scene intent becomes several visual angles - the subject, the
          // action around it, the environment, the audience and a supporting
          // texture - rather than one literal restatement of the sentence with
          // a joker list of "nature / globe / ocean" behind it.
          const queryFamilies = buildStockQueryFamilies({
            narration: String(originalSceneSpec.narration || ""),
            onScreenText: String(originalSceneSpec.onScreenText || ""),
            purpose: String(originalSceneSpec.purpose || ""),
            visualIntent: sceneMediaPlan.visualIntent,
            industryHint: String((spec.metadata as any)?.creativeProfile?.industryHint || spec.title || ""),
            mood: creativePlan.pacing,
            providedTerms: plannedTerms as string[],
            orientation: orientation === OrientationEnum.portrait ? "portrait" : "landscape",
          });
          stockQueryLog.push({
            sceneIndex: index,
            families: queryFamilies.families,
            queries: queryFamilies.queries.map((entry) => entry.query),
            matchedConcepts: queryFamilies.matchedConcepts,
            genericOnly: queryFamilies.genericOnly,
          });

          const intentPolicy = applyVisualIntentPolicy({
            terms: queryFamilyTerms(queryFamilies),
            narration: String(originalSceneSpec.narration || ""),
            isWebsiteAd: websiteAdContext,
            sceneIndex: index,
          });
          if (intentPolicy.applied) {
            logger.info(
              { sceneIndex: index, removed: intentPolicy.removed, substituted: intentPolicy.substituted },
              "Visual intent policy replaced code-shop footage terms for a website advertisement",
            );
            visualIntentPolicyLog.push({
              sceneIndex: index,
              removed: intentPolicy.removed,
              substituted: intentPolicy.substituted,
            });
          }
          const sceneCustomerAssignment = customerMediaByScene.get(index);
          const sceneCustomerAsset = sceneCustomerAssignment
            ? await this.resolveCustomerSceneAsset(sceneCustomerAssignment, targetSceneDuration, orientation)
            : null;
          if (!sceneCustomerAsset && customerMediaPlan.stockProvidersBlocked) {
            throw new Error(
              "This production was set to use only your own media, but a scene could not be prepared from the selected items.",
            );
          }

          const stockResolve = (terms: string[], generic: string[]) =>
            this.visualRouter.resolveSceneVisual(
              {
                ...originalSceneSpec,
                stockSearchTerms: terms,
              } as any,
              spec,
              {
                excludeIds: excludeVideoIds,
                orientation,
                tempDirPath: this.config.tempDirPath,
                targetDurationSeconds: targetSceneDuration,
                previousCandidates: previousVisualCandidates,
                onPerf: onVisualPerf,
                genericStockTerms: generic,
              },
            );
          const genericTermsOf = (families: typeof queryFamilies) =>
            families.queries.filter((entry) => entry.generic).map((entry) => entry.query);
          const stockFallbackTreatment = (purpose?: string): string =>
            purpose === "cta" ? "CTA_SCENE" : "KINETIC_TYPOGRAPHY";

          if (reusedAsset || sceneCustomerAsset) {
            visualAsset = reusedAsset || sceneCustomerAsset;
          } else {
            try {
              visualAsset = await stockResolve(intentPolicy.terms, genericTermsOf(queryFamilies));
            } catch (primaryRejection) {
              if (!(primaryRejection instanceof StockVisualRejection)) throw primaryRejection;

              // Bounded second attempt: a differently-rotated query family
              // asks different angles before the scene gives up on footage.
              const refinedFamilies = buildStockQueryFamilies({
                narration: String(originalSceneSpec.narration || ""),
                onScreenText: String(originalSceneSpec.onScreenText || ""),
                purpose: String(originalSceneSpec.purpose || ""),
                visualIntent: sceneMediaPlan.visualIntent,
                industryHint: String((spec.metadata as any)?.creativeProfile?.industryHint || spec.title || ""),
                mood: creativePlan.pacing,
                providedTerms: plannedTerms as string[],
                orientation: orientation === OrientationEnum.portrait ? "portrait" : "landscape",
                sceneIndex: index + 13,
              });
              const refinedPolicy = applyVisualIntentPolicy({
                terms: queryFamilyTerms(refinedFamilies),
                narration: String(originalSceneSpec.narration || ""),
                isWebsiteAd: websiteAdContext,
                sceneIndex: index,
              });
              stockQueryLog.push({
                sceneIndex: index,
                refinement: true,
                families: refinedFamilies.families,
                queries: refinedFamilies.queries.map((entry) => entry.query),
                matchedConcepts: refinedFamilies.matchedConcepts,
                genericOnly: refinedFamilies.genericOnly,
              });
              try {
                visualAsset = await stockResolve(refinedPolicy.terms, genericTermsOf(refinedFamilies));
              } catch (refinedRejection) {
                if (!(refinedRejection instanceof StockVisualRejection)) throw refinedRejection;
                logger.info(
                  {
                    sceneIndex: index,
                    firstReason: primaryRejection.details.reason,
                    secondReason: refinedRejection.details.reason,
                  },
                  "Stock could not honestly illustrate this scene; rendering a purposeful motion-graphics scene instead",
                );
                visualAsset = await renderSceneAsMotionClip(
                  stockFallbackTreatment(String(originalSceneSpec.purpose || "")),
                  {
                    decision: "purposeful_motion_graphics",
                    firstAttempt: primaryRejection.details,
                    secondAttempt: refinedRejection.details,
                    queriesAttempted: [
                      ...intentPolicy.terms,
                      ...refinedPolicy.terms.filter((term) => !intentPolicy.terms.includes(term)),
                    ],
                  },
                );
              }
            }
          }
          if (!reusedAsset && visualAsset.provider === "pexels") artifactReuse.providerInvocations.pexels++;
          const sceneQueryRecord = stockQueryLog[stockQueryLog.length - 1];
          if (sceneQueryRecord) {
            sceneQueryRecord.provider = visualAsset.provider;
            sceneQueryRecord.queryUsed = visualAsset.metadata?.searchTerm;
            sceneQueryRecord.candidateCount = visualAsset.metadata?.candidateCount;
            sceneQueryRecord.winner =
              visualAsset.metadata?.providerAssetId ||
              visualAsset.metadata?.stockAssetId ||
              visualAsset.metadata?.pexelsVideoId ||
              visualAsset.metadata?.pixabayVideoId ||
              visualAsset.url;
            sceneQueryRecord.fallbackReason = visualAsset.metadata?.stockFallback
              ? `stock_rejected:${String((visualAsset.metadata.stockFallback as any)?.decision || "purposeful_motion_graphics")}`
              : visualAsset.metadata?.fallback
                ? "provider_scoring_found_no_passing_candidate"
                : undefined;
          }

          // A motion-fallback scene is already a rendered clip in
          // tempVideoPath: no provider download and no stock health analysis.
          if (visualAsset.provider !== "motion_canvas") {
            const cacheId =
              visualAsset.metadata?.providerAssetId ||
              visualAsset.metadata?.stockAssetId ||
              visualAsset.metadata?.pexelsVideoId ||
              visualAsset.metadata?.pixabayVideoId ||
              visualAsset.url;
            const cached = cacheId ? mediaCache.getCachedAsset(visualAsset.provider, cacheId as any) : null;
            if (cached) {
              fs.copySync(cached.filePath, tempVideoPath);
            } else {
              await this.downloadFile(visualAsset.url, tempVideoPath);
              if (cacheId) mediaCache.saveCachedAsset(visualAsset.provider, cacheId as any, tempVideoPath);
            }

            const semanticAssetId = String(cacheId || visualAsset.url);
            const semanticAnalysis = await analyzeVideoSemanticSimilarity({
              videoPath: tempVideoPath,
              intentText: String(sceneMediaPlan.visualIntent || originalSceneSpec.purpose || ""),
              provider: visualAsset.provider,
              assetId: semanticAssetId,
              cacheDir: path.join(this.config.dataDirPath, "semantic-cache"),
            });
            if (visualAsset.metadata) {
              visualAsset.metadata.semanticAnalysis = semanticAnalysis;
              visualAsset.metadata.perceptualHash = semanticAnalysis.perceptualHash;
              visualAsset.metadata.frameSampleCount = semanticAnalysis.frameSampleCount;
              visualAsset.metadata.semanticModelId = semanticAnalysis.modelId;
              visualAsset.metadata.semanticRuntime = semanticAnalysis.runtime;
              if (semanticAnalysis.semanticAvailable) {
                visualAsset.metadata.visualSemanticScore = semanticAnalysis.visualSemanticScore;
              }
              const nearDuplicate = previousVisualCandidates.find((candidate) =>
                arePerceptuallyNearDuplicate(
                  String(candidate.perceptualHash || ""),
                  semanticAnalysis.perceptualHash,
                ),
              );
              if (nearDuplicate) {
                visualAsset.metadata.perceptualDuplicateOf = nearDuplicate.id || nearDuplicate.url;
                visualAsset.metadata.diversityPenalty = 35;
                visualAsset.metadata.rejectedCandidateReason = "perceptual_near_duplicate_previous_shot";
              }
            }

            if (capabilityManager.isPythonQualityVenvInstalled() && fs.existsSync(tempVideoPath) && fs.statSync(tempVideoPath).size > 1024) {
              try {
                const sceneAnalysis = await qualityEngine.analyzeScenes(tempVideoPath, targetSceneDuration);
                if (visualAsset.metadata) {
                  visualAsset.metadata.sceneAnalysis = sceneAnalysis;
                  visualAsset.metadata.selectedClip = sceneAnalysis.chosenWindow;
                  visualAsset.metadata.detectedScenesCount = sceneAnalysis.detectedScenes.length;
                  visualAsset.metadata.windowSelectionReason = sceneAnalysis.reason;
                }
              } catch (sdErr) {
                logger.warn(sdErr, "PySceneDetect analysis notice; continuing with standard window");
              }
            }
          }
        }

        if (!reusableMediaArtifact && visualAsset) {
          const mediaDurationForArtifact = await this.ffmpeg.getMediaDuration(tempVideoPath).catch(() => undefined);
          const mediaInputHash = createMediaInputHash({
            provider: visualAsset.provider,
            sourceId: visualAsset.metadata?.providerAssetId || visualAsset.metadata?.stockAssetId || visualAsset.metadata?.pexelsVideoId || visualAsset.metadata?.pixabayVideoId || visualAsset.source || visualAsset.url,
            url: visualAsset.url,
            selectedClip: visualAsset.metadata?.selectedClip,
            crop: visualAsset.metadata?.smartCrop,
            visualIntent: originalSceneSpec.visualIntent,
            sceneIndex: index,
          });
          mediaArtifact = artifactStore.persistFile({
            type: "media",
            sceneIndex: index,
            sourceJobId: videoId,
            sourceRevisionId: revision.revisionId,
            provider: visualAsset.provider,
            model: String(visualAsset.metadata?.source || visualAsset.source || visualAsset.provider),
            inputHash: mediaInputHash,
            sourcePath: tempVideoPath,
            extension: "mp4",
            duration: mediaDurationForArtifact,
            metadata: {
              visualAsset,
              reuseKey: {
                provider: visualAsset.provider,
                sourceId: visualAsset.metadata?.providerAssetId || visualAsset.metadata?.stockAssetId || visualAsset.metadata?.pexelsVideoId || visualAsset.metadata?.pixabayVideoId || visualAsset.source || visualAsset.url,
                selectedClip: visualAsset.metadata?.selectedClip,
                crop: visualAsset.metadata?.smartCrop,
                visualIntent: originalSceneSpec.visualIntent,
              },
            },
          });
          durableArtifacts.push(mediaArtifact);
          artifactReuse.regeneratedArtifacts.push(mediaArtifact);
        }

        visualProvidersUsed.add(visualAsset.provider);
        const visualAssetId = visualAsset.metadata?.providerAssetId || visualAsset.metadata?.stockAssetId || visualAsset.metadata?.pexelsVideoId || visualAsset.metadata?.pixabayVideoId;
        if (visualAssetId) {
          excludeVideoIds.push(visualAssetId as string | number);
        }
        previousVisualCandidates.push({
          id: visualAssetId || visualAsset.url,
          url: visualAsset.url,
          width: visualAsset.width || 0,
          height: visualAsset.height || 0,
          duration: visualAsset.durationSeconds,
          tags: visualAsset.metadata?.searchTermsUsed,
          provider: visualAsset.provider,
          perceptualHash: visualAsset.metadata?.perceptualHash,
        });
        selectedVisuals.push({
          sceneIndex: index,
          provider: visualAsset.provider,
          source: visualAsset.source,
          url: visualAsset.url,
          durationSeconds: visualAsset.durationSeconds,
          metadata: visualAsset.metadata,
          artifactId: mediaArtifact?.artifactId,
          reused: Boolean(reusableMediaArtifact),
        });
        const mediaDuration = await this.ffmpeg.getMediaDuration(tempVideoPath).catch(() => 0);

        // ------------------------------------------------------------------
        // Multi-shot visual bed.
        //
        // One narration scene becomes several visual shots. The narration, its
        // captions and its audio are untouched: only the picture is cut, so a
        // three-scene script can still carry six or more shots.
        // ------------------------------------------------------------------
        let sceneVisualCoherence: ReturnType<typeof evaluateVisualCoherence> = {
          coherent: true,
          jumps: [],
          reason: "single shot or no shot data available",
        };
        if (!isProductAd && mediaDuration > 0) {
          const sceneStartSeconds = sceneTimeline.startSeconds || 0;
          const sceneEdl = buildEditDecisionList({
            scenes: [{
              sceneId: `scene${index}`,
              sceneIndex: index,
              purpose: String(originalSceneSpec.purpose || ""),
              durationSeconds: targetSceneDuration,
              startSeconds: sceneStartSeconds,
              searchTerms: sceneMediaPlan.searchTerms,
            }],
            totalDurationSeconds: sceneStartSeconds + targetSceneDuration,
            pacingProfile: "editorial_ad",
            beats: beatTimestamps,
            assignSource: (shot, indexInScene) => {
              // The creative plan already decided what this narration scene
              // should look like. The first shot of a scene carries that
              // treatment; later shots in the same scene vary so a single
              // narration beat is not four copies of the same card.
              const planned = creativePlan.sceneTreatments.find(
                (entry) => entry.sceneIndex === index,
              );

              // The scene's picture is the customer's own asset: it is recorded
              // as an upload, with its real provenance, and never reclassified
              // as stock or replaced by a generated card.
              if (visualAsset.provider === CUSTOMER_MEDIA_PROVIDER) {
                return {
                  sourceType: "upload",
                  provider: CUSTOMER_MEDIA_PROVIDER,
                  routingReason: "customer_media_selected",
                };
              }

              // The scene could not be honestly illustrated with stock and was
              // rendered as a designed motion clip: every shot of it is that
              // motion bed, cut into windows, never a second stock fetch.
              if (visualAsset.provider === "motion_canvas") {
                return {
                  sourceType: "motion",
                  provider: "motion_canvas",
                  routingReason: visualAsset.metadata?.stockFallback
                    ? "stock_rejected_purposeful_motion"
                    : "motion_graphics_scene",
                };
              }

              if (
                planned &&
                !forceStockFootage &&
                isMotionTreatment(planned.treatment) &&
                (indexInScene === 0 || graphicOnlyMode || sceneResolvedToMotion)
              ) {
                return {
                  sourceType: "motion",
                  provider: "abud_motion",
                  routingReason: `creative_plan:${planned.treatment}:${planned.signal}`,
                };
              }

              if (!forceStockFootage && planned && indexInScene === 0 && TREATMENT_RUNTIME[planned.treatment] === "mockup") {
                return {
                  sourceType: "mockup",
                  provider: "abud_mockup",
                  routingReason: `creative_plan:${planned.treatment}`,
                };
              }

              // A website-design ad is better served by a real mockup than by
              // more generic footage, but only where the intent calls for it
              // and never for every shot in the scene.
              const template = websiteAdContext ? mockupForIntent(shot.intent) : null;
              if (!forceStockFootage && template && indexInScene > 0) {
                return { sourceType: "mockup", provider: "abud_mockup", routingReason: `website_intent:${shot.intent}` };
              }
              return { sourceType: "stock", provider: visualAsset.provider, routingReason: "stock_footage_best_available" };
            },
          });

          // Pick a clean window inside the downloaded clip rather than its
          // first seconds, which are often a logo card or a fade.
          const detection = await detectShots(tempVideoPath, { scriptDir: this.config.tempDirPath });

          // Where the picture actually is. Measured once per clip and reused for
          // every shot cut from it, so the reframe cannot swim between shots.
          // Absent runtime means an honest fall back to the safe centre crop.
          const focusProbe = await probeVisualFocus(tempVideoPath, {
            windowSeconds: Math.min(mediaDuration, targetSceneDuration * 2),
          });
          const frameWidth = orientation === OrientationEnum.portrait ? 1080 : 1920;
          const frameHeight = orientation === OrientationEnum.portrait ? 1920 : 1080;
          let previousCropPlan: SmartCropPlan | null = null;
          const shotInputs = [];
          for (let shotIndex = 0; shotIndex < sceneEdl.shots.length; shotIndex += 1) {
            const shot = sceneEdl.shots[shotIndex];
            // A motion-treated shot is rendered to its own short MP4 and then
            // handed to the composer as an ordinary clip, so graphic scenes and
            // footage go through exactly one compositing path.
            if (shot.sourceType === "motion") {
              // A scene-level stock rejection already rendered one motion clip
              // covering the whole scene duration - shots cut windows from it
              // rather than rendering the same template again per shot.
              if (visualAsset.provider === "motion_canvas" && visualAsset.metadata?.stockFallback) {
                shotInputs.push({
                  shot,
                  sourcePath: tempVideoPath,
                  sourceStartSeconds: Math.max(0, (shot.start || 0) - sceneStartSeconds),
                });
                continue;
              }
              const planned = creativePlan.sceneTreatments.find((entry) => entry.sceneIndex === index);
              const template = planned
                ? TREATMENT_MOTION_TEMPLATE[planned.treatment] || "kinetic_typography"
                : "kinetic_typography";
              try {
                const motionScene = await motionEngine.renderMotionScene({
                  template: template as MotionTemplateType,
                  title: String(originalSceneSpec.onScreenText || sceneTimeline.narration || spec.title || ""),
                  subtitle: String((originalSceneSpec as any).displayText || ""),
                  numberStat: planned?.extracted?.statValue
                    ? {
                      value: planned.extracted.statValue,
                      label: String(originalSceneSpec.onScreenText || ""),
                      suffix: planned.extracted.statSuffix,
                    }
                    : undefined,
                  features: planned?.extracted?.stepCount
                    ? splitNarrationBeats(String(sceneTimeline.narration || "")).slice(
                      0,
                      planned.extracted.stepCount,
                    )
                    : undefined,
                  steps: planned?.extracted?.stepCount
                    ? splitNarrationBeats(String(sceneTimeline.narration || "")).slice(
                      0,
                      planned.extracted.stepCount,
                    )
                    : undefined,
                  ctaText: brandStyle.ctaText,
                  contactText: spec.contact || spec.brandKit?.contactText,
                  durationSeconds: shot.duration,
                  width: orientation === "portrait" ? 1080 : 1920,
                  height: orientation === "portrait" ? 1920 : 1080,
                  fps: 25,
                  brandColors: motionPalette,
                  brand: motionBrandFields,
                  language: spec.language,
                });
                if (fs.existsSync(motionScene.absolutePath)) {
                  shotInputs.push({ shot, sourcePath: motionScene.absolutePath, sourceStartSeconds: 0 });
                  continue;
                }
              } catch (motionError) {
                logger.warn(
                  { err: String(motionError), sceneIndex: index, template },
                  "Motion scene render failed",
                );
                if (graphicOnlyMode || sceneResolvedToMotion) {
                  // A scene the plan resolved to motion must not silently
                  // acquire a stock dependency because one template failed - the
                  // host may have no stock provider at all. The shot is dropped
                  // from the bed instead, and the scene keeps whatever other
                  // graphic shots rendered.
                  shot.routingReason = `${shot.routingReason || ""}|motion_failed_graphic_only`;
                  shotInputs.push({ shot });
                  continue;
                }
                shot.routingReason = `${shot.routingReason || ""}|motion_fallback_to_stock`;
                shot.sourceType = "stock";
              }
            }
            if (shot.sourceType === "mockup") {
              shotInputs.push({
                shot,
                mockupTemplate: mockupForIntent(shot.intent) || undefined,
                // A mockup carries the customer's own brand when they supplied
                // one; the placeholder brand is used only when they did not.
                mockupPalette: {
                  background: brandStyle.palette.background,
                  primary: brandStyle.palette.primary,
                  accent: brandStyle.palette.accent,
                },
                mockupContent: {
                  brandName: brandStyle.brandName || undefined,
                  headline: String(originalSceneSpec.onScreenText || spec.title || ""),
                  subheadline: String((originalSceneSpec as any).displayText || ""),
                  ctaLabel: String(brandStyle.ctaText || spec.cta?.text || "ابدأ دلوقتي"),
                },
              });
              continue;
            }
            let selectedShotVisualAsset = visualAsset;
            let selectedShotVideoPath = tempVideoPath;
            let selectedShotMediaDuration = mediaDuration;

            if (shot.sourceType === "stock" && !reusableMediaArtifact) {
              const shotQueryFamilies = buildStockQueryFamilies({
                narration: String(originalSceneSpec.narration || ""),
                onScreenText: String(originalSceneSpec.onScreenText || ""),
                purpose: String(originalSceneSpec.purpose || ""),
                visualIntent: shot.visualIntent || sceneMediaPlan.visualIntent,
                shotIntent: shot.intent,
                industryHint: String((spec.metadata as any)?.creativeProfile?.industryHint || spec.title || ""),
                mood: creativePlan.pacing,
                providedTerms: [
                  shot.searchQuery,
                  ...(shot.alternativeQueries || []),
                  ...(sceneMediaPlan.searchTerms || []),
                ].filter(Boolean) as string[],
                orientation: orientation === OrientationEnum.portrait ? "portrait" : "landscape",
                maxQueries: 6,
              });
              const shotIntentPolicy = applyVisualIntentPolicy({
                terms: queryFamilyTerms(shotQueryFamilies),
                narration: String(originalSceneSpec.narration || ""),
                isWebsiteAd: websiteAdContext,
                sceneIndex: index,
              });
              shot.searchTerms = shotIntentPolicy.terms;
              shot.searchQuery = shotIntentPolicy.terms[0] || shot.searchQuery;
              shot.alternativeQueries = shotIntentPolicy.terms.slice(1);
              shot.matchedConcepts = shotQueryFamilies.matchedConcepts;

              if (shotIndex > 0) {
                try {
                  // A sub-shot inside a scene the customer assigned their own
                  // media to must come from that media too: reaching for stock
                  // here is the same silent substitution "My Media Only" exists
                  // to forbid.
                  const shotCustomerAssignment = customerMediaByScene.get(index);
                  const shotCustomerAsset = shotCustomerAssignment
                    ? await this.resolveCustomerSceneAsset(shotCustomerAssignment, shot.duration, orientation)
                    : null;
                  if (!shotCustomerAsset && customerMediaPlan.stockProvidersBlocked) {
                    throw new Error(
                      "This production was set to use only your own media, but a shot could not be prepared from the selected items.",
                    );
                  }
                  const shotAsset = shotCustomerAsset || await this.visualRouter.resolveSceneVisual(
                    {
                      ...originalSceneSpec,
                      stockSearchTerms: shotIntentPolicy.terms,
                      visualIntent: shot.visualIntent || sceneMediaPlan.visualIntent,
                    } as any,
                    spec,
                    {
                      excludeIds: excludeVideoIds,
                      orientation,
                      tempDirPath: this.config.tempDirPath,
                      targetDurationSeconds: shot.duration,
                      previousCandidates: previousVisualCandidates,
                      onPerf: onVisualPerf,
                    },
                  );
                  selectedShotVisualAsset = shotAsset;
                  visualProvidersUsed.add(shotAsset.provider);
                  if (shotAsset.provider === "pexels") artifactReuse.providerInvocations.pexels++;

                  const shotAssetId =
                    shotAsset.metadata?.providerAssetId ||
                    shotAsset.metadata?.stockAssetId ||
                    shotAsset.metadata?.pexelsVideoId ||
                    shotAsset.metadata?.pixabayVideoId;
                  const shotCacheId = shotAssetId || shotAsset.url;
                  const shotPath = path.join(this.config.tempDirPath, `${tempId}.shot${shotIndex}.mp4`);
                  tempFiles.push(shotPath);
                  const cachedShot = shotCacheId ? mediaCache.getCachedAsset(shotAsset.provider, shotCacheId as any) : null;
                  if (cachedShot) {
                    fs.copySync(cachedShot.filePath, shotPath);
                  } else {
                    await this.downloadFile(shotAsset.url, shotPath);
                    if (shotCacheId) mediaCache.saveCachedAsset(shotAsset.provider, shotCacheId as any, shotPath);
                  }
                  selectedShotVideoPath = shotPath;
                  selectedShotMediaDuration = await this.ffmpeg.getMediaDuration(shotPath).catch(() => shot.duration);
                  const shotSemanticAnalysis = await analyzeVideoSemanticSimilarity({
                    videoPath: shotPath,
                    intentText: String(shot.visualIntent || shot.intent || sceneMediaPlan.visualIntent || ""),
                    provider: shotAsset.provider,
                    assetId: String(shotCacheId || shotAsset.url),
                    cacheDir: path.join(this.config.dataDirPath, "semantic-cache"),
                  });
                  const nearDuplicate = previousVisualCandidates.find((candidate) =>
                    arePerceptuallyNearDuplicate(
                      String(candidate.perceptualHash || ""),
                      shotSemanticAnalysis.perceptualHash,
                    ),
                  );
                  shot.sourceId = shotAssetId ? String(shotAssetId) : undefined;
                  shot.provider = shotAsset.provider;
                  shot.semanticScore = Number(
                    shotSemanticAnalysis.visualSemanticScore ??
                    shotAsset.metadata?.visualSemanticScore ??
                    shotAsset.metadata?.semanticScore ??
                    shotAsset.metadata?.selectedScore ??
                    0,
                  ) || undefined;
                  shot.qualityScore = Number(shotAsset.metadata?.qualityScore ?? 0) || undefined;
                  shot.decisionScore = Number(shotAsset.metadata?.selectedScore ?? 0) || undefined;
                  shot.decisionBreakdown = {
                    semantic: Number(shotAsset.metadata?.semanticScore ?? 0) || 0,
                    technical: Number(shotAsset.metadata?.qualityScore ?? 0) || 0,
                    durationFit: selectedShotMediaDuration >= shot.duration ? 100 : 60,
                    diversityPenalty: nearDuplicate ? 35 : 0,
                  };
                  if (shotAsset.metadata) {
                    shotAsset.metadata.semanticAnalysis = shotSemanticAnalysis;
                    shotAsset.metadata.perceptualHash = shotSemanticAnalysis.perceptualHash;
                    shotAsset.metadata.frameSampleCount = shotSemanticAnalysis.frameSampleCount;
                    shotAsset.metadata.semanticModelId = shotSemanticAnalysis.modelId;
                    shotAsset.metadata.semanticRuntime = shotSemanticAnalysis.runtime;
                    if (shotSemanticAnalysis.semanticAvailable) {
                      shotAsset.metadata.visualSemanticScore = shotSemanticAnalysis.visualSemanticScore;
                    }
                    if (nearDuplicate) {
                      shotAsset.metadata.perceptualDuplicateOf = nearDuplicate.id || nearDuplicate.url;
                      shotAsset.metadata.diversityPenalty = 35;
                    }
                  }
                  if (nearDuplicate) {
                    shot.rejectedCandidates = [
                      ...(shot.rejectedCandidates || []),
                      {
                        provider: shotAsset.provider,
                        assetId: shotAssetId ? String(shotAssetId) : shotAsset.url,
                        reason: "perceptual_near_duplicate_previous_shot",
                      },
                    ];
                  }
                  if (shotAssetId) excludeVideoIds.push(shotAssetId as string | number);
                  previousVisualCandidates.push({
                    id: shotAssetId || shotAsset.url,
                    url: shotAsset.url,
                    width: shotAsset.metadata?.width || 0,
                    height: shotAsset.metadata?.height || 0,
                    duration: shotAsset.durationSeconds,
                    tags: shotAsset.metadata?.searchTermsUsed,
                    provider: shotAsset.provider,
                    perceptualHash: shotAsset.metadata?.perceptualHash,
                  });
                  selectedVisuals.push({
                    sceneIndex: index,
                    shotId: shot.shotId,
                    provider: shotAsset.provider,
                    source: shotAsset.source,
                    url: shotAsset.url,
                    durationSeconds: shot.duration,
                    metadata: {
                      ...shotAsset.metadata,
                      shotSearchQuery: shot.searchQuery,
                      shotAlternativeQueries: shot.alternativeQueries,
                    },
                  });
                } catch (shotAssetError) {
                  shot.rejectedCandidates = [
                    ...(shot.rejectedCandidates || []),
                    {
                      provider: "stock_mesh",
                      assetId: shot.searchQuery || "unknown",
                      reason: shotAssetError instanceof Error ? shotAssetError.message : String(shotAssetError),
                    },
                  ];
                  if (shotAssetError instanceof StockVisualRejection) {
                    // Stock could not honestly illustrate this beat: a
                    // designed motion shot is better than re-cutting the same
                    // scene clip a second time.
                    try {
                      const planned = creativePlan.sceneTreatments.find((entry) => entry.sceneIndex === index);
                      const motionScene = await motionEngine.renderMotionScene({
                        template: (planned && TREATMENT_MOTION_TEMPLATE[planned.treatment]) || "kinetic_typography",
                        title: String(originalSceneSpec.onScreenText || sceneTimeline.narration || spec.title || ""),
                        subtitle: String((originalSceneSpec as any).displayText || ""),
                        ctaText: brandStyle.ctaText,
                        contactText: spec.contact || spec.brandKit?.contactText,
                        durationSeconds: shot.duration,
                        width: orientation === "portrait" ? 1080 : 1920,
                        height: orientation === "portrait" ? 1920 : 1080,
                        fps: 25,
                        brandColors: motionPalette,
                        brand: motionBrandFields,
                        language: spec.language,
                      });
                      if (fs.existsSync(motionScene.absolutePath)) {
                        shot.sourceType = "motion";
                        shot.provider = "motion_canvas";
                        shot.routingReason = `${shot.routingReason || ""}|stock_rejected_motion_fallback`;
                        shotInputs.push({ shot, sourcePath: motionScene.absolutePath, sourceStartSeconds: 0 });
                        continue;
                      }
                    } catch (motionShotError) {
                      logger.warn(
                        { err: String(motionShotError), sceneIndex: index, shotId: shot.shotId },
                        "Motion fallback shot render failed; reusing the scene asset",
                      );
                    }
                  }
                  shot.routingReason = `${shot.routingReason || ""}|shot_specific_asset_failed_reused_scene_asset`;
                }
              }
            }

            const detectionForShot =
              selectedShotVideoPath === tempVideoPath
                ? detection
                : await detectShots(selectedShotVideoPath, { scriptDir: this.config.tempDirPath }).catch(() => detection);
            const window = selectBestWindow(detectionForShot, selectedShotMediaDuration, shot.duration);
            // Different shots from the same clip must not repeat the same
            // seconds, so later shots step further into the source.
            const offset = Math.min(
              Math.max(0, selectedShotMediaDuration - shot.duration),
              window.startSeconds + shotIndex * shot.duration,
            );
            const cropPlan = planSmartCrop({
              sourceWidth: Number(selectedShotVisualAsset?.width || selectedShotVisualAsset?.metadata?.width) || frameWidth,
              sourceHeight: Number(selectedShotVisualAsset?.height || selectedShotVisualAsset?.metadata?.height) || frameHeight,
              targetWidth: frameWidth,
              targetHeight: frameHeight,
              tags: selectedShotVisualAsset?.metadata?.searchTermsUsed || shot.searchTerms || sceneMediaPlan.searchTerms,
              visualIntent: shot.visualIntent || sceneMediaPlan.visualIntent,
              manualFocalPoint: (originalSceneSpec as any).focalPoint,
              probe: focusProbe,
              previousPlan: previousCropPlan,
            });
            previousCropPlan = cropPlan;
            shot.sourceId = shot.sourceId || String(selectedShotVisualAsset?.metadata?.providerAssetId || selectedShotVisualAsset?.metadata?.stockAssetId || selectedShotVisualAsset?.metadata?.pexelsVideoId || selectedShotVisualAsset?.metadata?.pixabayVideoId || "");
            shot.provider = selectedShotVisualAsset?.provider || shot.provider;
            shot.sourceStartSeconds = offset;
            shot.sourceEndSeconds = Number((offset + shot.duration).toFixed(3));
            shot.semanticScore = shot.semanticScore || Number(selectedShotVisualAsset?.metadata?.semanticScore ?? selectedShotVisualAsset?.metadata?.selectedScore ?? 0) || undefined;
            shot.qualityScore = shot.qualityScore || Number(selectedShotVisualAsset?.metadata?.qualityScore ?? 0) || undefined;
            shot.decisionScore = shot.decisionScore || Number(selectedShotVisualAsset?.metadata?.selectedScore ?? 0) || undefined;
            shot.crop = {
              mode: cropPlan.mode,
              xCenter: cropPlan.xCenter,
              yCenter: cropPlan.yCenter,
              safetyScore: Math.round(cropPlan.confidence * 100),
            };
            shot.routingReason = `${shot.routingReason || ""}|crop:${cropPlan.mode}`;
            shotInputs.push({ shot, sourcePath: selectedShotVideoPath, sourceStartSeconds: offset, cropPlan });
          }

          // Persist the reframing decision so a rejected video can be explained
          // rather than guessed at, and so a revision reuses the same framing.
          const cropPlansUsed = shotInputs
            .map((entry) => (entry as { cropPlan?: SmartCropPlan }).cropPlan)
            .filter(Boolean) as SmartCropPlan[];
          if (visualAsset?.metadata && cropPlansUsed.length > 0) {
            visualAsset.metadata.smartCropPlan = cropMetadata(cropPlansUsed[0]);
            visualAsset.metadata.smartCropShots = cropPlansUsed.map(cropMetadata);
            visualAsset.metadata.focusProbe = {
              available: focusProbe.available,
              source: focusProbe.source,
              concentration: focusProbe.concentration,
            };
          }

          if (shotInputs.length > 1) {
            const bedPath = path.join(this.config.tempDirPath, `${tempId}.bed.mp4`);
            const workDir = path.join(this.config.tempDirPath, `${tempId}_shots`);
            const composed = await composeVisualBed({
              shots: shotInputs,
              outputPath: bedPath,
              width: orientation === "portrait" ? 1080 : 1920,
              height: orientation === "portrait" ? 1920 : 1080,
              fps: 25,
              workDir,
              colorNormalize: true,
            });
            if (composed.composed && fs.existsSync(bedPath)) {
              fs.moveSync(bedPath, tempVideoPath, { overwrite: true });
              sceneEdl.shots.forEach((shot) => {
                plannedShots.push(shot);
                shotSourceCounts[shot.sourceType] = (shotSourceCounts[shot.sourceType] || 0) + 1;
              });
            } else {
              // Composition declined or failed: the single clip still stands.
              // The source type is the one the plan actually chose - reporting
              // every uncomposed scene as "stock" is what made a pure motion
              // production look as though it still depended on footage.
              const fallbackShot = {
                ...sceneEdl.shots[0],
                duration: targetSceneDuration,
                routingReason: `single_clip:${composed.reason || "not_composed"}`,
              };
              plannedShots.push(fallbackShot);
              shotSourceCounts[fallbackShot.sourceType] =
                (shotSourceCounts[fallbackShot.sourceType] || 0) + 1;
            }
            if (fs.existsSync(workDir)) fs.removeSync(workDir);
            if (fs.existsSync(bedPath)) fs.removeSync(bedPath);
          } else {
            const onlyShot = { ...sceneEdl.shots[0], duration: targetSceneDuration };
            plannedShots.push(onlyShot);
            shotSourceCounts[onlyShot.sourceType] =
              (shotSourceCounts[onlyShot.sourceType] || 0) + 1;
          }
          // Real (not fabricated) editorial-coherence check (ABUD_SHORTS_
          // ENGINE_STATUS.md section 17): flags an adjacent pair of shots
          // within this scene whose recognised concepts share nothing in
          // common - the deterministic shape of "laptop worker -> filmmaking
          // crew" jumps found during the real-content proof. Advisory/logged
          // in this pass, not yet a hard selection gate - see that same
          // status file section for the scoping note.
          sceneVisualCoherence = evaluateVisualCoherence(
            sceneEdl.shots.map((shot) => shot.matchedConcepts || []),
          );
          if (!sceneVisualCoherence.coherent) {
            logger.warn(
              { sceneIndex: index, reason: sceneVisualCoherence.reason },
              "Scene visual coherence: adjacent shots share no recognised concept",
            );
          }
        }
        sceneQa.push({
          sceneIndex: index,
          assetExists: fs.existsSync(tempVideoPath),
          assetReadable: mediaDuration > 0 || isProductAd,
          durationFit: mediaDuration >= targetSceneDuration * 0.5 || isProductAd,
          visualRelevanceScore: visualAsset.metadata?.selectedScore || 95,
          duplicateRisk: visualAsset.metadata?.scoreBreakdown?.nearDuplicateRisk,
          cropSafety: visualAsset.metadata?.smartCrop,
          smartCrop: visualAsset.metadata?.smartCropPlan,
          captionSafeLayout: true,
          voiceDurationFit: actualVoiceDuration <= targetSceneDuration * 1.08,
          visualCoherence: sceneVisualCoherence,
        });

        sceneCaptionWords[index] = captions.map((caption) => ({
          text: String(caption.text || ""),
          startMs: caption.startMs,
          endMs: caption.endMs,
        }));
        scenes.push({
          // Remotion cannot draw captions it was never given; this is what
          // actually prevents a second caption layer under the libass one.
          captions: burnCaptionsWithLibass ? [] : captions,
          video: `http://localhost:${this.config.port}/api/tmp/${tempVideoFileName}`,
          motion: sceneMediaPlan.motion,
          transition: sceneMediaPlan.transitionToNext,
          audio: {
            url: `http://localhost:${this.config.port}/api/tmp/${tempMp3FileName}`,
            duration: targetSceneDuration,
          },
          // The REAL, ffprobe-measured speech length - NOT `audio.duration`
          // above, which is `targetSceneDuration` (the legacy engine's
          // held-to-budget visual duration, can be longer than the actual
          // narration). Revideo's audio-first timeline must never see the
          // held value, or it silently reimports the exact silence-padding
          // bug this migration exists to eliminate - see
          // ABUD_SHORTS_ENGINE_STATUS.md "Revideo Evaluation" section 11.
          realNarrationDurationMs: Math.round(sceneSpeechDuration * 1000),
          speechWindowsMs: [{ startMs: speechWindowStartMs, endMs: speechWindowEndMs }],
          productNobgUrl: visualAsset?.metadata?.productNobgUrl,
          productImageUrl: visualAsset?.metadata?.productImageUrl,
          productHeadline: visualAsset?.metadata?.productHeadline,
          productOffer: visualAsset?.metadata?.productOffer,
          productPrice: visualAsset?.metadata?.productPrice,
          productCta: visualAsset?.metadata?.productCta,
          productPlacement: visualAsset?.metadata?.productPlacement,
          visualSource: visualAsset?.source,
        } as any);
      }
      await this.emitProgress(onProgress, {
        status: "searching_assets",
        progress: Math.min(sceneProgressBase + 20, 78),
        currentStage: "Media selected",
        message: `Media QA completed for scene ${index + 1}.`,
        stageKey: "media",
        checkpointStatus: "completed",
        provider: Array.from(visualProvidersUsed).join(","),
        artifacts: {
          sceneIndex: index,
          type: "media",
          reused: selectedVisuals.filter((asset) => asset.sceneIndex === index).every((asset) => Boolean((asset as any).reused)),
          selectedVisuals: selectedVisuals.filter((asset) => asset.sceneIndex === index),
          sceneQa: sceneQa.filter((item) => item.sceneIndex === index),
        },
        timingMs: Date.now() - mediaStartedAt,
      });

      index++;
    }

    const totalDurationSeconds = Math.round(scenes.reduce((acc, curr) => acc + (curr.audio?.duration || 0), 0) * 100) / 100;

    // Observability for the duration-adherence invariant: the sum of the planned
    // scene visual durations should track the requested content budget.
    const plannedContentSeconds = Math.round(renderedContentSeconds * 100) / 100;
    const requestedContentSeconds = Math.round(
      ((timeline.requestedDurationSeconds || 0) - (timeline.outroDurationSeconds || 0)) * 100,
    ) / 100;
    if (requestedContentSeconds > 0 && Math.abs(plannedContentSeconds - requestedContentSeconds) > 1.5) {
      logger.warn(
        { videoId, requestedContentSeconds, plannedContentSeconds, spokenSeconds: totalDurationSeconds },
        "Planned scene duration diverges from the requested content budget",
      );
    }

    // Total-duration authority (Short Studio 2.5 Arabic duration-defect
    // closure pass). Per-scene correction above already accepts/condenses
    // each scene individually within its own tolerance, but per-scene
    // tolerances can still compound into a total that misses the product's
    // actual accepted window - exactly how the 18.15s-against-11s Arabic
    // overshoot slipped through with every individual scene "accepted".
    // Predict the final MP4 duration BEFORE spending time on render (real
    // total narration already measured above, plus the bounded natural
    // breath pause between scenes and the timeline's own bounded outro) and
    // fail clearly instead of rendering a video already known to be
    // invalid - never silently accept an overshoot/undershoot this large.
    const boundedGapSeconds = Math.max(0, scenes.length - 1) * 0.16;
    const predictedFinalSeconds = Math.round(
      (totalDurationSeconds + boundedGapSeconds + (timeline.outroDurationSeconds || 0)) * 100,
    ) / 100;
    const durationToleranceSeconds = Math.max(2.5, Math.round(timeline.requestedDurationSeconds * 0.15 * 10) / 10);
    if (timeline.requestedDurationSeconds > 0) {
      const lowerBound = timeline.requestedDurationSeconds - durationToleranceSeconds;
      const upperBound = timeline.requestedDurationSeconds + durationToleranceSeconds;
      if (predictedFinalSeconds < lowerBound || predictedFinalSeconds > upperBound) {
        logger.error(
          {
            videoId,
            requestedDurationSeconds: timeline.requestedDurationSeconds,
            predictedFinalSeconds,
            totalDurationSeconds,
            boundedGapSeconds,
            outroDurationSeconds: timeline.outroDurationSeconds || 0,
            lowerBound,
            upperBound,
          },
          "DURATION_TARGET_NOT_MET: predicted final duration falls outside the accepted range after bounded per-scene correction",
        );
        throw new Error(
          `DURATION_TARGET_NOT_MET: predicted final duration ${predictedFinalSeconds}s falls outside the accepted [${lowerBound}, ${upperBound}]s range for a ${timeline.requestedDurationSeconds}s request.`,
        );
      }
    }


    let captionRenderer: "libass" | "remotion" = "remotion";
    let captionFontFamily: string | undefined;
    let captionQaResult: any = null;
    const hasProductComposition = scenes.some((scene) =>
      Boolean((scene as any).productNobgUrl || (scene as any).productImageUrl || (scene as any).visualSource === "product_composition"),
    );
    const renderDecision: RenderStrategyDecision = decideRenderStrategy({
      spec,
      shots: plannedShots,
      captionsNativeAvailable: burnCaptionsWithLibass || spec.captionStyle === "none",
      hasProductComposition,
      fps: 25,
      durationSeconds: totalDurationSeconds,
    });
    let renderFallbackReason: string | undefined;
    let renderEngineUsed: "ffmpeg_fast" | "hybrid_ffmpeg" | "remotion" | "remotion_fallback" | "revideo" =
      renderDecision.strategy === "FFMPEG_FAST"
        ? "ffmpeg_fast"
        : renderDecision.strategy === "HYBRID"
          ? "hybrid_ffmpeg"
          : "remotion";
    let compositionMs = 0;
    let finalEncodeMs = 0;
    let remotionFramesRendered = renderDecision.baseFootageFramesThroughChromium;

    await this.emitProgress(onProgress, {
      status: "rendering",
      progress: 82,
      currentStage: "Rendering",
      message: renderDecision.customerStage === "Editing"
        ? "Editing scenes, captions, and audio into the final video."
        : "Rendering the final video.",
      stageKey: "render",
      checkpointStatus: "running",
      inputHashSource: { scenes: scenes.length, duration: totalDurationSeconds, strategy: renderDecision.strategy },
    });
    const renderStartedAt = Date.now();

    // Master a per-job excerpt of the selected music bed instead of streaming
    // the shared catalog file as-is. The catalog file's own energy envelope
    // can dip near-silent for a second or more (measured via `beatMap` above),
    // and Remotion's per-frame volume is only ever a flat multiplier on top of
    // whatever the source already contains - it cannot raise a passage that is
    // already quiet. When a start offset can be chosen so the needed window
    // avoids the quietest dips, and/or a real compressor can raise what
    // remains, the final mixed track stops going near-silent during narration
    // gaps (incident cmtehsptj000108ledzk3f3ji: ~4.5s/~5.3s/~4.8s runs below
    // -35dB in exactly this situation).
    let musicForRender: MusicForVideo = selectedMusic;
    if (selectedMusic?.file) {
      try {
        const sourceMusicPath = path.join(this.config.musicDirPath, selectedMusic.file);
        const windowSeconds = totalDurationSeconds;
        const bestStart = pickQuietestSafeMusicStart(
          beatMap?.energyEnvelope as number[] | undefined,
          selectedMusic.start,
          selectedMusic.end,
          windowSeconds,
        );
        const masteredFileName = `${cuid()}.music.mp3`;
        const masteredMusicPath = path.join(this.config.tempDirPath, masteredFileName);
        tempFiles.push(masteredMusicPath);
        await this.ffmpeg.masterMusicBed(sourceMusicPath, masteredMusicPath, {
          startSeconds: bestStart,
          durationSeconds: windowSeconds,
        });
        musicForRender = {
          ...selectedMusic,
          url: `http://localhost:${this.config.port}/api/tmp/${masteredFileName}`,
          start: 0,
          end: windowSeconds + 1,
        };
      } catch (musicMasterErr) {
        logger.warn(musicMasterErr, "Music-bed mastering failed; falling back to the raw catalog track");
      }
    }

    const runRemotionRender = async () => {
      remotionFramesRendered = Math.max(
        remotionFramesRendered,
        Math.round(totalDurationSeconds * 25),
      );
      await this.remotion.render(
        {
          music: musicForRender,
          scenes,
          config: {
            durationMs: Math.round(totalDurationSeconds * 1000),
            paddingBack: 0,
            captionBackgroundColor: "rgba(11, 27, 31, 0.84)",
            captionPosition: "bottom" as any,
            // Remotion still draws motion graphics, CTA, titles and brand
            // overlays. Spoken captions are burned afterwards by libass, which
            // shapes Arabic correctly, so they are suppressed here to avoid two
            // caption layers on the same frame.
            captionPreset: burnCaptionsWithLibass ? ("none" as any) : (mediaPlan.captionPreset || spec.captionStyle || "bold"),
            ctaLayout: mediaPlan.ctaLayout || "centered",
            musicVolume: "medium" as any,
            musicDuckingProfile: "balanced",
            brandKit: spec.brandKit,
          },
        },
        videoId,
        orientation,
        spec.quality === "max_quality_local" ? "high" : spec.quality || "standard",
      );
    };

    // Revideo evaluation (ABUD_SHORTS_ENGINE_STATUS.md "Revideo Evaluation",
    // section 11): builds a ProductionTimeline from the SAME already-resolved
    // scene data the legacy renderers above consume - no TTS/Pexels/Whisper/
    // planning is duplicated or re-run here, only the render/composition
    // stage is replaced. Uses `realNarrationDurationMs` (the true,
    // ffprobe-measured speech length), never `scene.audio.duration` (the
    // legacy engine's held-to-budget visual duration) - see the field's own
    // doc comment above for why that distinction is exactly the bug this
    // migration exists to fix.
    const runRevideoRender = async () => {
      const width = orientation === OrientationEnum.portrait ? 1080 : 1920;
      const height = orientation === OrientationEnum.portrait ? 1920 : 1080;
      const revideoTemplate: ProductionTemplate = hasProductComposition
        ? "business_promo"
        : spec.productionMode === "motion_graphics" || spec.productionMode === "animated_explainer"
          ? "kinetic_explainer"
          : "stock_social_reel";

      const revideoSceneInputs: LegacySceneInput[] = scenes.map((scene: any, sceneIdx: number) => {
        const segments = Array.isArray(scene.segments) ? scene.segments : undefined;
        const visualPath = this.localPathForMediaUrl(segments && segments.length > 0 ? segments[0].video : scene.video);
        if (!visualPath || !fs.existsSync(visualPath)) {
          throw new Error(`Revideo render: scene ${sceneIdx} visual asset is not available (${scene.video}).`);
        }
        const additionalVisualPaths = segments && segments.length > 1
          ? segments.slice(1).map((segment: any) => {
            const segmentPath = this.localPathForMediaUrl(segment.video);
            if (!segmentPath || !fs.existsSync(segmentPath)) {
              throw new Error(`Revideo render: scene ${sceneIdx} additional segment is not available.`);
            }
            return segmentPath;
          })
          : undefined;
        const narrationPath = this.localPathForMediaUrl(scene.audio?.url);
        if (!narrationPath || !fs.existsSync(narrationPath)) {
          throw new Error(`Revideo render: scene ${sceneIdx} narration audio is not available.`);
        }
        // sceneMediaPlan.transitionToNext is attached to the OUTGOING scene;
        // it becomes the transitionIn of the scene that follows it.
        const previousScene = sceneIdx > 0 ? (scenes[sceneIdx - 1] as any) : undefined;
        const narrationDurationMs =
          Number(scene.realNarrationDurationMs) || Math.round((scene.audio?.duration || 0) * 1000);
        // See clampCaptionWordsToNarration's own doc comment: the shared
        // deterministic-timing caption fallback can time words against the
        // legacy held-to-budget visual duration rather than real narration
        // length, which would otherwise silently inflate Revideo's total
        // render duration via its concurrent caption/visual loops.
        const rawCaptionWords = spec.captionStyle === "none" ? [] : sceneCaptionWords[sceneIdx] || [];
        const captionWords = clampCaptionWordsToNarration(rawCaptionWords, narrationDurationMs);
        return {
          id: `${videoId}-${sceneIdx}`,
          sceneIndex: sceneIdx,
          purpose: "scene",
          visualPath,
          additionalVisualPaths,
          narrationPath,
          narrationDurationMs,
          captionWords,
          transition: previousScene?.transition,
        };
      });

      const revideoMusicPath = musicForRender?.file
        ? this.localPathForMediaUrl(musicForRender.url) || path.join(this.config.musicDirPath, musicForRender.file)
        : undefined;

      const revideoTimeline = productionTimelineFromLegacyScenes({
        id: videoId,
        width,
        height,
        fps: 25,
        template: revideoTemplate,
        scenes: revideoSceneInputs,
        musicPath: revideoMusicPath,
        musicVolume: 0.18,
      });

      const revideoRenderer = new RevideoRenderer(
        this.config.tempDirPath,
        undefined,
        undefined,
        process.env.PUPPETEER_EXECUTABLE_PATH,
      );
      const result = await revideoRenderer.render(revideoTimeline);
      fs.ensureDirSync(path.dirname(this.getVideoPath(videoId)));
      fs.copySync(result.outputPath, this.getVideoPath(videoId));
      compositionMs = result.compositionMs;
      finalEncodeMs = result.finalEncodeMs;
      remotionFramesRendered = 0;
    };

    if (this.config.videoRenderEngine === "revideo") {
      renderEngineUsed = "revideo";
      // Fail-closed (section 12): deliberately no try/catch and no legacy
      // fallback here. If Revideo fails, the whole production must fail
      // clearly - qualification needs truth, not a silently-substituted
      // legacy render reported as a Revideo success. Legacy remains
      // available only via the explicit VIDEO_RENDER_ENGINE=legacy default.
      await runRevideoRender();
    } else if (renderDecision.fastPathEligible) {
      try {
        const fastCaptionAssPath = burnCaptionsWithLibass
          ? this.createTimelineCaptionAss({
            videoId,
            scenes,
            sceneCaptionWords,
            captionStyleId: spec.captionStyle as string,
            orientation,
            captionStyleSpec,
            fontsDir,
            tempFiles,
          })
          : undefined;
        if (fastCaptionAssPath) {
          captionRenderer = "libass";
          captionFontFamily = fastCaptionAssPath.fontFamily;
          captionQaResult = fastCaptionAssPath.qa;
        }
        const fastResult = await renderFfmpegFast({
          clips: this.fastRenderClipsFromScenes(scenes),
          voices: this.fastRenderVoicesFromScenes(scenes),
          outputPath: this.getVideoPath(videoId),
          width: orientation === OrientationEnum.portrait ? 1080 : 1920,
          height: orientation === OrientationEnum.portrait ? 1920 : 1080,
          fps: 25,
          totalDurationSeconds,
          musicPath: this.localPathForMediaUrl(musicForRender.url) || path.join(this.config.musicDirPath, musicForRender.file),
          captionsAssPath: fastCaptionAssPath?.path,
          fontsDir,
        });
        compositionMs = fastResult.compositionMs;
        finalEncodeMs = fastResult.finalEncodeMs;
        remotionFramesRendered = 0;
      } catch (fastErr) {
        renderFallbackReason = fastErr instanceof Error ? fastErr.message : String(fastErr);
        logger.warn({ err: renderFallbackReason, videoId }, "FFmpeg fast render failed; falling back to Remotion");
        renderEngineUsed = "remotion_fallback";
        await runRemotionRender();
        compositionMs = Date.now() - renderStartedAt;
        finalEncodeMs = compositionMs;
      }
    } else {
      await runRemotionRender();
      compositionMs = Date.now() - renderStartedAt;
      finalEncodeMs = compositionMs;
    }
    await this.emitProgress(onProgress, {
      status: "rendering",
      progress: 88,
      currentStage: "Rendered",
      message: "Final video render completed.",
      stageKey: "render",
      checkpointStatus: "completed",
      provider: renderEngineUsed,
      artifacts: {
        videoId,
        sceneCount: scenes.length,
        renderStrategy: renderEngineUsed === "revideo" ? "REVIDEO" : renderDecision.strategy,
        fastPathEligible: renderDecision.fastPathEligible,
        fallbackReason: renderFallbackReason,
      },
      timingMs: Date.now() - renderStartedAt,
    });

    // Revideo draws captions itself (timelineScene.tsx - including Arabic
    // RTL shaping via a bundled font, see section 9), from the same
    // sceneCaptionWords used above - never route it through the libass burn
    // pass too, or captions would be drawn twice.
    if (burnCaptionsWithLibass && renderEngineUsed !== "ffmpeg_fast" && renderEngineUsed !== "hybrid_ffmpeg" && renderEngineUsed !== "revideo") {
      const burnStartedAt = Date.now();
      await this.emitProgress(onProgress, {
        status: "rendering",
        progress: 90,
        currentStage: "Captions",
        message: "Burning Arabic captions with libass.",
        stageKey: "render",
        checkpointStatus: "running",
      });
      // Scene captions are scene-relative; shift them onto the video timeline.
      const sceneStartMs = scenes.map((_s, i) =>
        scenes.slice(0, i).reduce((acc, curr) => acc + (curr.audio?.duration || 0) * 1000, 0),
      );
      const timelineWords = sceneCaptionWords.flatMap((words, sceneIndex) => {
        const offsetMs = Math.round(sceneStartMs[sceneIndex] || 0);
        return (words || [])
          .map((word) => ({
            text: word.text.trim(),
            startMs: offsetMs + word.startMs,
            endMs: offsetMs + word.endMs,
          }))
          .filter((word) => word.text.length > 0);
      });

      if (timelineWords.length > 0) {
        const frame = { width: orientation === "portrait" ? 1080 : 1920, height: orientation === "portrait" ? 1920 : 1080 };
        const built = renderArabicCaptions(
          timelineWords,
          spec.captionStyle as string,
          frame,
          // Keep clear of the TikTok/Reels bottom UI band.
          PLATFORM_SAFE_BOTTOM_RATIO,
        );
        captionQaResult = runCaptionQa(built, {
          style: captionStyleSpec,
          frame,
          platformSafeBottomRatio: PLATFORM_SAFE_BOTTOM_RATIO,
        });
        const assPath = path.join(this.config.tempDirPath, `${videoId}.captions.ass`);
        fs.writeFileSync(assPath, built.content, "utf8");
        const renderedPath = this.getVideoPath(videoId);
        const burnedPath = path.join(this.config.tempDirPath, `${videoId}.captioned.mp4`);
        try {
          await this.ffmpeg.burnAssSubtitles(renderedPath, assPath, burnedPath, fontsDir);
          fs.moveSync(burnedPath, renderedPath, { overwrite: true });
          captionRenderer = "libass";
          captionFontFamily = built.fontFamily;
        } catch (burnErr) {
          // A failed burn must not lose the video; keep the Remotion output.
          logger.error(burnErr, "libass caption burn failed; keeping the uncaptioned Remotion render");
        } finally {
          if (fs.existsSync(burnedPath)) fs.removeSync(burnedPath);
          if (fs.existsSync(assPath)) fs.removeSync(assPath);
        }
      }
      await this.emitProgress(onProgress, {
        status: "rendering",
        progress: 92,
        currentStage: "Captions",
        message: captionRenderer === "libass" ? "Arabic captions burned." : "Caption burn skipped.",
        stageKey: "render",
        checkpointStatus: "completed",
        provider: captionRenderer,
        timingMs: Date.now() - burnStartedAt,
      });
    }

    const validationStartedAt = Date.now();
    await this.emitProgress(onProgress, {
      status: "finalizing",
      progress: 94,
      currentStage: "Finalizing",
      message: "Generating thumbnail cover and validating output quality.",
      stageKey: "validation",
      checkpointStatus: "running",
      inputHashSource: { videoId, requestedDuration: timeline.requestedDurationSeconds },
    });

    for (const file of tempFiles) {
      fs.removeSync(file);
    }

    try {
      const videoPath = this.getVideoPath(videoId);
      const thumbnailPath = path.join(this.config.videosDirPath, `${videoId}.thumb.jpg`);

      // Generate video cover thumbnail
      await this.ffmpeg.generateThumbnail(videoPath, thumbnailPath, 1.5);

      // Perform deterministic post-render quality validation against canonical requestedDurationSeconds
      const validationResult = await this.ffmpeg.validateRenderedVideo(
        videoPath,
        timeline.requestedDurationSeconds,
      );
      const blackFrameReport = await this.ffmpeg.analyzeBlackFrames(
        videoPath,
        validationResult.durationSeconds || timeline.requestedDurationSeconds,
      );
      const masteringStartedAt = Date.now();
      await this.emitProgress(onProgress, {
        status: "finalizing",
        progress: 96,
        currentStage: "Mastering final mix",
        message: "Measuring mastered final mix loudness and peak levels.",
        stageKey: "mastering",
        checkpointStatus: "running",
        provider: "ffmpeg",
        inputHashSource: { videoId, selectedMusic: selectedMusic.file },
      });
      const finalAudioQa = await this.audioMastering.validateFinalMix(videoPath);
      await this.emitProgress(onProgress, {
        status: "finalizing",
        progress: 97,
        currentStage: "Mastering completed",
        message: "Final mix mastering metrics recorded.",
        stageKey: "mastering",
        checkpointStatus: finalAudioQa.pass ? "completed" : "failed",
        provider: "ffmpeg",
        artifacts: {
          finalMixLufs: finalAudioQa.finalMixMetrics.integratedLufs,
          truePeakDbtp: finalAudioQa.finalMixMetrics.truePeakDbtp,
          clippingDetected: finalAudioQa.finalMixMetrics.clippingDetected,
        },
        timingMs: Date.now() - masteringStartedAt,
      });

      // Real final-mix silence gate (V2.4 Pass 4). `analyzeDeadAir` below only
      // ever compares PLANNED speech windows against a PLANNED hold budget -
      // a claim about what should happen. This measures the ACTUAL mixed
      // track with ffmpeg's silencedetect, the same way an independent
      // reviewer caught incident cmtehsptj000108ledzk3f3ji's ~4.5s/~5.3s/~4.8s
      // near-silent runs that the planning-only check could not see.
      const mixedSilenceGate = await this.audioMastering.analyzeMixedSilence(videoPath);

      const stats = fs.statSync(videoPath);
      const totalVoiceDuration = timeline.scenes.reduce(
        (sum, s) => sum + (s.actualSpeechDurationSeconds || s.durationSeconds),
        0,
      );

      const motionPresetsUsed = Array.from(
        new Set(
          scenes
            .flatMap((s) => (s.segments ? s.segments.map((seg: any) => seg.motion) : [s.motion]))
            .filter(Boolean),
        ),
      );
      const transitionPresetsUsed = Array.from(
        new Set(scenes.map((s) => s.transition).filter(Boolean)),
      );
      const mediaSegmentCount = scenes.reduce(
        (acc, s) => acc + (s.segments ? s.segments.length : 1),
        0,
      );

      const sceneStartMsForQa = scenes.map((_s, i) =>
        scenes.slice(0, i).reduce((acc, curr) => acc + (curr.audio?.duration || 0) * 1000, 0),
      );
      const speechWindowsForDeadAir = scenes.map((s, i) => {
        const sceneVisualSeconds = timeline.scenes[i]?.durationSeconds || (s.audio?.duration || 0);
        const sceneSpeechSeconds =
          timeline.scenes[i]?.actualSpeechDurationSeconds ??
          ((s.speechWindowsMs?.[0]?.endMs || (s.audio?.duration || 0) * 1000) / 1000);
        // Time this scene deliberately holds its motion/music past the narration.
        const intentionalHoldMs = Math.max(
          0,
          Math.round((sceneVisualSeconds - sceneSpeechSeconds - 0.16) * 1000),
        );
        return {
          sceneIndex: i,
          startMs: Math.round(sceneStartMsForQa[i] || 0),
          endMs: Math.round((sceneStartMsForQa[i] || 0) + sceneSpeechSeconds * 1000),
          intentionalHoldMs,
        };
      });
      const deadAirReport = this.audioMastering.analyzeDeadAir(speechWindowsForDeadAir);
      // The rendered-media measurement wins over planning metadata (same
      // principle as the visual coverage gate below): whichever check found
      // the worse gap is the one that gates the production.
      const effectiveMaxSilenceMs = Math.max(deadAirReport.maxNarrationSilenceMs, mixedSilenceGate.longestSilenceRunMs);

      const professionalVisualQuality = calculateProfessionalVisualQualityReport({
        spec,
        shots: plannedShots,
        selectedVisuals,
        totalDurationSeconds: validationResult.durationSeconds || totalDurationSeconds,
        blackFramePercent: blackFrameReport.blackFramePercent,
      });

      const creativeQualityResult = qualityEngine.calculateCreativeQualityScore({
        deadAirDurationMs: deadAirReport.totalNarrationSilenceMs,
        maxNarrationSilenceMs: effectiveMaxSilenceMs,
        totalDurationSeconds: validationResult.durationSeconds,
        sceneCount: scenes.length,
        distinctAssetCount: new Set(selectedVisuals.map((item) => item.metadata?.pexelsVideoId || item.url)).size,
        fallbackCount: selectedVisuals.filter((item) => item.metadata?.fallback || item.metadata?.fallbackReason).length,
        hasCta: spec.scenes.some((s) => s.purpose === "cta" || (spec.cta && spec.cta.text)),
        captionStyle: spec.captionStyle,
        hasCaptions: spec.captionStyle !== "none",
        mediaRelevanceScores: sceneQa.map((item) => Number(item.visualRelevanceScore) || 90),
        realVisualCoveragePercent: professionalVisualQuality.realVisualCoveragePercent,
        textOnlyTimelinePercent: professionalVisualQuality.textOnlyTimelinePercent,
        blackFramePercent: blackFrameReport.blackFramePercent,
        duplicateAssetCount: professionalVisualQuality.repeatedAssetCount,
        promptLeakCount: professionalVisualQuality.rawPromptLeakCount,
        inventedClaimRiskCount: professionalVisualQuality.inventedClaimRiskCount,
      });
      let mediaPlanScoreV24 = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            professionalVisualQuality.realVisualCoveragePercent * 0.24 +
            (100 - professionalVisualQuality.textOnlyTimelinePercent) * 0.16 +
            (100 - Math.min(100, blackFrameReport.blackFramePercent * 25)) * 0.16 +
            Math.min(100, professionalVisualQuality.averageSemanticScore || 70) * 0.18 +
            (professionalVisualQuality.repeatedAssetCount === 0 ? 100 : Math.max(30, 100 - professionalVisualQuality.repeatedAssetCount * 25)) * 0.12 +
            (selectedVisuals.filter((item) => item.metadata?.fallback || item.metadata?.fallbackReason).length === 0 ? 100 : 70) * 0.07 +
            (plannedShots.length >= Math.max(4, Math.floor((validationResult.durationSeconds || totalDurationSeconds) / 4)) ? 100 : 65) * 0.07,
          ),
        ),
      );
      // An explicit graphics-led production (Motion Graphics / Animated
      // Explainer) is not held to the real-visual-bed gate below, matching
      // `professionalVisualQuality.ts`'s own exemption.
      const isExplicitGraphicsMode =
        spec.productionMode === "motion_graphics" ||
        spec.productionMode === "animated_explainer" ||
        spec.visualMode === "motion_graphics" ||
        spec.visualMode === "animated_explainer";

      // Hard cap (V2.4 Pass 4, section 58): a professional Auto production
      // with ANY full-screen text/motion timeline in the rendered media
      // cannot score as a passing Professional Visual Score, no matter how
      // strong its other components are.
      if (!isExplicitGraphicsMode && professionalVisualQuality.textOnlyTimelinePercent > 0) {
        mediaPlanScoreV24 = Math.min(mediaPlanScoreV24, 59);
      }

      // V2.4 Pass 4 professional-ready gate (section 11): "ready" used to mean
      // only "an audio stream exists and isn't clipping/silent" - a video
      // could carry a full-screen CTA card and multi-second audio silence and
      // still ship as `status: "ready"` (incident cmtehsptj000108ledzk3f3ji:
      // `realVisualCoveragePercent: 26.1`, `readyForProfessionalAuto: false`,
      // yet the job completed as "ready" because nothing consulted that
      // report).
      const visualQualityPass = isExplicitGraphicsMode || professionalVisualQuality.readyForProfessionalAuto;
      const audioSilencePass = !mixedSilenceGate.criticalFailure;
      // TECHNICAL: the media itself is a valid, playable render. CONTENT: the
      // script that was actually spoken/burned is topical, complete, and not
      // generic filler - recomputed here (not just at job-creation time in
      // routes.ts) because a job can reach the render worker through paths
      // that never went through that gate (retries, internal APIs). Neither
      // technical nor content validity alone is "professional" - a technically
      // perfect render of a meaningless script is exactly the defect this
      // separation exists to catch.
      const scriptQuality = validateScriptQuality(
        String(spec.userPrompt || ""),
        spec.scenes || [],
        spec.cta,
        spec.language === "ar" ? "ar" : "en",
      );
      const technicalReady = finalAudioQa.pass && audioSilencePass && visualQualityPass;
      const contentReady = scriptQuality.pass;
      const professionalReady = technicalReady && contentReady;

      // V2.5.1: the same signals, now separated by CONSEQUENCE rather than
      // merged into one boolean. `professionalReady` above stays exactly as
      // it was (it is what "this production met every bar" means and is still
      // reported truthfully); what changes is that a production which only
      // missed a *creative* bar keeps its valid render and lands in
      // `needs_review` instead of throwing away a playable 1080p file.
      // See `finalQualityContract.ts` for the incident this fixes.
      const finalQuality = assessFinalQuality({
        container: {
          exists: validationResult.hasVideoStream || fs.existsSync(videoPath),
          hasVideoStream: validationResult.hasVideoStream,
          hasAudioStream: validationResult.hasAudioStream,
          durationSeconds: validationResult.durationSeconds,
        },
        // Every production in this engine narrates; a container with no audio
        // stream is a broken render rather than a stylistic choice.
        narrationExpected: true,
        audioMasteringPass: finalAudioQa.pass,
        audioSilenceCriticalFailure: mixedSilenceGate.criticalFailure,
        blackFramePercent: blackFrameReport.blackFramePercent,
        visualIssues: isExplicitGraphicsMode ? [] : professionalVisualQuality.issues,
        realVisualCoveragePercent: professionalVisualQuality.realVisualCoveragePercent,
        textOnlyTimelinePercent: professionalVisualQuality.textOnlyTimelinePercent,
        repeatedAssetCount: professionalVisualQuality.repeatedAssetCount,
        scriptQualityPass: scriptQuality.pass,
        scriptQualityReason: scriptQuality.reason,
      });
      const readinessFailureReasons: string[] = finalQuality.findings.map(
        (item) => item.technicalDetail,
      );

      // V2.4 Pass 5 wall-clock accounting: the OpenCLIP pool's init cost is
      // only paid once per render-worker process lifetime (it stays warm
      // across renders), so it is read here rather than measured per-render.
      const openClipPool = getSharedOpenClipWorkerPool();
      if (openClipPool?.getInitMs() != null) {
        perfAccumulatorMs.openClipPoolInitMs = openClipPool!.getInitMs()!;
      }
      perfAccumulatorMs.visualCompositionMs = compositionMs;
      perfAccumulatorMs.finalEncodeMs = finalEncodeMs;
      perfAccumulatorMs.remotionMs =
        renderEngineUsed === "remotion" || renderEngineUsed === "remotion_fallback"
          ? compositionMs
          : 0;
      perfAccumulatorMs.ffmpegMs =
        renderEngineUsed === "ffmpeg_fast" || renderEngineUsed === "hybrid_ffmpeg"
          ? compositionMs
          : 0;

      const metadata: VideoMetadata = {
        videoId,
        filename: `${videoId}.mp4`,
        thumbnailUrl: `/api/videos/${videoId}/thumbnail`,
        // "failed" only when the file itself is unusable. A valid render that
        // merely missed a creative bar is "needs_review" and keeps its output.
        status:
          finalQuality.outcome === "failed"
            ? "failed"
            : finalQuality.outcome === "needs_review"
              ? "needs_review"
              : "ready",
        error: finalQuality.findings.length ? readinessFailureReasons.join(" ") : undefined,
        finalQuality,
        professionalReady,
        mixedSilenceGate: mixedSilenceGate as unknown as Record<string, unknown>,
        // renderDecision.strategy is computed unconditionally before the
        // VIDEO_RENDER_ENGINE branch (see above) and never reflects it - it
        // would otherwise misreport a Revideo-rendered video as
        // "REMOTION_FULL" in its own metadata sidecar, exactly the kind of
        // false record the Revideo evaluation's audit trail depends on not
        // having. renderEngineUsed is the actual, post-render truth.
        renderStrategy: renderEngineUsed === "revideo" ? "REVIDEO" : renderDecision.strategy,
        rendererVersion: renderEngineUsed === "revideo" ? "revideo-0.11.0" : "hybrid-fast-v1",
        fastPathEligible: renderDecision.fastPathEligible,
        fastPathUsed: renderEngineUsed === "ffmpeg_fast" || renderEngineUsed === "hybrid_ffmpeg",
        renderFallbackReason,
        compositionMs,
        finalEncodeMs,
        remotionFramesRendered,
        baseFootageFramesThroughChromium: remotionFramesRendered,
        detailedStageTimings: perfAccumulatorMs,
        detailedStageCounts: perfCounts,
        creationMode: spec.creationMode,
        originalPrompt: spec.userPrompt,
        templateId: spec.templateId,
        templateName: spec.templateId || spec.title,
        brandName: spec.brandKit?.brandName,
        watermarkText: spec.brandKit?.watermarkText,
        captionStyle: spec.captionStyle,
        captionProfileUsed: mediaPlan.captionPreset || spec.captionStyle || "bold",
        captionRenderer,
        // Canonical shot plan: what the viewer actually looks at, and why.
        // The creative plan that produced this edit, kept so a rejected video
        // can be explained rather than guessed at.
        creativePlan,
        creativeFacts: creativePlanFacts(creativePlan),
        editDecisionList: {
          version: 'edl.v1',
          totalDurationSeconds,
          shots: plannedShots,
          averageShotSeconds: plannedShots.length
            ? Number((totalDurationSeconds / plannedShots.length).toFixed(2))
            : 0,
          sourceTypeCounts: shotSourceCounts,
          beatMapUsed: beatTimestamps.length > 0,
          // How many cuts actually landed on a detected beat, as opposed to how
          // many beats were available. Reporting only `beatMapUsed` hid the case
          // where a beat map was produced and then influenced nothing.
          beatAlignedCutCount: plannedShots.filter((shot) => typeof shot.beatHint === "number").length,
          beatCount: beatTimestamps.length,
          bpm: beatMap?.bpm,
          pacingProfile: 'editorial_ad',
        },
        visualShotCount: plannedShots.length,
        visualIntentPolicy: visualIntentPolicyLog.length > 0 ? visualIntentPolicyLog : undefined,
        // Which visual angles were asked for, what came back and which clip won.
        stockQueryPlan: stockQueryLog.length > 0 ? stockQueryLog : undefined,
        // What the Brand Profile actually contributed, field by field, so the
        // UI never implies the engine knew a brand colour it was never given.
        brandStyle: {
          hasBrand: brandStyle.hasBrand,
          presence: brandStyle.presence,
          palette: brandStyle.palette,
          sources: brandStyle.sources,
          contrast: brandStyle.contrast,
          contrastCorrections: brandStyle.contrastCorrections,
        },
        sourceTypeCounts: shotSourceCounts,
        // Where the picture actually came from, recorded so "was my media used?"
        // is answered by the finished video rather than by the form that
        // requested it.
        mediaProvenance: {
          mode: customerMediaPlan.mode,
          stockProvidersBlocked: customerMediaPlan.stockProvidersBlocked,
          customerMediaIds: Array.from(
            new Set(
              selectedVisuals
                .filter((item) => item.provider === CUSTOMER_MEDIA_PROVIDER)
                .map((item) => String(item.metadata?.customerMediaId || "")),
            ),
          ).filter(Boolean),
          customerMediaShotCount: shotSourceCounts.upload || 0,
          stockShotCount: shotSourceCounts.stock || 0,
          providers: Array.from(visualProvidersUsed),
          unusableSelectedMediaIds: customerMediaPlan.unusableIds,
        },
        captionFont: captionFontFamily,
        captionStyleId: captionStyleSpec.id,
        captionQa: captionQaResult || undefined,
        musicTrack: selectedMusic.file,
        musicMood: selectedMusic.mood,
        motionPresetsUsed,
        transitionPresetsUsed,
        mediaSegmentCount,
        language: spec.language,
        dialect: spec.dialect,
        quality: spec.quality,
        resolution: spec.resolution,
        aspectRatio: spec.aspectRatio,
        visualMode: spec.visualMode,
        aiProvider: spec.metadata?.planner ? String(spec.metadata.planner) : undefined,
        visualProvidersUsed: Array.from(visualProvidersUsed),
        voiceProvider: spec.voiceProvider,
        voiceProvidersUsed: Array.from(voiceProvidersUsed) as any,
        // Caption timing provenance, so Video Details can state how the words
        // were timed rather than implying Whisper for every production.
        captionTimingSource: captionTimingSources.size === 1
          ? Array.from(captionTimingSources)[0]
          : Array.from(captionTimingSources).join('+') || 'deterministic_fallback',
        captionTimingSources: Array.from(captionTimingSources),
        // Every timing path burns the canonical narration script - never a
        // transcription - so this is constant, but persisted explicitly per
        // the caption-fidelity contract rather than left implicit.
        captionTextSource: "canonical_narration",
        // Worst-case (minimum) across scenes: a single badly-aligned scene
        // must not be hidden behind an average that looks fine.
        captionScriptSimilarity: voiceArtifacts.reduce((min: number | undefined, v: any) =>
          typeof v.captionScriptSimilarity === "number" ? Math.min(min ?? 1, v.captionScriptSimilarity) : min,
          undefined as number | undefined),
        captionAlignmentConfidence: voiceArtifacts.reduce((min: number | undefined, v: any) =>
          typeof v.captionAlignmentConfidence === "number" ? Math.min(min ?? 1, v.captionAlignmentConfidence) : min,
          undefined as number | undefined),
        voiceArtifacts,
        costEstimate: spec.costEstimate as any,
        productionSpec: spec as any,
        timeline: timeline as any,
        mediaPlan: mediaPlan as any,
        sceneSourceDecisions,
        postProductionProcessors,
        selectedVisuals,
        professionalVisualQuality,
        realVisualCoveragePercent: professionalVisualQuality.realVisualCoveragePercent,
        providerMix: professionalVisualQuality.providerMix,
        uniqueShotCount: professionalVisualQuality.uniqueShotCount,
        uniqueAssetCount: professionalVisualQuality.uniqueAssetCount,
        repeatedAssetCount: professionalVisualQuality.repeatedAssetCount,
        averageSemanticScore: professionalVisualQuality.averageSemanticScore,
        minimumSemanticScore: professionalVisualQuality.minimumSemanticScore,
        blackFramePercent: professionalVisualQuality.blackFramePercent,
        longestBlackRunMs: blackFrameReport.longestBlackRunMs,
        blackFrameReport,
        textOnlyTimelinePercent: professionalVisualQuality.textOnlyTimelinePercent,
        generatedTimelinePercent: professionalVisualQuality.generatedTimelinePercent,
        stockTimelinePercent: professionalVisualQuality.stockTimelinePercent,
        uploadedTimelinePercent: professionalVisualQuality.uploadedTimelinePercent,
        motionOverlayPercent: professionalVisualQuality.motionOverlayPercent,
        rawPromptLeakCount: professionalVisualQuality.rawPromptLeakCount,
        inventedClaimRiskCount: professionalVisualQuality.inventedClaimRiskCount,
        sceneQa,
        beatMap: beatMap || undefined,
        durableArtifacts,
        artifactReuse: {
          reusedStages: revision.reuseStages || [],
          regeneratedStages: revision.regeneratedStages || [],
          reusedArtifacts: artifactReuse.reusedArtifacts,
          regeneratedArtifacts: artifactReuse.regeneratedArtifacts,
          providerInvocations: artifactReuse.providerInvocations,
        },
        schemaVersion: "ProductionSpecV3",
        revisionMetadata: revision,
        stageTimings: {
          totalMs: Date.now() - totalStartedAt,
          renderMs: compositionMs,
          visualCompositionMs: compositionMs,
          finalEncodeMs,
          validationMs: Date.now() - validationStartedAt,
        },
        qualityScore: validationResult.technicalScore,
        technicalScore: validationResult.technicalScore,
        creativeScore: creativeQualityResult.creativeScore,
        creativeGrade: creativeQualityResult.creativeGrade,
        creativeDiagnostics: creativeQualityResult.diagnostics,
        creativeWarnings: creativeQualityResult.warnings,
        // Human-visible quality metrics (deterministic/explainable - see
        // scriptQuality.ts and qualityEngine.ts; visualRelevanceScore/
        // sceneCoherenceScore/audioContinuityScore reuse the same keyword-
        // relevance and audio-continuity signals already computed above
        // under their existing names, surfaced here for direct visibility).
        technicalReady,
        contentReady,
        topicRelevanceScore: scriptQuality.topicRelevanceScore,
        genericFillerDetected: scriptQuality.genericFillerDetected,
        scriptCompleteness: scriptQuality.scriptCompleteness,
        ctaCompleteness: spec.cta?.text ? validateSentenceCompleteness(String(spec.cta.text), spec.language === "ar" ? "ar" : "en").complete : true,
        visualRelevanceScore: professionalVisualQuality.averageSemanticScore,
        // Honest signal-type label (section 15 of the Revideo real-content
        // proof review): "visual_semantic" only when real frame-level
        // OpenCLIP analysis actually ran; "metadata_relevance" when it fell
        // back to the lexical/keyword pre-score (e.g. opencv unavailable) -
        // never silently reported as if it were a validated visual check.
        visualRelevanceMethod: professionalVisualQuality.visualRelevanceMethod,
        sceneCoherenceScore: creativeQualityResult.diagnostics.visualDiversityScore,
        audioContinuityScore: creativeQualityResult.diagnostics.audioContinuityScore,
        maxNarrationSilenceMs: deadAirReport.maxNarrationSilenceMs,
        deadAirReport,
        mediaPlanScore: mediaPlanScoreV24,
        mediaPlanScoreV24: {
          score: mediaPlanScoreV24,
          previousPlannerScore: mediaPlan.qualityReview?.overallScore,
          components: {
            realVisualCoveragePercent: professionalVisualQuality.realVisualCoveragePercent,
            textOnlyTimelinePercent: professionalVisualQuality.textOnlyTimelinePercent,
            blackFramePercent: blackFrameReport.blackFramePercent,
            averageSemanticScore: professionalVisualQuality.averageSemanticScore,
            repeatedAssetCount: professionalVisualQuality.repeatedAssetCount,
            plannedShotCount: plannedShots.length,
          },
        },
        qualityScoreV2: {
          technical: validationResult.technicalScore,
          audioQa: finalAudioQa.pass ? 100 : 0,
          duration: Math.max(0, 100 - Math.round(Math.abs(validationResult.durationVariance) * 10)),
          captionAlignment: voiceArtifacts.every((artifact) => artifact.timingSource !== "synthetic_fallback") ? 90 : 55,
          mediaTechnicalQuality: Math.round(sceneQa.reduce((sum, item) => sum + (item.assetReadable ? 90 : 30), 0) / Math.max(1, sceneQa.length)),
          mediaRelevance: Math.round(sceneQa.reduce((sum, item) => sum + (Number(item.visualRelevanceScore) || 70), 0) / Math.max(1, sceneQa.length)),
          mediaDiversity: selectedVisuals.length === new Set(selectedVisuals.map((item) => item.metadata?.pexelsVideoId || item.url)).size ? 95 : 65,
          visualProfessionalReadiness: professionalVisualQuality.readyForProfessionalAuto ? 100 : 55,
          subjectiveQuality: "Human Review Required",
        },
        overallProductionScore: undefined,
        validationResult: validationResult as any,
        audioQa: {
          pass: finalAudioQa.pass,
          issues: finalAudioQa.issues,
          stream: finalAudioQa.stream,
          finalMixLufs: finalAudioQa.finalMixMetrics.integratedLufs,
          truePeakDbtp: finalAudioQa.finalMixMetrics.truePeakDbtp,
          clippingDetected: finalAudioQa.finalMixMetrics.clippingDetected,
          effectivelySilent: finalAudioQa.finalMixMetrics.effectivelySilent,
          loudnessTargetMet: finalAudioQa.loudnessTargetMet,
          duckingProfile: "balanced",
        },
        createdAt: stats.mtime.toISOString(),
        updatedAt: new Date().toISOString(),
        durationSeconds: validationResult.durationSeconds,
        requestedDurationSeconds: timeline.requestedDurationSeconds,
        resolvedDurationSeconds: timeline.finalExpectedDurationSeconds,
        voiceDurationSeconds: Math.round(totalVoiceDuration * 100) / 100,
        finalDurationSeconds: validationResult.durationSeconds,
        durationVarianceSeconds: validationResult.durationVariance,
        durationVariancePercent: (validationResult as any).durationVariancePercent,
        sizeBytes: stats.size,
        pexelsTerms: spec.scenes.flatMap((s) => s.stockSearchTerms || []),
        narrationLines: timeline.scenes.map((s) => s.narration),
        spokenNarrationLines: voiceArtifacts.map((artifact) => artifact.processedText).filter(Boolean),
        downloadUrl: `/api/videos/${videoId}/download`,
        previewUrl: `/api/short-video/${videoId}`,
      };
      writeMetadata(this.config.videosDirPath, metadata);
      await this.emitProgress(onProgress, {
        status: "finalizing",
        progress: 98,
        currentStage: "Validation completed",
        message: "Objective final QA completed.",
        stageKey: "validation",
        checkpointStatus: finalAudioQa.pass ? "completed" : "failed",
        provider: "ffmpeg",
        artifacts: { videoId, thumbnailPath, audioQa: metadata.audioQa, validationResult },
        timingMs: Date.now() - validationStartedAt,
      });
      if (!finalAudioQa.pass) {
        throw new Error(`Audio QA gate failed: ${finalAudioQa.issues.join("; ")}`);
      }
      logger.info(
        {
          videoId,
          actualFinalDuration: validationResult.durationSeconds,
          requestedDuration: timeline.requestedDurationSeconds,
          durationVariance: validationResult.durationVariance,
          technicalScore: validationResult.technicalScore,
          mediaPlanScore: metadata.mediaPlanScore,
          overallScore: metadata.overallProductionScore,
          musicTrack: metadata.musicTrack,
          musicMood: metadata.musicMood,
        },
        "Successfully saved video metadata sidecar with Media Intelligence and Thumbnail verification",
      );
    } catch (metaErr) {
      logger.error(metaErr, "Failed to save video metadata sidecar");
      throw metaErr;
    }

    return videoId;
  }

  private localPathForMediaUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    if (url.startsWith("file://")) return url.replace("file://", "");
    if (path.isAbsolute(url)) return url;

    try {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/api/tmp/")) {
        return path.join(this.config.tempDirPath, decodeURIComponent(path.basename(parsed.pathname)));
      }
      if (parsed.pathname.startsWith("/api/music/")) {
        return path.join(this.config.musicDirPath, decodeURIComponent(path.basename(parsed.pathname)));
      }
    } catch {
      // Not a URL.
    }
    return undefined;
  }

  private fastRenderClipsFromScenes(scenes: any[]): FastRenderClip[] {
    const clips: FastRenderClip[] = [];
    scenes.forEach((scene) => {
      if (Array.isArray(scene.segments) && scene.segments.length > 0) {
        scene.segments.forEach((segment: any) => {
          const segmentPath = this.localPathForMediaUrl(segment.video);
          if (!segmentPath || !fs.existsSync(segmentPath)) {
            throw new Error("A selected video segment is not available for fast rendering.");
          }
          clips.push({
            path: segmentPath,
            durationSeconds: Number(segment.duration) || Number(scene.audio?.duration) || 1,
            transition: scene.transition,
          });
        });
        return;
      }

      const scenePath = this.localPathForMediaUrl(scene.video);
      if (!scenePath || !fs.existsSync(scenePath)) {
        throw new Error("A selected scene video is not available for fast rendering.");
      }
      clips.push({
        path: scenePath,
        durationSeconds: Number(scene.audio?.duration) || 1,
        transition: scene.transition,
      });
    });
    return clips;
  }

  private fastRenderVoicesFromScenes(scenes: any[]): FastRenderVoice[] {
    return scenes.map((scene) => {
      const audioPath = this.localPathForMediaUrl(scene.audio?.url);
      if (!audioPath || !fs.existsSync(audioPath)) {
        throw new Error("A selected narration track is not available for fast rendering.");
      }
      return {
        path: audioPath,
        durationSeconds: Number(scene.audio?.duration) || 1,
      };
    });
  }

  private createTimelineCaptionAss(input: {
    videoId: string;
    scenes: any[];
    sceneCaptionWords: Array<Array<{ text: string; startMs: number; endMs: number }>>;
    captionStyleId: string;
    orientation: OrientationEnum;
    captionStyleSpec: unknown;
    fontsDir: string;
    tempFiles: string[];
  }): { path: string; fontFamily: string; qa: any } | undefined {
    const sceneStartMs = input.scenes.map((_s, i) =>
      input.scenes.slice(0, i).reduce((acc, curr) => acc + (curr.audio?.duration || 0) * 1000, 0),
    );
    const timelineWords = input.sceneCaptionWords.flatMap((words, sceneIndex) => {
      const offsetMs = Math.round(sceneStartMs[sceneIndex] || 0);
      return (words || [])
        .map((word) => ({
          text: word.text.trim(),
          startMs: offsetMs + word.startMs,
          endMs: offsetMs + word.endMs,
        }))
        .filter((word) => word.text.length > 0);
    });

    if (timelineWords.length === 0) return undefined;
    const frame = {
      width: input.orientation === OrientationEnum.portrait ? 1080 : 1920,
      height: input.orientation === OrientationEnum.portrait ? 1920 : 1080,
    };
    const built = renderArabicCaptions(
      timelineWords,
      input.captionStyleId,
      frame,
      PLATFORM_SAFE_BOTTOM_RATIO,
    );
    const qa = runCaptionQa(built, {
      style: input.captionStyleSpec as any,
      frame,
      platformSafeBottomRatio: PLATFORM_SAFE_BOTTOM_RATIO,
    });
    const assPath = path.join(this.config.tempDirPath, `${input.videoId}.captions.ass`);
    fs.writeFileSync(assPath, built.content, "utf8");
    input.tempFiles.push(assPath);
    return { path: assPath, fontFamily: built.fontFamily, qa };
  }

  /**
   * Resolve the customer's Media Library selection into a per-scene plan.
   *
   * Reads the same `metadata.selectedMediaIds` Create Video writes and the same
   * `visualSource` / `mediaPolicy` the request carried, so the plan reflects
   * what the customer actually asked for rather than a re-derived guess.
   */
  private async planCustomerMediaForSpec(spec: ProductionSpec): Promise<CustomerMediaPlan> {
    const metadata = (spec.metadata || {}) as any;
    const contract = metadata.uiContract || {};
    const selectedIds: string[] = Array.from(
      new Set(
        [
          ...(Array.isArray(metadata.selectedMediaIds) ? metadata.selectedMediaIds : []),
          ...(Array.isArray(contract.selectedMediaIds) ? contract.selectedMediaIds : []),
          metadata.uploadedMediaId,
          metadata.productImageId,
        ]
          .filter((value) => typeof value === "string" && value.trim().length > 0)
          .map((value) => String(value).trim()),
      ),
    );
    const mode = resolveCustomerMediaMode({
      visualSource: contract.visualSource || (spec as any).visualSource,
      mediaPolicy: contract.mediaPolicy || metadata.mediaPolicy,
      productionMode: spec.productionMode,
    });
    if (mode === "automatic" || selectedIds.length === 0) {
      return planCustomerMedia({ mode: "automatic", selectedIds: [], candidates: [], sceneCount: 0 });
    }

    const mediaService = new MediaUploadService(this.config.dataDirPath);
    const candidates: CustomerMediaCandidate[] = [];
    for (const id of selectedIds) {
      const asset = await mediaService.getAsset(id).catch(() => null);
      if (!asset) continue;
      candidates.push({
        id: asset.id,
        storagePath: asset.storagePath,
        mediaType: asset.mediaType,
        // The library's own usability verdict is authoritative: a 1x1 pixel PNG
        // is a structurally valid image and still cannot carry a scene.
        usable: asset.status === "ready" && asset.usable !== false && asset.usability?.usableForVideo !== false,
        durationSeconds: asset.durationSeconds,
        width: asset.width,
        height: asset.height,
        displayName: asset.displayName || asset.originalName,
      });
    }

    return planCustomerMedia({
      mode,
      selectedIds,
      candidates,
      sceneCount: spec.scenes.length,
    });
  }

  /**
   * Turn one customer asset into a scene-ready silent clip.
   *
   * Returns a `ResolvedSceneAsset` shaped exactly like a stock result so every
   * downstream consumer - shot accounting, the quality report, the EDL - sees
   * customer media as a first-class visual source rather than a special case.
   */
  private async resolveCustomerSceneAsset(
    assignment: CustomerSceneAssignment,
    targetDurationSeconds: number,
    orientation: OrientationEnum,
  ): Promise<ResolvedSceneAsset | null> {
    if (!fs.existsSync(assignment.storagePath)) {
      logger.warn(
        { assetId: assignment.assetId, sceneIndex: assignment.sceneIndex },
        "Selected customer media is missing on disk; scene will route normally",
      );
      return null;
    }
    const landscape = orientation === OrientationEnum.landscape;
    const width = landscape ? 1920 : 1080;
    const height = landscape ? 1080 : 1920;
    const duration = Math.max(0.8, targetDurationSeconds || 4);
    const clipPath = path.join(
      this.config.tempDirPath,
      `customer_${assignment.assetId}_${assignment.sceneIndex}_${Math.round(duration * 100)}_${width}x${height}.mp4`,
    );
    try {
      if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size === 0) {
        if (assignment.mediaType === "video") {
          await this.ffmpeg.createClipFromVideo(assignment.storagePath, clipPath, duration, width, height);
        } else {
          await this.ffmpeg.createClipFromImage(assignment.storagePath, clipPath, duration, width, height);
        }
      }
    } catch (err) {
      logger.warn(
        { err, assetId: assignment.assetId, sceneIndex: assignment.sceneIndex },
        "Could not prepare selected customer media for this scene",
      );
      return null;
    }
    if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size === 0) return null;

    return {
      sceneIndex: assignment.sceneIndex,
      provider: CUSTOMER_MEDIA_PROVIDER,
      source: "uploaded",
      url: clipPath,
      durationSeconds: duration,
      fallbackUsed: false,
      estimatedCost: 0,
      metadata: {
        // Provenance the finished video's metadata carries, so "was my media
        // actually used?" is answerable from the output rather than the form.
        providerAssetId: assignment.assetId,
        customerMediaId: assignment.assetId,
        customerMediaName: assignment.displayName,
        customerMediaRepeated: assignment.repeated,
        sourceMediaType: assignment.mediaType,
        width,
        height,
        // Customer media is chosen by the customer, not scored against the
        // narration, so it is never presented as semantically verified.
        semanticAvailable: false,
        semanticScore: 100,
        selectedScore: 100,
      },
    };
  }

  private static readonly downloadAgent = new https.Agent({ keepAlive: true, family: 4 });

  private async downloadFile(url: string, destPath: string, maxRetries = 3): Promise<void> {
    if (url.startsWith("file://") || url.startsWith("/")) {
      fs.copySync(url.replace("file://", ""), destPath);
      return;
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await fs.ensureDir(path.dirname(destPath));
        const curlArgs = [
          "-sSL",
          "--max-time", "120",
          "--connect-timeout", "15",
          "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "-o", destPath,
          "-w", "%{content_type}",
          url,
        ];
        const { stdout: contentType } = await execAsync(`curl ${curlArgs.map(a => `"${a}"`).join(" ")}`, { timeout: 150000, windowsHide: true });
        const expectsVideo = path.extname(destPath).toLowerCase() === ".mp4";
        if (
          expectsVideo &&
          contentType &&
          !contentType.includes("video/") &&
          !contentType.includes("octet-stream") &&
          !contentType.includes("application/mp4")
        ) {
          throw new Error(`Provider returned non-video content type: ${contentType}`);
        }

        if (expectsVideo) {
          const validation = await this.ffmpeg.validateDownloadedVideoAsset(destPath);
          if (!validation.valid) {
            fs.removeSync(destPath);
            throw new Error(`Downloaded provider video failed validation: ${validation.issues.join("; ")}`);
          }
        }

        return;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(
          { attempt, maxRetries, url, error: lastError.message },
          "Download attempt failed; retrying...",
        );
        fs.removeSync(destPath);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    throw lastError || new Error(`Failed to download file from ${url}`);
  }

  private async emitProgress(
    callback: RenderProgressCallback | undefined,
    event: RenderProgressEvent,
  ): Promise<void> {
    if (!callback) return;
    try {
      await callback(event);
    } catch {
      // Progress reporting is advisory and must never interrupt video rendering
    }
  }

  private saveFailureMetadata(
    videoId: string,
    spec: ProductionSpec,
    error: unknown,
  ): void {
    const brandKit = spec.brandKit;
    const metadata: VideoMetadata = {
      videoId,
      filename: `${videoId}.mp4`,
      status: "failed",
      creationMode: spec.creationMode,
      originalPrompt: spec.userPrompt,
      templateId: spec.templateId,
      templateName: spec.title,
      brandName: brandKit?.brandName,
      watermarkText: brandKit?.watermarkText,
      captionStyle: spec.captionStyle,
      language: spec.language,
      dialect: spec.dialect,
      quality: spec.quality,
      resolution: spec.resolution,
      aspectRatio: spec.aspectRatio,
      visualMode: spec.visualMode,
      voiceProvider: spec.voiceProvider,
      costEstimate: spec.costEstimate as any,
      productionSpec: spec as any,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      downloadUrl: `/api/videos/${videoId}/download`,
      previewUrl: `/api/short-video/${videoId}`,
    };
    writeMetadata(this.config.videosDirPath, metadata);
  }

  public getThumbnailPath(videoId: string): string {
    return path.join(this.config.videosDirPath, `${videoId}.thumb.jpg`);
  }

  /**
   * Produces the cover image for an already-rendered video.
   *
   * Videos made before cover generation existed have a valid MP4 but no
   * thumbnail, so the library used to show a broken image for them. This is
   * called on demand for those, and the result is cached on disk so the work
   * happens once rather than on every request.
   *
   * Writes to a temporary file and renames it into place, so a concurrent
   * request can never observe a half-written JPEG.
   */
  public async ensureThumbnail(videoId: string): Promise<string | null> {
    const thumbnailPath = this.getThumbnailPath(videoId);
    if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
      return thumbnailPath;
    }

    const videoPath = this.getVideoPath(videoId);
    if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size === 0) return null;

    const pendingPath = path.join(
      this.config.videosDirPath,
      `${videoId}.thumb.pending-${process.pid}.jpg`,
    );
    try {
      await this.ffmpeg.generateThumbnail(videoPath, pendingPath, 1.5);
      if (!fs.existsSync(pendingPath) || fs.statSync(pendingPath).size === 0) return null;
      fs.moveSync(pendingPath, thumbnailPath, { overwrite: true });
      return thumbnailPath;
    } catch (error) {
      logger.warn({ err: String(error), videoId }, "On-demand thumbnail generation failed");
      return null;
    } finally {
      if (fs.existsSync(pendingPath)) {
        try { fs.removeSync(pendingPath); } catch { /* best effort */ }
      }
    }
  }

  public getVideoPath(videoId: string): string {
    return path.join(this.config.videosDirPath, `${videoId}.mp4`);
  }

  public deleteVideo(videoId: string): void {
    const videoPath = this.getVideoPath(videoId);
    fs.removeSync(videoPath);
    deleteMetadata(this.config.videosDirPath, videoId);
    logger.debug({ videoId }, "Deleted video file and metadata");
  }

  public getVideo(videoId: string): Buffer {
    const videoPath = this.getVideoPath(videoId);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video ${videoId} not found`);
    }
    return fs.readFileSync(videoPath);
  }

  private findMusic(videoDuration: number, tag?: MusicMoodEnum): MusicForVideo {
    const musicFiles = this.musicManager.musicList().filter((music) => {
      if (tag) {
        return music.mood === tag;
      }
      return true;
    });
    return musicFiles[Math.floor(Math.random() * musicFiles.length)];
  }

  public ListAvailableMusicTags(): MusicTag[] {
    const tags = new Set<MusicTag>();
    this.musicManager.musicList().forEach((music) => {
      tags.add(music.mood as MusicTag);
    });
    return Array.from(tags.values());
  }

  public listAllVideos(): { id: string; status: VideoStatus }[] {
    const videos: { id: string; status: VideoStatus }[] = [];
    if (!fs.existsSync(this.config.videosDirPath)) {
      return videos;
    }
    const files = fs.readdirSync(this.config.videosDirPath);
    for (const file of files) {
      if (file.endsWith(".mp4")) {
        const videoId = file.replace(".mp4", "");
        let status: VideoStatus = "ready";
        const inQueue = this.queue.find((item) => item.id === videoId);
        if (inQueue) {
          status = "processing";
        }
        videos.push({ id: videoId, status });
      }
    }
    for (const queueItem of this.queue) {
      const existingVideo = videos.find((v) => v.id === queueItem.id);
      if (!existingVideo) {
        videos.push({ id: queueItem.id, status: "processing" });
      }
    }
    return videos;
  }

  public ListAvailableVoices(): string[] {
    return this.kokoro.listAvailableVoices();
  }

  public async previewVoice(input: {
    text: string;
    language?: string;
    dialect?: any;
    qualityProfile?: VoiceQualityProfile;
    provider?: VoiceProviderId | "auto";
    voiceId?: string;
    pronunciationDictionary?: Record<string, string>;
  }): Promise<{
    audioUrl: string;
    provider: string;
    voiceId: string;
    language: string;
    dialect?: string;
    processedText: string;
    durationSeconds: number;
    generationMs?: number;
    warnings: string[];
  }> {
    const result = await this.voiceRegistry.synthesize({
      text: input.text,
      language: input.language,
      dialect: input.dialect,
      qualityProfile: input.qualityProfile || "balanced",
      requestedProvider: input.provider || "auto",
      voiceId: input.voiceId,
      fallbackPolicy: "none",
      brandPronunciations: input.pronunciationDictionary,
    });
    const tempId = cuid();
    const wavPath = path.join(this.config.tempDirPath, `${tempId}.wav`);
    const masteredWavPath = path.join(this.config.tempDirPath, `${tempId}.mastered.wav`);
    const mp3Path = path.join(this.config.tempDirPath, `${tempId}.mp3`);
    await this.ffmpeg.saveNormalizedAudioWithSpeed(result.audio, wavPath, 1.0);
    await this.audioMastering.masterVoice(wavPath, masteredWavPath);
    await this.ffmpeg.saveWavToMp3(masteredWavPath, mp3Path);
    const durationSeconds = await this.ffmpeg.getMediaDuration(masteredWavPath);
    fs.removeSync(wavPath);
    fs.removeSync(masteredWavPath);
    return {
      audioUrl: `/api/voice-preview/${tempId}.mp3`,
      provider: result.provider || result.decision.providerId,
      voiceId: result.voiceId || result.decision.voiceId,
      language: result.language || result.decision.language,
      dialect: result.dialect,
      processedText: result.processedText || result.decision.processedText,
      durationSeconds: Math.round((durationSeconds || result.audioLength || 0) * 100) / 100,
      generationMs: result.generationMs,
      warnings: result.decision.warnings,
    };
  }

  private mapVoiceQuality(quality?: string): VoiceQualityProfile {
    if (quality === "premium" || quality === "high") return "premium";
    if (quality === "draft") return "fast";
    return "balanced";
  }
}
