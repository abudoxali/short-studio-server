import type { OrientationEnum } from "../../../types/shorts";
import type { ProductionSceneSpec } from "../../../types/productionSpec";

export type VisualAssetResult = {
  provider: string;
  source: "stock" | "ai" | "uploaded" | "local_ai" | "motion";
  url: string;
  localPath?: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  estimatedCost: number | null;
  fallbackUsed?: boolean;
  metadata?: Record<string, unknown>;
};

export type PerfEvent = { stage: string; ms: number; meta?: Record<string, unknown> };

export type VisualRenderOptions = {
  orientation?: OrientationEnum;
  excludeIds?: (string | number)[];
  tempDirPath: string;
  targetDurationSeconds?: number;
  previousCandidates?: Record<string, unknown>[];
  /**
   * Deliberately broad fallback queries emitted by the query-family engine
   * (e.g. "technology", "office") when no concrete concept was recognised. A
   * candidate that only surfaced through one of these is unproven: the router
   * accepts it only when its own metadata also overlaps the scene intent.
   */
  genericStockTerms?: string[];
  /**
   * Fine-grained wall-clock accounting (V2.4 Pass 5, section 12). Optional
   * and additive only - omitting it changes no behavior. Callers accumulate
   * these into a per-production report (`providerSearchMs`,
   * `providerDownloadMs`, `openClipInitMs`, `openClipInferenceMs`, ...).
   */
  onPerf?: (event: PerfEvent) => void;
};

export type SceneCostEstimate = {
  provider: string;
  source: "stock" | "ai" | "uploaded" | "local_ai" | "motion";
  estimatedCost: number | null;
  currency: "USD";
  costStatus?: "known" | "estimated" | "usage_based_unknown" | "free";
};

export type VisualProviderValidationResult = {
  provider: string;
  category: "Visuals";
  configured: boolean;
  healthy: boolean;
  status: "healthy" | "not_configured" | "invalid_credentials" | "rate_limited" | "timeout" | "provider_unavailable";
  message: string;
  checkedAt: string;
  latencyMs?: number;
};

export type VisualProviderCapabilities = {
  providerClass?: ProfessionalVisualProviderClass;
  freeOrPaid?: "free" | "paid" | "mixed" | "local";
  billingModel?: "free_api_key" | "credits" | "usage_based" | "local_compute" | "none" | "unknown";
  enabled?: boolean;
  healthy?: boolean;
  liveVerified?: boolean;
  priority?: number;
  qualityTier?: "fallback" | "standard" | "professional" | "premium";
  latencyTier?: "interactive" | "short" | "long" | "offline";
  textToImage: boolean;
  imageToImage: boolean;
  textToVideo: boolean;
  imageToVideo: boolean;
  referenceImage: boolean;
  multipleReferenceImages: boolean;
  portrait?: boolean;
  landscape?: boolean;
  supportedDurations?: number[];
  supportedResolutions?: string[];
  seed: boolean;
  audio?: boolean;
  nativeCharacterIdentity: boolean;
  negativePrompt?: boolean;
  cameraControl?: boolean;
  maxConcurrency?: number;
  rateLimitState?: "unknown" | "ok" | "limited" | "blocked";
};

export type ProfessionalVisualProviderClass =
  | "STOCK_VIDEO"
  | "GENERATED_VIDEO"
  | "IMAGE_TO_VIDEO"
  | "GENERATED_IMAGE"
  | "UPLOADED_VIDEO"
  | "UPLOADED_IMAGE"
  | "LOCAL_GENERATIVE_VIDEO"
  | "MOTION_OVERLAY";

export type ProviderLifecycleStatus =
  | "SUBMITTED"
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETE"
  | "DOWNLOAD_READY"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export type ProviderGenerationRequest = {
  scene: ProductionSceneSpec;
  prompt: string;
  orientation?: VisualRenderOptions["orientation"];
  aspectRatio?: "9:16" | "16:9" | "1:1";
  durationSeconds: number;
  resolution?: string;
  imageUrl?: string;
  referenceImageUrls?: string[];
  negativePrompt?: string;
  seed?: number;
  modelId?: string;
  idempotencyKey?: string;
  paidCallAuthorized?: boolean;
};

export type ProviderGenerationJob = {
  provider: string;
  providerRequestId: string;
  status: ProviderLifecycleStatus;
  submittedAt: string;
  pollAfterMs?: number;
  statusUrl?: string;
  responseUrl?: string;
  cancelUrl?: string;
  outputUrl?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
};

export interface VisualProvider {
  readonly id: string;
  readonly displayName: string;
  readonly category: "stock" | "ai_video" | "local_ai_video" | "motion" | "uploaded";
  readonly providerClass?: ProfessionalVisualProviderClass;

  isConfigured(): boolean;
  fetchOrGenerateScene(
    scene: ProductionSceneSpec,
    options: VisualRenderOptions,
  ): Promise<VisualAssetResult>;
  estimateCost(scene: ProductionSceneSpec): SceneCostEstimate;
  validate(): Promise<VisualProviderValidationResult>;
  getCapabilities?(): VisualProviderCapabilities;
  submit?(request: ProviderGenerationRequest): Promise<ProviderGenerationJob>;
  poll?(job: ProviderGenerationJob): Promise<ProviderGenerationJob>;
  cancel?(job: ProviderGenerationJob): Promise<ProviderGenerationJob>;
  download?(job: ProviderGenerationJob, destinationPath: string): Promise<VisualAssetResult>;
  normalizeResult?(payload: unknown, request: ProviderGenerationRequest): ProviderGenerationJob;
}
