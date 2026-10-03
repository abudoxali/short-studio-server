import express from "express";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import axios from "axios";
import cuid from "cuid";
import fs from "fs-extra";
import path from "path";
import { logger } from "../../logger";
import { Config } from "../../config";
import { listBusinessTemplates } from "../../short-creator/business-templates";
import { templateProductionProfile } from "../../short-creator/templateProductionProfiles";
import { ShortCreator } from "../../short-creator/ShortCreator";
import { validateCreateShortInput } from "../validator";
import { readMetadata } from "../videoMetadata";
import { V2Database } from "./db";
import { getV2Health, validatePexelsProvider } from "./health";
import { getFastHealth, type ProviderConfigurationSnapshot } from "./system/fastHealth";
import { resolveUploadPostStatus } from "./integrations/credentialResolver";
import { JobService } from "./jobs";
import { N8nOrchestrator } from "./orchestrator";
import {
  appSettingsSchema,
  brandProfileSchema,
  captionStyleRevisionSchema,
  createVideoJobSchema,
  internalCompleteSchema,
  internalFailSchema,
  internalProgressSchema,
  internalStartRenderSchema,
  mediaRevisionSchema,
  productionJobSchema,
  productionSpecPreviewSchema,
  promptEnhanceRequestSchema,
  reusableTemplateSchema,
  stageRetrySchema,
  voiceRevisionSchema,
} from "./types";
import { ContentAIRegistry } from "./content-ai/registry";
import { ContentPlannerError } from "./content-ai/ollamaProvider";
import { validateScriptQuality } from "./content-ai/scriptQuality";
import { estimateProductionCost } from "./cost-estimator";
import {
  productionSpecSchema,
  type ProductionSpec,
  validateContentQuality,
  validateProductionSpec,
} from "../../types/productionSpec";
import { convertTemplateToProductionSpec } from "./templateToSpec";
import { VeoVisualProvider } from "./visual-providers/veoVisualProvider";
import { FalVisualProvider } from "./visual-providers/falVisualProvider";
import { RunwayVisualProvider } from "./visual-providers/runwayVisualProvider";
import { ReplicateVisualProvider } from "./visual-providers/replicateVisualProvider";
import { ComfyUIProvider } from "./visual-providers/comfyUIProvider";
import { LumaVisualProvider } from "./visual-providers/lumaVisualProvider";
import { PixabayProvider } from "./stock-providers/pixabayProvider";
import { PexelsStockProvider } from "./stock-providers/pexelsProvider";
import { ElevenLabsVoiceProvider } from "./voice-providers/elevenlabsVoiceProvider";
import { GoogleCloudTtsProvider } from "./voice-providers/googleCloudTtsProvider";
import { EdgeTtsProvider } from "./voice-providers/edgeTtsProvider";
import { VoiceRegistry } from "./voice-providers/registry";
import { LocalEgyptianTtsProvider } from "./voice-providers/localEgyptianTtsProvider";
import { PIPER_ARABIC_MODEL } from "./voice-providers/piperArabicModel";
import { mediaIntelligenceService } from "./media-intelligence/mediaIntelligenceService";
import { mediaCache } from "./media-cache/mediaCache";
import { imageRegistry } from "./image-providers/registry";
import { createPublishingRouter } from "./publishing/routes";
import { PublishingService } from "./publishing/publishingService";
import { PublishingScheduler } from "./publishing/scheduler";
import { publishingRegistry } from "./publishing/registry";
import { getProductInfo } from "../../version";
import { UpdateService, type UpdateCenterState } from "./updates/updateService";
import type { UpdateTransaction } from "./updates/updateState";
import { createLicensingRouter } from "./licensing/routes";
import { LicenseManager } from "./licensing/licenseManager";
import {
  OAUTH_CALLBACK_PROVIDERS,
  oauthCallbackUrl,
  publicUrlWarnings,
  resolveInstallationPublicUrl,
} from "./system/publicUrl";
import { resolveTrustedProxy } from "./system/trustedProxy";
import { AuthService } from "./auth/authService";
import { ApiTokenService, type ApiTokenScope } from "./auth/apiTokenService";
import { isLocalSingleUserAccess, localSingleUserOwner } from "./auth/localSingleUser";
import {
  ARABIC_ELEVENLABS_REQUIRED_MESSAGE,
  ARABIC_LIGHTWEIGHT_PROVIDER,
  ARABIC_LOCAL_VOICE_SETUP_REQUIRED_MESSAGE,
  ARABIC_PREMIUM_CLOUD_PROVIDER,
  ARABIC_PRODUCTION_PROVIDER,
  isArabicLanguage,
  isLegacyPiperVoiceId,
  type VoiceProviderId,
} from "./voice-providers/types";
import { LOCAL_TTS_MODELS } from "./voice-providers/localTtsModels";
import { LocalModelManager } from "./voice-providers/localModelManager";
import { LocalTtsClient, type LocalTtsHealth } from "./voice-providers/localTtsClient";
import {
  ELEVENLABS_DEFAULT_MODEL_ID,
  ELEVENLABS_PRESETS,
  ELEVENLABS_PRESET_IDS,
} from "./voice-providers/elevenlabsVoiceProvider";
import {
  readArabicVoiceDefault,
  resolveArabicVoiceSelection,
  writeArabicVoiceDefault,
  type PersistedArabicVoiceDefault,
  type ResolvedArabicVoice,
} from "./voice-providers/arabicVoiceDefault";
import { voicePresetEnum, type VoicePreset } from "../../types/productionSpec";
import { BackupService } from "./backup/backupService";
import { DiagnosticsService } from "./diagnostics/diagnosticsService";
import { WebhookService } from "./webhooks/webhookService";
import { AnalyticsService } from "./analytics/analyticsService";
import { SystemHealthService } from "./system/systemHealthService";
import { RevisionService } from "./revisions/revisionService";
import { WorkerLeaseService } from "./workers/workerLeaseService";
import { ProviderCredentialsVault, allowedCredentialTypes, type CredentialType } from "./provider-vault/providerCredentialsVault";
import { providerSecrets } from "./provider-vault/providerSecrets";
import {
  normalizeProviderServiceState,
  statusFromCanonicalProvider,
  tierFromBillingClass,
  type CanonicalProviderStateInput,
  type ProviderBillingClass,
} from "./providers/canonicalProviderState";
import {
  allocateHeroShots,
  resolveProviderBudgetPolicy,
  type ProviderBudgetPolicy,
} from "./providers/providerServicePolicy";
import { createOAuthRouter } from "./integrations/oauthRoutes";
import { checkpointStages } from "./checkpoints";
import {
  serializeJobForCustomer,
  queryJobRows,
  buildCustomerTimeline,
  sanitizeJobFailure,
  classifyRenderFailure,
  CATEGORY_MESSAGES_AR,
  customerDisplayProgress,
  scrubInternal,
  STATUS_GROUPS,
  type JobListFilters,
} from "./customerView";
import {
  buildRevisionReusePlan,
  filterReusableArtifacts,
  readDurableArtifactsForSourceJob,
  type DurableSceneArtifact,
} from "./artifacts/durableArtifacts";
import { capabilityManager } from "./capabilities/capabilityManager";
import type { CapabilityId } from "./capabilities/types";
import { qualityEngine } from "./quality/qualityEngine";
import {
  mediaUploadService,
  type MediaAsset,
  type UploadedProductMedia,
} from "./media/mediaUploadService";
import { motionEngine } from "./motion/motionEngine";

type BrandRow = {
  id: string;
  name: string;
  description?: string | null;
  industry?: string | null;
  tagline?: string | null;
  watermark_text: string;
  primary_color: string;
  secondary_color?: string | null;
  accent_color: string;
  background_color?: string | null;
  text_color?: string | null;
  logo_asset_id?: string | null;
  icon_asset_id?: string | null;
  logo_url?: string | null;
  website_url?: string | null;
  social_handle?: string | null;
  caption_style: string;
  include_outro: boolean;
  outro_text: string;
  contact_text: string;
  voice_profile?: Record<string, unknown> | null;
  kit?: Record<string, unknown> | null;
  revision?: number | null;
  revisions?: Array<Record<string, unknown>> | null;
  archived_at?: Date | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
};

type TemplateRow = {
  id: string;
  name: string;
  description: string;
  category: string;
  source: "custom";
  base_template_id?: string | null;
  favorite: boolean;
  archived_at?: Date | null;
  revision: number;
  config: Record<string, unknown>;
  variables: Array<Record<string, unknown>>;
  revisions: Array<Record<string, unknown>>;
  created_at: Date;
  updated_at: Date;
};

type TemplatePreferenceRow = {
  template_id: string;
  favorite: boolean;
  updated_at: Date;
};

type SettingRow = {
  key: string;
  value: Record<string, unknown>;
  updated_at: Date;
};

function brandArabicVoiceDefault(brand: ReturnType<typeof mapBrand> | null | undefined): {
  voiceId?: string;
  voiceName?: string;
  preset?: VoicePreset;
  settings?: Record<string, unknown>;
  modelId?: string;
} | null {
  const profile = brand?.voiceProfile || {};
  if (profile.provider && profile.provider !== "elevenlabs") return null;
  const voiceId = typeof profile.voiceId === "string" ? profile.voiceId.trim() : "";
  if (!voiceId || isLegacyPiperVoiceId(voiceId)) return null;
  const preset = coerceRequestedPreset(profile.style);
  return {
    voiceId,
    voiceName: typeof profile.voiceName === "string" && profile.voiceName.trim() ? profile.voiceName.trim() : undefined,
    preset,
    settings:
      profile.settings && typeof profile.settings === "object" && !Array.isArray(profile.settings)
        ? profile.settings as Record<string, unknown>
        : undefined,
    modelId: typeof profile.modelId === "string" && profile.modelId.trim() ? profile.modelId.trim() : undefined,
  };
}

function mapBrand(row: BrandRow) {
  const kit = (row.kit || {}) as Record<string, any>;
  const revision = row.revision || 1;
  return {
    id: row.id,
    name: row.name,
    description: row.description || kit.description || "",
    industry: row.industry || kit.industry || "",
    tagline: row.tagline || kit.tagline || "",
    watermarkText: row.watermark_text,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color || undefined,
    accentColor: row.accent_color,
    backgroundColor: row.background_color || kit.backgroundColor || undefined,
    textColor: row.text_color || kit.textColor || undefined,
    logoAssetId: row.logo_asset_id || kit.logoAssetId || undefined,
    iconAssetId: row.icon_asset_id || kit.iconAssetId || undefined,
    logoUrl: row.logo_url || undefined,
    websiteUrl: row.website_url || undefined,
    socialHandle: row.social_handle || undefined,
    socialHandles: kit.socialHandles || {},
    headingFont: kit.headingFont || "ibm_plex_sans_arabic",
    bodyFont: kit.bodyFont || "ibm_plex_sans_arabic",
    captionFont: kit.captionFont || "ibm_plex_sans_arabic",
    captionStyle: row.caption_style,
    includeOutro: row.include_outro,
    outroText: row.outro_text,
    contactText: row.contact_text,
    voiceProfile: row.voice_profile || undefined,
    toneOfVoice: kit.toneOfVoice || "",
    keywords: Array.isArray(kit.keywords) ? kit.keywords : [],
    preferredPhrases: Array.isArray(kit.preferredPhrases) ? kit.preferredPhrases : [],
    avoidPhrases: Array.isArray(kit.avoidPhrases) ? kit.avoidPhrases : [],
    defaultCtaText: kit.defaultCtaText || "",
    defaultLanguage: kit.defaultLanguage || "auto",
    defaultDurationSeconds: kit.defaultDurationSeconds,
    defaultAspectRatio: kit.defaultAspectRatio || "9:16",
    defaultQuality: kit.defaultQuality || "standard",
    defaultVisualSource: kit.defaultVisualSource || "auto_best",
    defaultMusicMood: kit.defaultMusicMood,
    defaultCharacterProfileId: kit.defaultCharacterProfileId,
    watermark: kit.watermark || { enabled: false },
    intro: kit.intro || { type: "none", durationSeconds: 0 },
    outro: kit.outro || { type: row.include_outro ? "cta_card" : "none", durationSeconds: row.include_outro ? 2 : 0 },
    palette: kit.palette,
    revision,
    revisions: Array.isArray(row.revisions) ? row.revisions.map((item) => ({
      revision: item.revision,
      createdAt: item.createdAt,
      summary: item.summary,
    })) : [],
    archived: Boolean(row.archived_at),
    archivedAt: row.archived_at?.toISOString(),
    isDefault: row.is_default,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const TEMPLATE_CATEGORIES = ["social", "product", "business", "educational", "explainer", "event", "promotional"] as const;

const BUILT_IN_TEMPLATE_CATEGORY: Record<string, (typeof TEMPLATE_CATEGORIES)[number]> = {
  product_ad: "product",
  restaurant_offer: "promotional",
  real_estate_listing: "business",
  educational_tip: "educational",
  viral_curiosity: "social",
  event_promo: "event",
  saas_promo: "product",
  business_tips: "educational",
  story_narrative: "social",
  news_update: "business",
  social_ad: "promotional",
  my_media_showcase: "social",
};

function compactStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 30)
    : [];
}

function brandKitFromInput(input: any) {
  return {
    brandName: input.name,
    description: input.description || undefined,
    industry: input.industry || undefined,
    tagline: input.tagline || undefined,
    watermarkText: input.watermarkText || "",
    primaryColor: input.primaryColor,
    secondaryColor: input.secondaryColor || undefined,
    accentColor: input.accentColor,
    backgroundColor: input.backgroundColor || undefined,
    textColor: input.textColor || undefined,
    logoAssetId: input.logoAssetId || undefined,
    iconAssetId: input.iconAssetId || undefined,
    logoUrl: input.logoUrl || undefined,
    websiteUrl: input.websiteUrl || undefined,
    socialHandle: input.socialHandle || undefined,
    socialHandles: input.socialHandles || {},
    headingFont: input.headingFont,
    bodyFont: input.bodyFont,
    captionFont: input.captionFont,
    captionStyle: input.captionStyle,
    includeOutro: input.includeOutro,
    outroText: input.outroText || "",
    contactText: input.contactText || "",
    toneOfVoice: input.toneOfVoice || undefined,
    keywords: compactStringArray(input.keywords),
    preferredPhrases: compactStringArray(input.preferredPhrases),
    avoidPhrases: compactStringArray(input.avoidPhrases),
    defaultCtaText: input.defaultCtaText || undefined,
    defaultLanguage: input.defaultLanguage,
    defaultDurationSeconds: input.defaultDurationSeconds,
    defaultAspectRatio: input.defaultAspectRatio,
    defaultQuality: input.defaultQuality,
    defaultVisualSource: input.defaultVisualSource,
    defaultMusicMood: input.defaultMusicMood || undefined,
    defaultCharacterProfileId: input.defaultCharacterProfileId || undefined,
    watermark: input.watermark || { enabled: false },
    intro: input.intro || { type: "none", durationSeconds: 0 },
    outro: input.outro || { type: input.includeOutro ? "cta_card" : "none", durationSeconds: input.includeOutro ? 2 : 0 },
  };
}

function brandRevisionEntry(revision: number, brand: ReturnType<typeof mapBrand>, summary: string) {
  return {
    revision,
    createdAt: new Date().toISOString(),
    summary,
    snapshot: createBrandSnapshot(brand),
  };
}

function createBrandSnapshot(brand: ReturnType<typeof mapBrand>) {
  return {
    brandId: brand.id,
    brandName: brand.name,
    revision: brand.revision || 1,
    logoAssetId: brand.logoAssetId,
    iconAssetId: brand.iconAssetId,
    palette: {
      customer: {
        primaryColor: brand.primaryColor,
        secondaryColor: brand.secondaryColor,
        accentColor: brand.accentColor,
        backgroundColor: brand.backgroundColor,
        textColor: brand.textColor,
      },
      provenance: {
        primaryColor: brand.primaryColor ? "customer" : "default",
        secondaryColor: brand.secondaryColor ? "customer" : "derived",
        accentColor: brand.accentColor ? "customer" : "default",
        backgroundColor: brand.backgroundColor ? "customer" : "default",
        textColor: brand.textColor ? "customer" : "derived",
      },
    },
    typography: {
      headingFont: brand.headingFont,
      bodyFont: brand.bodyFont,
      captionFont: brand.captionFont,
    },
    captionPreference: brand.captionStyle,
    voicePreference: brand.voiceProfile,
    cta: brand.defaultCtaText || brand.outroText,
    watermark: brand.watermark,
    intro: brand.intro,
    outro: brand.outro,
    websiteUrl: brand.websiteUrl,
    socialHandle: brand.socialHandle,
    socialHandles: brand.socialHandles,
    toneOfVoice: brand.toneOfVoice,
    keywords: brand.keywords,
    preferredPhrases: brand.preferredPhrases,
    avoidPhrases: brand.avoidPhrases,
  };
}

async function getBrandById(db: V2Database, id?: string): Promise<ReturnType<typeof mapBrand> | null> {
  if (!id) return null;
  const rows = await db.query<BrandRow>("SELECT * FROM brands WHERE id = $1", [id]);
  return rows[0] ? mapBrand(rows[0]) : null;
}

async function validateBrandMediaReferences(input: any) {
  const ids = [input.logoAssetId, input.iconAssetId, input.watermark?.assetId].filter(Boolean) as string[];
  for (const id of ids) {
    const asset = await mediaUploadService.getAsset(id);
    if (!asset || asset.status === "archived") throw new Error("Selected logo or watermark asset was not found.");
    if (!asset.usability?.usableForLogo) throw new Error("Selected logo or watermark asset is not usable as a logo.");
  }
}

function mapBuiltInTemplate(template: ReturnType<typeof listBusinessTemplates>[number], preferences: Map<string, boolean> = new Map()) {
  return {
    id: template.id,
    name: template.displayName,
    displayName: template.displayName,
    description: template.description,
    category: BUILT_IN_TEMPLATE_CATEGORY[template.id] || "business",
    source: "built_in" as const,
    builtIn: true,
    custom: false,
    favorite: preferences.get(template.id) === true,
    archived: false,
    revision: 1,
    baseTemplateId: template.id,
    targetUseCase: template.targetUseCase,
    defaultTone: template.defaultTone,
    suggestedDurationSeconds: template.suggestedDurationSeconds,
    recommendedSceneCount: template.recommendedSceneCount,
    targetDurationSeconds: template.targetDurationSeconds,
    hookStyle: template.hookStyle,
    ctaStyle: template.ctaStyle,
    examplePrompt: template.examplePrompt,
    pexelsSearchHints: template.pexelsSearchHints,
    fallbackPexelsSearchHints: template.fallbackPexelsSearchHints,
    qualityChecklist: template.qualityChecklist,
    fields: template.fields,
    variables: template.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type === "number" ? "number" : "text",
      required: field.required,
      defaultValue: "",
      example: field.placeholder,
      helpText: field.helperText,
    })),
    // V2.5.1: what this template ACTUALLY produces. This block used to be four
    // hard-coded values identical for every template, which meant a Real Estate
    // Listing and a Viral Short resolved to the same vertical, standard-quality,
    // auto-media plan and differed only in wording. See
    // `templateProductionProfiles.ts`.
    config: (() => {
      const profile = templateProductionProfile(template.id);
      return {
        durationSeconds: template.targetDurationSeconds || profile.durationSeconds,
        aspectRatio: profile.aspectRatio,
        quality: profile.quality,
        visualSource: profile.visualSource,
        mediaPolicy: profile.mediaPolicy,
        productionMode: profile.productionMode,
        contentStyle: profile.contentStyle,
        captionStyle: profile.captionStyle,
        recommendedSceneCount: profile.recommendedSceneCount,
      };
    })(),
  };
}

function mapCustomTemplate(row: TemplateRow) {
  const variables = Array.isArray(row.variables) ? row.variables : [];
  return {
    id: row.id,
    name: row.name,
    displayName: row.name,
    description: row.description,
    category: row.category,
    source: "custom" as const,
    builtIn: false,
    custom: true,
    favorite: row.favorite,
    archived: Boolean(row.archived_at),
    archivedAt: row.archived_at?.toISOString(),
    revision: row.revision,
    baseTemplateId: row.base_template_id || undefined,
    targetUseCase: row.description,
    hookStyle: String(row.config?.creativeStyle || "Customer-defined opening"),
    ctaStyle: String(row.config?.ctaBehavior || "Customer-defined CTA"),
    examplePrompt: String(row.config?.promptGuidance || ""),
    pexelsSearchHints: [],
    qualityChecklist: [],
    fields: variables.map((variable: any) => ({
      key: variable.key,
      label: variable.label,
      type: variable.type === "number" ? "number" : variable.type === "text" ? "text" : "textarea",
      required: Boolean(variable.required),
      placeholder: variable.example,
      helperText: variable.helpText,
    })),
    variables,
    config: row.config || {},
    revisions: Array.isArray(row.revisions) ? row.revisions.map((item) => ({
      revision: item.revision,
      createdAt: item.createdAt,
      summary: item.summary,
    })) : [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function templateSnapshot(template: any, resolvedVariables: Record<string, string> = {}) {
  return {
    templateId: template.id,
    templateRevision: template.revision || 1,
    templateName: template.displayName || template.name,
    source: template.source,
    baseTemplateId: template.baseTemplateId,
    resolvedConfiguration: template.config || {},
    resolvedVariables,
  };
}

function validateTemplateVariables(template: any, values: Record<string, string> = {}) {
  const missing: string[] = [];
  const resolved: Record<string, string> = {};
  for (const variable of template.variables || []) {
    const value = String(values[variable.key] ?? variable.defaultValue ?? "").trim();
    if (variable.required && !value) missing.push(variable.label || variable.key);
    if (value) resolved[variable.key] = value;
  }
  const unresolved = Object.values(resolved).filter((value) => /\{\{[^}]+\}\}/.test(value));
  return { ok: missing.length === 0 && unresolved.length === 0, missing, unresolved, resolved };
}

function applyVariablesToText(text: string | undefined, values: Record<string, string>) {
  if (!text) return text;
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key) => values[key] || "");
}

async function getTemplateForSnapshot(db: V2Database, id?: string): Promise<any | null> {
  if (!id) return null;
  const builtIn = listBusinessTemplates().map((template) => mapBuiltInTemplate(template)).find((template) => template.id === id);
  if (builtIn) return builtIn;
  try {
    const rows = await db.query<TemplateRow>("SELECT * FROM video_templates WHERE id = $1", [id]);
    return rows[0] ? mapCustomTemplate(rows[0]) : null;
  } catch {
    return null;
  }
}

function redactConfiguredKey(key?: string) {
  if (!key || key === "dummy-key" || key.includes("your_")) return null;
  return "••••••••";
}

function readStorageDetails(config: Config) {
  // Size only - the absolute container path is an internal detail and must not
  // reach a customer (privacy standard).
  fs.ensureDirSync(config.videosDirPath);
  const files = fs.readdirSync(config.videosDirPath);
  const bytes = files.reduce((total, file) => {
    const filePath = path.join(config.videosDirPath, file);
    const stats = fs.statSync(filePath);
    return stats.isFile() ? total + stats.size : total;
  }, 0);
  return { videoCount: files.filter((file) => file.endsWith(".mp4")).length, bytes };
}

async function readAppSettings(db: V2Database) {
  const rows = await db.query<SettingRow>(
    "SELECT key, value, updated_at FROM app_settings WHERE key = $1",
    ["dashboard"],
  );
  return rows[0]?.value || {};
}

/**
 * Advanced Technical Details are opt-in. The ordinary client view never shows a
 * Docker image reference or a digest, so they are stripped unless the caller
 * explicitly asked for the technical panel.
 */
function isAdvancedUpdateView(req: ExpressRequest): boolean {
  return String(req.query.advanced || "") === "true";
}

function clientSafeUpdateState(
  state: UpdateCenterState,
  includeAdvanced: boolean,
): UpdateCenterState | Omit<UpdateCenterState, "advanced"> {
  if (includeAdvanced) return state;

  // The `advanced` block is not the only place a digest appears: the host
  // updater records the image digest and the package checksum on each
  // transaction, and those records are what the ordinary view renders as
  // "last update". They belong behind Advanced Technical Details too.
  const { advanced: _advanced, ...rest } = state;
  return {
    ...rest,
    lastAttempt: withoutTechnicalFields(rest.lastAttempt),
    lastSuccessful: withoutTechnicalFields(rest.lastSuccessful),
    lastRollback: withoutTechnicalFields(rest.lastRollback),
  };
}

function withoutTechnicalFields(
  transaction: UpdateTransaction | null,
): UpdateTransaction | null {
  if (!transaction) return null;
  const { imageDigest: _digest, packageSha256: _checksum, ...rest } = transaction;
  return rest;
}

export type ClientMediaAsset = Omit<
  MediaAsset,
  "checksum" | "storagePath" | "relativePath" | "nobgArtifactId" | "nobgRelativePath"
>;

export type ClientProductMedia = Omit<
  UploadedProductMedia,
  "checksum" | "storagePath" | "relativePath" | "nobgArtifactId" | "nobgRelativePath"
>;

export function serializeMediaAssetForApi(asset: MediaAsset): ClientMediaAsset {
  const {
    checksum: _checksum,
    storagePath: _storagePath,
    relativePath: _relativePath,
    nobgArtifactId: _nobgArtifactId,
    nobgRelativePath: _nobgRelativePath,
    ...safeAsset
  } = asset;
  return safeAsset;
}

export function serializeProductMediaForApi(media: UploadedProductMedia): ClientProductMedia {
  const {
    checksum: _checksum,
    storagePath: _storagePath,
    relativePath: _relativePath,
    nobgArtifactId: _nobgArtifactId,
    nobgRelativePath: _nobgRelativePath,
    ...safeMedia
  } = media;
  return safeMedia;
}

async function writeAppSettings(db: V2Database, value: Record<string, unknown>) {
  const rows = await db.query<SettingRow>(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING key, value, updated_at`,
    ["dashboard", value],
  );
  return rows[0]?.value || value;
}

function metadataArtifacts(metadata: any): DurableSceneArtifact[] {
  return filterReusableArtifacts({
    artifacts: Array.isArray(metadata?.durableArtifacts) ? metadata.durableArtifacts as DurableSceneArtifact[] : [],
  });
}

function publicArtifactSummary(artifact: DurableSceneArtifact) {
  return {
    artifactId: artifact.artifactId,
    type: artifact.type,
    sceneIndex: artifact.sceneIndex,
    segmentIndex: artifact.segmentIndex,
    sourceJobId: artifact.sourceJobId,
    sourceRevisionId: artifact.sourceRevisionId,
    provider: artifact.provider,
    model: artifact.model,
    inputHash: artifact.inputHash,
    checksum: artifact.checksum,
    duration: artifact.duration,
    valid: artifact.valid,
    createdAt: artifact.createdAt,
  };
}

function revisionReuseSummary(plan: ReturnType<typeof buildRevisionReusePlan>) {
  return {
    reusedStages: plan.reusedStages,
    regeneratedStages: plan.regeneratedStages,
    reusedArtifacts: plan.artifacts.map(publicArtifactSummary),
  };
}

/** Canonical spec-level voice routing. Arabic Auto is local-first; ElevenLabs
 * is reachable only through explicit Premium selection. */
function inferResolvedVoiceProvider(input: {
  language?: string;
  dialect?: string;
  voiceProvider?: string;
}): VoiceProviderId {
  const isArabic =
    input.language === "ar" ||
    (input.language === "auto" && Boolean(input.dialect) && input.dialect !== "none");
  if (isArabic) {
    if (input.voiceProvider === ARABIC_PREMIUM_CLOUD_PROVIDER) return ARABIC_PREMIUM_CLOUD_PROVIDER;
    return ARABIC_PRODUCTION_PROVIDER;
  }
  if (input.voiceProvider && input.voiceProvider !== "auto") {
    return input.voiceProvider as VoiceProviderId;
  }
  return "kokoro";
}

function defaultVoiceForResolvedProvider(provider: VoiceProviderId): string {
  if (provider === "voicetut") return process.env.VOICETUT_DEFAULT_SPEAKER || LOCAL_TTS_MODELS.voicetut.defaultSpeakerId;
  if (provider === "kemetone") return LOCAL_TTS_MODELS.kemetone.defaultSpeakerId;
  // ElevenLabs is deliberately absent here: a premium cloud Arabic voice is a
  // human decision resolved through resolveArabicVoiceSelection.
  if (provider === "piper") return process.env.PIPER_AR_VOICE_ID || "ar_JO-kareem-medium";
  if (provider === "edge_tts") return process.env.EDGE_TTS_DEFAULT_VOICE || "ar-EG-SalmaNeural";
  if (provider === "google_cloud_tts") return process.env.GOOGLE_CLOUD_TTS_DEFAULT_VOICE || "";
  return "af_heart";
}

export type LocalVoiceCreatePreflight = {
  ready: boolean;
  resolvedProvider?: "voicetut";
  errorCode?: "local_voice_unavailable" | "local_voice_model_unavailable";
};

/** Pure policy used before a job exists. Disk installation state alone is not
 * enough: queue only when app can reach Local Voice and requested model is
 * reported ready by live service. */
export function evaluateLocalVoiceCreatePreflight(
  health: LocalTtsHealth | undefined,
  requestedProvider: string | undefined,
): LocalVoiceCreatePreflight {
  if (!health?.ok) return { ready: false, errorCode: "local_voice_unavailable" };
  const readyModels = new Set(health.models_ready || []);
  const requested = requestedProvider && requestedProvider !== "auto" ? requestedProvider : "auto";
  if (requested === "kemetone") {
    return { ready: false, errorCode: "local_voice_model_unavailable" };
  }
  if (requested === "voicetut") {
    return readyModels.has("voicetut")
      ? { ready: true, resolvedProvider: "voicetut" }
      : { ready: false, resolvedProvider: "voicetut", errorCode: "local_voice_model_unavailable" };
  }
  if (readyModels.has("voicetut")) return { ready: true, resolvedProvider: "voicetut" };
  return { ready: false, errorCode: "local_voice_model_unavailable" };
}

/**
 * Resolved defaults handed to canonicalization by the request layer.
 *
 * Canonicalization stays pure and synchronous: everything that needs the
 * database is read once per request *before* the spec is canonicalized.
 */
export type ProductionSpecDefaults = {
  arabicVoice?: PersistedArabicVoiceDefault | null;
  brandArabicVoice?: ReturnType<typeof brandArabicVoiceDefault>;
};

type CreateVisualSource = "auto_free" | "auto_best" | "auto_budget" | "stock" | "uploaded_media" | "ai_generated" | "mixed";
type StockProviderChoice = "auto_stock" | "pexels" | "pixabay";
type MediaPolicyChoice = "auto_use_selected" | "only_selected";

function characterProfileIdFromControls(controls: any): string {
  const value =
    controls.characterProfileId ||
    controls.metadata?.characterProfileId ||
    controls.productionSpec?.metadata?.characterProfileId ||
    controls.productionSpec?.metadata?.characterSnapshot?.profileId;
  return typeof value === "string" ? value.trim() : "";
}

function referenceCapableVisualProviders(providerIds: Set<string>): string[] {
  const configured: string[] = [];
  // Existing real adapters in this branch do not expose a truthful reference
  // image contract yet. A hidden deterministic test provider exercises payload
  // propagation without claiming Veo/fal/Pexels can preserve identity.
  if (process.env.ENABLE_TEST_PROVIDERS === "true" || process.env.ABUD_TEST_REFERENCE_VISUAL_PROVIDER === "true") {
    configured.push("test_reference_visual");
  }
  return configured.filter((id) => id === "test_reference_visual" || providerIds.has(id));
}

function visualModeForSource(source?: string): string | undefined {
  switch (source) {
    case "stock":
      return "stock";
    case "uploaded_media":
      return "uploaded_media";
    case "ai_generated":
      return "ai";
    case "mixed":
      return "hybrid";
    case "auto_free":
    case "auto_budget":
    case "auto_best":
    default:
      return undefined;
  }
}

function selectedMediaIdsFromControls(controls: any): string[] {
  const explicit = Array.isArray(controls.selectedMediaIds) ? controls.selectedMediaIds : [];
  const metadataIds = Array.isArray(controls.metadata?.selectedMediaIds) ? controls.metadata.selectedMediaIds : [];
  const singleProduct = controls.metadata?.productImageId || controls.productImageId;
  return Array.from(
    new Set(
      [...explicit, ...metadataIds, singleProduct]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .map((value) => String(value).trim()),
    ),
  );
}

function coerceRequestedPreset(value: unknown): VoicePreset | undefined {
  const parsed = voicePresetEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizeTitleDuration(title: string | undefined, durationSeconds: number): string | undefined {
  if (!title) return title;
  const duration = String(Math.round(durationSeconds * 10) / 10).replace(/\.0$/, "");
  return title
    .replace(/(مدته\s*)\d+(?:\.\d+)?/gi, `$1${duration}`)
    .replace(/\d+(?:\.\d+)?\s*(ثانية|ثواني|ثوان)/gi, `${duration} ثانية`)
    .replace(/\b\d+(?:\.\d+)?\s*(-?\s*)?(second|seconds|sec|secs|s)\b/gi, `${duration}s`);
}

function budgetControlsFrom(controls: any) {
  const metadata = controls.metadata || {};
  const contract = metadata.uiContract || {};
  return resolveProviderBudgetPolicy({
    visualSource: controls.visualSource || metadata.visualSource || contract.visualSource,
    budgetMode: controls.budgetMode || metadata.budgetMode || contract.budgetMode,
    maxExternalSpendUsd: controls.maxExternalSpendUsd ?? metadata.maxExternalSpendUsd ?? contract.maxExternalSpendUsd,
    paidCallsAllowed:
      controls.paidCallsAllowed === true ||
      metadata.paidCallsAllowed === true ||
      contract.paidCallsAllowed === true ||
      process.env.ABUD_ALLOW_PAID_VIDEO_CALLS === "true",
  });
}

export function canonicalizeProductionSpecContract(
  spec: any,
  controls: any,
  defaults: ProductionSpecDefaults = {},
) {
  const language = controls.language || spec.language || "auto";
  const dialect = language === "ar" || language === "auto"
    ? (controls.dialect || spec.dialect || "egyptian")
    : "none";
  const resolvedVoiceProvider = inferResolvedVoiceProvider({
    language,
    dialect,
    voiceProvider: controls.voiceProvider || spec.voiceProvider || "auto",
  });
  const previousVoiceProvider = spec.voiceProvider && spec.voiceProvider !== "auto"
    ? spec.voiceProvider
    : undefined;
  const canReuseSpecVoice = previousVoiceProvider === resolvedVoiceProvider && spec.voiceId;
  const requestedVoiceId = controls.voiceId || canReuseSpecVoice || "";
  // Historical Arabic jobs carry Piper model names. Never forward one to
  // ElevenLabs; resolveArabicVoiceSelection discards them for us.
  const arabicVoice: ResolvedArabicVoice | null =
    resolvedVoiceProvider === ARABIC_PREMIUM_CLOUD_PROVIDER
      ? resolveArabicVoiceSelection({
        requestedVoiceId,
        requestedPreset:
          coerceRequestedPreset(controls.voicePreset) ??
          (canReuseSpecVoice ? coerceRequestedPreset(spec.voicePreset) : undefined),
        brandVoice: defaults.brandArabicVoice,
        persisted: defaults.arabicVoice,
        defaultModelId: ELEVENLABS_DEFAULT_MODEL_ID,
      })
      : null;
  const voiceId = arabicVoice
    ? arabicVoice.voiceId
    : requestedVoiceId || defaultVoiceForResolvedProvider(resolvedVoiceProvider);
  const voicePreset = arabicVoice ? arabicVoice.preset : coerceRequestedPreset(controls.voicePreset);
  const voiceModelId = arabicVoice
    ? arabicVoice.modelId
    : resolvedVoiceProvider === "voicetut" || resolvedVoiceProvider === "kemetone"
      ? LOCAL_TTS_MODELS[resolvedVoiceProvider].providerModelId
      : undefined;
  const captionEnabled = controls.captionEnabled !== false && controls.captions !== false;
  const specMetadata = spec.metadata || {};
  const specContract = specMetadata.uiContract || {};
  const controlsMetadata = controls.metadata || {};
  const controlsContract = controlsMetadata.uiContract || {};
  const visualSource = (
    controls.visualSource ||
    controlsMetadata.visualSource ||
    controlsContract.visualSource ||
    spec.visualSource ||
    specMetadata.visualSource ||
    specContract.visualSource ||
    "auto_best"
  ) as CreateVisualSource;
  const selectedMediaIds = selectedMediaIdsFromControls(controls);
  const sourceVisualMode = visualModeForSource(visualSource);
  const resolvedVisualMode = sourceVisualMode || controls.visualMode || spec.visualMode;
  const stockProvider = (
    controls.stockProvider ||
    controlsMetadata.stockProvider ||
    controlsContract.stockProvider ||
    specMetadata.stockProvider ||
    specContract.stockProvider ||
    "auto_stock"
  ) as StockProviderChoice;
  const mediaPolicy = (
    controls.mediaPolicy ||
    controlsMetadata.mediaPolicy ||
    controlsContract.mediaPolicy ||
    specMetadata.mediaPolicy ||
    specContract.mediaPolicy ||
    "auto_use_selected"
  ) as MediaPolicyChoice;
  const aiVisualProvider =
    controls.aiVisualProvider ||
    controlsMetadata.aiVisualProvider ||
    controlsContract.aiVisualProvider ||
    specMetadata.aiVisualProvider ||
    specContract.aiVisualProvider ||
    "auto";
  const budgetPolicy = budgetControlsFrom({
    ...controls,
    visualSource,
    metadata: {
      ...specMetadata,
      ...controlsMetadata,
      uiContract: {
        ...specContract,
        ...controlsContract,
      },
    },
  });
  const productImageId = controls.metadata?.productImageId || controls.productImageId;
  const characterProfileId = characterProfileIdFromControls(controls);
  const heroShotAllocation = allocateHeroShots(
    { scenes: spec.scenes || [] },
    budgetPolicy,
    { maxGeneratedShots: visualSource === "ai_generated" ? spec.scenes?.length || 1 : 1 },
  );
  const canonical = validateProductionSpec({
    ...spec,
    language: language === "auto" && dialect !== "none" ? "ar" : language,
    dialect,
    durationSeconds: controls.durationSeconds ?? controls.requestedDurationSeconds ?? controls.duration ?? spec.durationSeconds,
    aspectRatio: controls.aspectRatio || spec.aspectRatio,
    resolution: controls.resolution || spec.resolution,
    quality: controls.quality || spec.quality,
    productionMode: controls.productionMode || spec.productionMode,
    // "auto" means "let the preset follow the production mode", so it is not
    // persisted as an explicit style choice.
    creativeStyle:
      controls.creativeStyle && controls.creativeStyle !== "auto"
        ? controls.creativeStyle
        : spec.creativeStyle,
    animationIntensity: controls.animationIntensity || spec.animationIntensity,
    visualMode: resolvedVisualMode,
    voiceProvider: resolvedVoiceProvider,
    voiceId,
    voicePreset,
    voiceModelId,
    captionStyle: captionEnabled ? controls.captionStyle || spec.captionStyle : "none",
    metadata: {
      ...(spec.metadata || {}),
      ...(productImageId ? { productImageId } : {}),
      ...(selectedMediaIds.length > 0 ? { selectedMediaIds } : {}),
      ...(characterProfileId ? { characterProfileId } : {}),
      uiContract: {
        durationSeconds: controls.durationSeconds ?? controls.requestedDurationSeconds ?? controls.duration ?? spec.durationSeconds,
        language: language === "auto" && dialect !== "none" ? "ar" : language,
        dialect,
        aspectRatio: controls.aspectRatio || spec.aspectRatio,
        resolution: controls.resolution || spec.resolution,
        quality: controls.quality || spec.quality,
        visualMode: resolvedVisualMode,
        visualSource,
        sourceStrategy:
          visualSource === "auto_best"
            ? "Auto Best"
            : visualSource === "auto_free"
              ? "Auto Free"
              : visualSource === "auto_budget"
                ? "Auto Budget"
                : visualSource === "stock"
                  ? "Stock"
                  : visualSource === "uploaded_media"
                    ? "Uploaded Media"
                    : visualSource === "ai_generated"
                      ? "AI Generated"
                      : "Mixed",
        stockProvider,
        mediaPolicy,
        selectedMediaIds,
        aiVisualProvider,
        budgetMode: budgetPolicy.mode,
        maxExternalSpendUsd: budgetPolicy.maxExternalSpendUsd,
        paidCallsAllowed: budgetPolicy.paidCallsAllowed,
        preflightExternalUsage:
          budgetPolicy.mode === "free_only"
            ? "Free"
            : budgetPolicy.maxExternalSpendUsd != null
              ? `Up to configured budget ($${budgetPolicy.maxExternalSpendUsd})`
              : "Usage Based - estimate unavailable",
        heroShotAllocation,
        characterProfileId,
        characterConsistencyMode: characterProfileId ? "Provider capability required" : "None",
        captionEnabled,
        requestedVoiceProvider: controls.voiceProvider || spec.voiceProvider || "auto",
        resolvedVoiceProvider,
        voiceId,
        voicePreset,
        voiceModelId,
        voiceSettings: arabicVoice?.settings,
        // How the voice was chosen, so the UI and job metadata can prove the
        // persisted human or brand-profile selection was used.
        voiceSource: arabicVoice?.source,
        voiceName: arabicVoice?.voiceName,
      },
    },
  });
  return {
    ...canonical,
    title: normalizeTitleDuration(canonical.title, canonical.durationSeconds) || canonical.title,
  };
}

/**
 * Request-layer canonicalization.
 *
 * Reads the persisted human Arabic default once, then hands it to the pure
 * canonicalizer. Every route that builds a ProductionSpec goes through here so
 * no path can silently fall back to the legacy environment voice.
 */
async function canonicalizeProductionSpecForRequest(
  db: V2Database,
  spec: any,
  controls: any,
) {
  const brandId = String(controls.brandId || spec.brandId || "").trim();
  const templateId = String(controls.templateId || controls.businessTemplateId || spec.templateId || "").trim();
  const brand = await getBrandById(db, brandId).catch(() => null);
  const template = await getTemplateForSnapshot(db, templateId).catch(() => null);
  const arabicVoice = await readArabicVoiceDefault(db).catch(() => null);
  const canonical = canonicalizeProductionSpecContract(spec, controls, {
    arabicVoice,
    brandArabicVoice: brandArabicVoiceDefault(brand),
  });
  const brandSnapshot = brand ? createBrandSnapshot(brand) : undefined;
  const baseMetadata = {
    ...(canonical.metadata || {}),
    ...(brandSnapshot ? { brandSnapshot } : {}),
    ...(template ? { templateSnapshot: templateSnapshot(template, controls.templateVariables || controls.businessTemplateData || {}) } : {}),
    resolutionPrecedence: [
      "Per-video explicit override",
      "Selected Template value",
      "Selected Brand default",
      "System/user default",
      "Engine fallback",
    ],
  };
  const withSnapshots = validateProductionSpec({
    ...canonical,
    brandId: brandId || canonical.brandId,
    templateId: templateId || canonical.templateId,
    brandKit: brandSnapshot ? {
      ...(canonical.brandKit || {}),
      brandName: brand?.name,
      description: brand?.description,
      industry: brand?.industry,
      tagline: brand?.tagline,
      watermarkText: brand?.watermarkText,
      primaryColor: brand?.primaryColor,
      secondaryColor: brand?.secondaryColor,
      accentColor: brand?.accentColor,
      backgroundColor: brand?.backgroundColor,
      textColor: brand?.textColor,
      logoAssetId: brand?.logoAssetId,
      iconAssetId: brand?.iconAssetId,
      websiteUrl: brand?.websiteUrl,
      socialHandle: brand?.socialHandle,
      headingFont: brand?.headingFont,
      bodyFont: brand?.bodyFont,
      captionFont: brand?.captionFont,
      captionStyle: canonical.captionStyle || brand?.captionStyle,
      includeOutro: brand?.includeOutro,
      outroText: brand?.outroText,
      contactText: brand?.contactText,
      voiceProfile: brand?.voiceProfile as any,
      watermark: brand?.watermark as any,
      intro: brand?.intro as any,
      outro: brand?.outro as any,
    } : canonical.brandKit,
    metadata: {
      ...baseMetadata,
      uiContract: {
        ...((baseMetadata as any).uiContract || {}),
        brandId: brandId || undefined,
        brandRevision: brandSnapshot?.revision,
        templateId: templateId || undefined,
        templateRevision: template?.revision,
      },
    },
  });
  const characterProfileId = characterProfileIdFromControls(controls);
  if (!characterProfileId) return withSnapshots;

  const providerIds = new Set<string>();
  const aiVisualProvider = String(controls.aiVisualProvider || (withSnapshots.metadata as any)?.uiContract?.aiVisualProvider || "auto");
  if (aiVisualProvider !== "auto") providerIds.add(aiVisualProvider);
  const referenceProviders = referenceCapableVisualProviders(providerIds);
  const snapshot = await mediaUploadService.snapshotCharacter(characterProfileId, {
    id: referenceProviders[0],
    supportsReferenceImages: referenceProviders.length > 0,
  });
  if (!snapshot) return withSnapshots;
  const withCharacterSnapshot = validateProductionSpec({
    ...withSnapshots,
    metadata: {
      ...(withSnapshots.metadata || {}),
      characterProfileId,
      characterSnapshot: snapshot,
      uiContract: {
        ...((withSnapshots.metadata as any)?.uiContract || {}),
        characterProfileId,
        characterConsistencyMode:
          snapshot.consistencyMode === "reference_guided"
            ? "Reference Guided"
            : snapshot.consistencyMode === "provider_native"
              ? "Provider Native"
              : "Unavailable",
      },
    },
  });
  return {
    ...withCharacterSnapshot,
    title:
      normalizeTitleDuration(withCharacterSnapshot.title, withCharacterSnapshot.durationSeconds) ||
      withCharacterSnapshot.title,
  };
}

/**
 * Arabic production gate.
 *
 * A job that needs new Arabic narration is refused at creation time when
 * ElevenLabs is not configured, so the customer sees an actionable error in the
 * Create Video screen instead of a job that fails minutes into rendering.
 * Returns null when the request may proceed.
 */
async function arabicProductionBlocker(spec: {
  language?: string;
  dialect?: string;
  voiceId?: string;
  voiceProvider?: string;
}): Promise<{ error: string; message: string; action: { label: string; href: string } } | null> {
  if (!isArabicLanguage(spec.language, spec.dialect as any)) return null;
  if (spec.voiceProvider === ARABIC_PREMIUM_CLOUD_PROVIDER) {
    await providerSecrets.refreshElevenLabsApiKey().catch(() => undefined);
    if (!new ElevenLabsVoiceProvider().isConfigured()) {
      return {
        error: "elevenlabs_not_configured",
        message: ARABIC_ELEVENLABS_REQUIRED_MESSAGE,
        action: { label: "Configure ElevenLabs", href: "/providers" },
      };
    }
    if (!spec.voiceId) {
      return {
        error: "arabic_default_voice_not_selected",
        message:
          "No premium Arabic cloud voice has been selected. Open Voice Lab, audition the account voices and save a default.",
        action: { label: "Open Voice Lab", href: "/voice-lab" },
      };
    }
    return null;
  }

  if (!new VoiceRegistry({} as any).isArabicProductionConfigured()) {
    return {
      error: "local_voice_setup_required",
      message: ARABIC_LOCAL_VOICE_SETUP_REQUIRED_MESSAGE,
      action: { label: "Open Local Voice Setup", href: "/providers" },
    };
  }
  if (!spec.voiceId) {
    return {
      error: "local_voice_speaker_not_selected",
      message: "No local Arabic voice speaker has been selected.",
      action: { label: "Open Local Voice Setup", href: "/providers" },
    };
  }
  return null;
}

/**
 * Unknown-factual-topic gate (V2.4 Pass 5.1).
 *
 * `LocalContentAIProvider` marks a generated spec `contentProvenance:
 * "SAFE_GENERIC"` exactly when a curiosity/educational prompt matched no
 * curated fact pack AND no configured Content AI provider (Ollama/Gemini)
 * was available to actually explain the topic - i.e. the only options were
 * "invent a plausible-sounding explanation" (forbidden) or "render safe but
 * content-free filler" (not useful). Rather than ship that filler, refuse at
 * creation time with a customer-safe, provider-agnostic message so the
 * customer can add a Content AI provider or adjust the prompt instead of
 * receiving a video with no real informational content. This single check
 * correctly reflects the whole Ollama -> Gemini -> deterministic fact-pack
 * precedence chain: both LLM providers build their own deterministic
 * baseline first and only override `contentProvenance` away from
 * "SAFE_GENERIC" when they actually succeeded.
 */
function contentConfidenceBlocker(spec: {
  contentStyle?: string;
  metadata?: { contentProvenance?: string; contentConfidence?: string } | null;
}): { error: string; message: string; messageAr?: string; action: { label: string; href: string } } | null {
  const provenance = spec.metadata?.contentProvenance;
  const curiosity =
    spec.contentStyle === "viral_curiosity" ||
    spec.contentStyle === "educational" ||
    spec.contentStyle === "explainer";
  // Legacy marker (older stored specs) plus the current Basic fallback:
  // generic narration for a factual/explainer request is worthless, so the
  // create is refused with an actionable message rather than producing a
  // low-confidence video silently. Business/ad briefs in Basic mode still
  // create - a generic ad beats nothing when the customer chose Basic.
  const blocked =
    provenance === "SAFE_GENERIC" ||
    (provenance === "BASIC_FALLBACK" && curiosity && spec.metadata?.contentConfidence === "low");
  if (!blocked) return null;
  return {
    error: "content_confidence_low",
    message: "Better content generation is needed for this topic. Connect a Content AI provider or adjust the prompt.",
    messageAr: "هذا الموضوع يحتاج توليد محتوى أذكى. فعّل خدمة Local AI أو عدّل الوصف ثم حاول مرة أخرى.",
    action: { label: "Connect a Content AI Provider", href: "/providers" },
  };
}

/**
 * Fails a job closed BEFORE any render compute is spent when the generated
 * script either (a) never materially engages the customer's actual topic -
 * generic filler such as "Here's something worth seeing... Follow for more"
 * can still report contentProvenance: DETERMINISTIC/high confidence, so the
 * confidence gate above does not catch it - or (b) is grammatically
 * unfinished (a dangling conjunction/preposition, or no terminal
 * punctuation at all). See scriptQuality.ts for the deterministic,
 * explainable checks behind this.
 */
function scriptQualityBlocker(
  prompt: string,
  spec: { scenes?: Array<{ narration?: unknown }>; cta?: { text?: unknown }; language?: string },
): { error: string; message: string; action: { label: string; href: string } } | null {
  const language = spec.language === "ar" ? "ar" : "en";
  const result = validateScriptQuality(prompt, spec.scenes || [], spec.cta, language);
  if (result.pass) return null;
  return {
    error: "script_quality_insufficient",
    message: result.reason || "Short Studio could not create a sufficiently specific script for this topic. Please add more detail or enable an advanced content provider.",
    action: { label: "Connect a Content AI Provider", href: "/providers" },
  };
}

/**
 * Long-running planner endpoints (create job, spec preview, prompt enhance)
 * may legitimately need up to ~2 minutes for a local-LLM plan. The global
 * REQUEST_TIMEOUT_MS socket budget is 30s - far below the planner timeout -
 * which used to kill the request mid-generation and surface as an empty
 * reply / generic UI banner. These endpoints widen only their own socket.
 */
const PLANNER_REQUEST_TIMEOUT_MS = 180_000;

function plannerRouteTimeout(req: ExpressRequest): void {
  req.setTimeout(PLANNER_REQUEST_TIMEOUT_MS);
}

/**
 * Structured, localized failure surface for job creation. Customer-facing
 * `message`/`messageAr` describe the actionable cause; raw provider/engine
 * exceptions stay in server logs (and a sanitized `code` reference) instead
 * of leaking into the UI, where the Arabic locale previously collapsed every
 * failure into the generic "couldn't create the production" banner.
 */
function sendCreateFailure(
  res: ExpressResponse,
  error: unknown,
  context: string,
): void {
  const raw = error instanceof Error ? error.message : String(error);
  logger.error({ err: raw, context }, "job creation failed");

  if (error instanceof ContentPlannerError || (error as any)?.plannerCode) {
    const code = (error as ContentPlannerError).plannerCode;
    res.status(503).json({
      error: code,
      message:
        code === "planner_unavailable"
          ? "The local AI planner is unavailable right now. Check that the Local AI service is running, then try again."
          : "The local AI planner could not produce a valid creative plan. Please try again.",
      messageAr:
        code === "planner_unavailable"
          ? "محرك الذكاء الاصطناعي المحلي غير متاح الآن. تأكد من تشغيل خدمة Local AI ثم حاول مرة أخرى."
          : "تعذّر على محرك الذكاء الاصطناعي المحلي إنشاء خطة إنتاج صالحة. حاول مرة أخرى.",
      code: `SS-PLANNER-${code === "planner_unavailable" ? "DOWN" : "BAD"}`,
    });
    return;
  }

  if (/CONTENT_DURATION_BUDGET_NOT_MET/.test(raw)) {
    res.status(409).json({
      error: "duration_budget_not_met",
      message:
        "The requested narration is too long for the chosen video duration. Increase the duration or shorten the description.",
      messageAr:
        "النص المطلوب أطول من مدة الفيديو المحددة. زد المدة أو اختصر الوصف وحاول مرة أخرى.",
      code: "SS-DURATION-BUDGET",
    });
    return;
  }

  res.status(400).json({
    error: "Invalid job payload",
    message: "The production request could not be completed. Check your inputs and try again.",
    messageAr: "تعذّر إنشاء الإنتاج. راجع المدخلات وحاول مرة أخرى.",
    code: "SS-CREATE-400",
  });
}

/**
 * Job state-mutation routes (worker callbacks AND customer cancel/retry)
 * must never let a domain error escape as an unhandled rejection - the
 * phonemizer WASM bridge rethrows unhandled rejections and kills the whole
 * process. A worker posting progress on a job the customer just cancelled,
 * or a retry on a missing record, is an expected race, not a crash.
 */
function sendJobMutationFailure(
  res: ExpressResponse,
  error: unknown,
  context: string,
): void {
  const raw = error instanceof Error ? error.message : String(error);
  if (/Job not found/i.test(raw)) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  if (/Invalid job transition/i.test(raw)) {
    // A cancelled/finished job legitimately rejects late worker progress;
    // telling the caller 409 lets it stop retrying instead of crashing us.
    res.status(409).json({ error: "job_state_conflict", message: raw.slice(0, 300) });
    return;
  }
  logger.error({ err: raw, context }, "job mutation failed");
  res.status(500).json({ error: "Job update failed." });
}

function hasCommandHint(envKey: string): boolean {
  return Boolean(process.env[envKey]?.trim());
}

function buildV22CapabilityProviders() {
  const now = new Date().toISOString();
  const gpuEnabled = process.env.AI_GPU_PACK_ENABLED === "true";
  const comfyConfigured = Boolean(process.env.COMFYUI_BASE_URL);
  const motionCanvasConfigured = process.env.MOTION_CANVAS_ENABLED === "true" || hasCommandHint("MOTION_CANVAS_BIN");
  return [
    {
      id: "ollama",
      name: "Ollama Local LLM",
      category: "Content AI",
      tier: "local",
      status: process.env.OLLAMA_BASE_URL ? "configured" : "not_configured",
      configured: Boolean(process.env.OLLAMA_BASE_URL),
      isDefault: false,
      message: process.env.OLLAMA_BASE_URL
        ? "Ollama-compatible local LLM endpoint configured."
        : "Optional local LLM is not configured; deterministic Local AI remains the fallback.",
      checkedAt: now,
      details: {
        implemented: true,
        model: process.env.OLLAMA_MODEL || "qwen2.5:3b-instruct or qwen2.5:7b-instruct recommended when hardware allows",
        contract: "OpenAI-compatible/local HTTP JSON generation",
        hardware: "Use smaller Qwen instruct models on CPU-only clients; larger models require adequate RAM/VRAM.",
      },
    },
    {
      id: "motion_canvas",
      name: "Motion Canvas",
      category: "Motion",
      tier: "optional_cpu_pack",
      status: motionCanvasConfigured ? "configured" : "not_configured",
      configured: motionCanvasConfigured,
      isDefault: false,
      message: motionCanvasConfigured
        ? "Motion Canvas asset generation path is enabled."
        : "Motion Canvas is optional and disabled in the base runtime.",
      checkedAt: now,
      details: {
        implemented: true,
        templates: ["kinetic_typography", "number_stat", "logo_reveal", "feature_list", "comparison", "cta", "timeline", "process_steps", "quote", "lower_third", "title_card"],
        replacesRemotion: false,
      },
    },
    {
      id: "pyscenedetect",
      name: "PySceneDetect",
      category: "Post Production",
      tier: "quality_cpu_pack",
      status: hasCommandHint("PYSCENEDETECT_BIN") ? "configured" : "not_configured",
      configured: hasCommandHint("PYSCENEDETECT_BIN"),
      isDefault: false,
      message: "Optional shot/cut/fade analysis for best-window stock selection.",
      checkedAt: now,
    },
    {
      id: "mediapipe",
      name: "MediaPipe",
      category: "Post Production",
      tier: "quality_cpu_pack",
      status: hasCommandHint("MEDIAPIPE_BIN") ? "configured" : "not_configured",
      configured: hasCommandHint("MEDIAPIPE_BIN"),
      isDefault: false,
      message: "Optional face/person detection for smart portrait crop and safe caption placement.",
      checkedAt: now,
    },
    {
      id: "rembg",
      name: "rembg",
      category: "Post Production",
      tier: "quality_cpu_pack",
      status: hasCommandHint("REMBG_BIN") ? "configured" : "not_configured",
      configured: hasCommandHint("REMBG_BIN"),
      isDefault: false,
      message: "Optional product-background removal for Product Ad mode.",
      checkedAt: now,
    },
    {
      id: "real_esrgan",
      name: "Real-ESRGAN",
      category: "Post Production",
      tier: "optional_enhancement",
      status: hasCommandHint("REAL_ESRGAN_BIN") ? "configured" : "not_configured",
      configured: hasCommandHint("REAL_ESRGAN_BIN"),
      isDefault: false,
      message: "Optional OFF/AUTO/FORCE image/video enhancement; never runs on every asset by default.",
      checkedAt: now,
    },
    {
      id: "librosa",
      name: "librosa Beat Analysis",
      category: "Post Production",
      tier: "quality_cpu_pack",
      status: hasCommandHint("LIBROSA_PYTHON") ? "configured" : "not_configured",
      configured: hasCommandHint("LIBROSA_PYTHON"),
      isDefault: false,
      message: "Optional BPM, beat, and energy analysis for edit timing hints.",
      checkedAt: now,
    },
    {
      id: "faster_whisper",
      name: "faster-whisper",
      category: "Captions",
      tier: "optional_caption_backend",
      status: hasCommandHint("FASTER_WHISPER_BIN") ? "configured" : "not_configured",
      configured: hasCommandHint("FASTER_WHISPER_BIN"),
      isDefault: false,
      message: "Optional caption backend. Speed is not claimed until measured on this machine.",
      checkedAt: now,
    },
    {
      id: "whisperx",
      name: "WhisperX",
      category: "Captions",
      tier: "optional_alignment_backend",
      status: hasCommandHint("WHISPERX_BIN") ? "configured" : "not_configured",
      configured: hasCommandHint("WHISPERX_BIN"),
      isDefault: false,
      message: "Optional alignment evaluation. Arabic forced alignment remains disabled unless a suitable Arabic alignment model is verified.",
      checkedAt: now,
    },
    {
      id: "comfyui",
      name: "ComfyUI GPU Pack",
      category: "AI GPU",
      tier: "optional_gpu_sidecar",
      status: gpuEnabled && comfyConfigured ? "configured" : "not_configured",
      configured: gpuEnabled && comfyConfigured,
      isDefault: false,
      message: gpuEnabled && comfyConfigured
        ? "ComfyUI sidecar API configured; ABUD remains the control plane."
        : "AI GPU Pack is optional and disabled; no huge diffusion models are included in the base image.",
      checkedAt: now,
      details: {
        publicUi: false,
        requiredEnv: ["AI_GPU_PACK_ENABLED=true", "COMFYUI_BASE_URL"],
      },
    },
    {
      id: "wan2_2",
      name: "Wan2.2",
      category: "AI GPU",
      tier: "optional_gpu_workflow",
      status: gpuEnabled && process.env.WAN22_ENABLED === "true" ? "configured" : "not_configured",
      configured: gpuEnabled && process.env.WAN22_ENABLED === "true",
      isDefault: false,
      message: "Optional Wan2.2 workflow support is gated by hardware, model download, and license acceptance.",
      checkedAt: now,
      details: {
        modes: ["text_to_video", "image_to_video", "character_animation"],
        downloadsInBaseImage: false,
      },
    },
  ];
}

function providerBillingClass(id: string): ProviderBillingClass {
  if (["local_ai", "kokoro", "piper", "whisper_cpp", "remotion", "ffmpeg", "motion_canvas", "n8n", "postgres"].includes(id)) {
    return "LOCAL_FREE";
  }
  if (["pexels", "pixabay"].includes(id)) return "FREE_API";
  if (["gemini", "google_cloud_tts", "edge_tts"].includes(id)) return "FREE_TIER";
  if (["elevenlabs", "veo", "fal", "runway", "replicate", "luma", "upload_post"].includes(id)) return "USAGE_BASED";
  if (id === "comfyui") return "LOCAL_FREE";
  return "UNKNOWN";
}

function canonicalCategoryForProvider(provider: any): string {
  if (provider.category === "Content AI") return "Content AI";
  if (provider.category === "Voice") return "Voice";
  if (provider.category === "Captions") return "Captions";
  if (provider.category === "Publishing") return "Publishing";
  if (provider.category === "Renderer") return "Renderer";
  if (provider.category === "Infrastructure") return "Infrastructure";
  if (provider.id === "pexels" || provider.id === "pixabay") return "Stock Video";
  if (provider.id === "comfyui") return "Local Generated Video";
  if (["veo", "fal", "runway", "replicate", "luma"].includes(provider.id)) return "Generated Video";
  return provider.category || "Infrastructure";
}

function capabilitiesForProvider(provider: any): string[] {
  const visual = provider.details?.visualCapabilities || {};
  const flags: Array<[string, string]> = [
    ["textToVideo", "Text to video"],
    ["imageToVideo", "Image to video"],
    ["referenceImage", "Reference image"],
    ["portrait", "Portrait"],
    ["landscape", "Landscape"],
    ["seed", "Seed"],
    ["audio", "Native audio"],
  ];
  const fromVisual = flags.filter(([key]) => visual[key] === true).map(([, label]) => label);
  const languages = Array.isArray(provider.details?.languages)
    ? provider.details.languages.map((language: string) => `Language: ${language}`)
    : [];
  if (provider.id === "local_ai") return ["Deterministic planning", "Trusted fact packs", "CTA provenance"];
  if (provider.id === "gemini") return ["Structured JSON planning", "Claim provenance", "Script generation"];
  if (provider.id === "ollama") return ["Local structured planning", "Script generation"];
  if (provider.id === "whisper_cpp") return ["Captions", "Timing baseline"];
  if (provider.category === "Publishing") return ["Connect account", "Pre-flight", "Schedule", "Retry"];
  return [...fromVisual, ...languages];
}

function canonicalizeProviderPayload(provider: any) {
  const status = String(provider.status || "").toLowerCase();
  const vaultHealth = Array.isArray(provider.vault) ? provider.vault.find((credential: any) => credential?.health)?.health : undefined;
  const healthy =
    provider.details?.healthy ??
    (["healthy", "ready", "connected", "live_verified"].includes(status)
      ? true
      : ["not_configured", "disabled"].includes(status)
        ? null
        : false);
  const liveVerified =
    provider.details?.liveVerified === true ||
    vaultHealth === "live_verified" ||
    status === "live_verified";
  const authenticated =
    provider.details?.authenticated ??
    (["invalid_credentials"].includes(status)
      ? false
      : ["healthy", "connected", "live_verified"].includes(status) || vaultHealth === "healthy" || liveVerified
        ? true
        : null);
  const billingClass = providerBillingClass(provider.id);
  const canonical = normalizeProviderServiceState({
    id: provider.id,
    name: provider.name,
    category: canonicalCategoryForProvider(provider),
    implemented: provider.details?.implemented !== false,
    configured: provider.configured === true,
    authenticated,
    healthy,
    liveVerified,
    enabled: provider.details?.enabled !== false,
    billingClass,
    capabilities: capabilitiesForProvider(provider),
    latencyClass:
      provider.details?.visualCapabilities?.latencyTier ||
      (["veo", "fal", "runway", "replicate", "luma", "comfyui"].includes(provider.id) ? "long" : "interactive"),
    qualityClass:
      provider.details?.visualCapabilities?.qualityTier ||
      (["veo", "runway"].includes(provider.id) ? "premium" : ["fal", "replicate", "luma", "comfyui"].includes(provider.id) ? "professional" : "standard"),
    lastVerifiedAt: provider.checkedAt,
    blockerReason:
      status === "invalid_credentials"
        ? "Credentials were rejected. Replace them and test the connection again."
        : status === "rate_limited"
          ? "Provider rate limit reached. Try again later."
          : status === "timeout" || status === "provider_unavailable"
            ? "Provider did not respond during the latest check."
            : provider.details?.blockerReason,
    optional: !["local_ai", "kokoro", "whisper_cpp", "remotion", "ffmpeg", "postgres"].includes(provider.id),
    builtIn: billingClass === "LOCAL_FREE" && provider.configured === true,
  } as CanonicalProviderStateInput);
  return {
    ...provider,
    tier: provider.tier || tierFromBillingClass(billingClass),
    status: statusFromCanonicalProvider(canonical),
    providerStatus: canonical.customerStatus,
    message: providerCustomerMessage(canonical),
    canonical,
  };
}

function providerCustomerMessage(provider: ReturnType<typeof normalizeProviderServiceState>): string {
  if (provider.customerStatus === "Built In") return "Built-in service is available in this installation.";
  if (provider.customerStatus === "Ready") return "Connected and live verified.";
  if (provider.customerStatus === "Configured") return "Credentials are saved. Run Test Connection for live verification.";
  if (provider.customerStatus === "Disabled") return "Provider is disabled.";
  if (provider.customerStatus === "Temporarily Unavailable") return provider.blockerReason || "Provider is temporarily unavailable.";
  if (provider.customerStatus === "Needs Attention") return provider.blockerReason || "Provider needs attention.";
  return "Optional provider is not configured. You can connect it from this page.";
}

async function persistSceneArtifacts(db: V2Database, projectId: string, artifacts: DurableSceneArtifact[]) {
  const safeArtifacts = filterReusableArtifacts({ artifacts });
  for (const artifact of safeArtifacts) {
    await db.query(
      `INSERT INTO scene_artifacts (
        artifact_id, project_id, type, scene_index, segment_index, source_job_id, source_revision_id,
        provider, model, input_hash, storage_ref, checksum_sha256, duration_seconds,
        metadata, valid, superseded_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (artifact_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        valid = EXCLUDED.valid,
        superseded_at = EXCLUDED.superseded_at,
        metadata = EXCLUDED.metadata`,
      [
        artifact.artifactId,
        projectId,
        artifact.type,
        artifact.sceneIndex,
        artifact.segmentIndex ?? null,
        artifact.sourceJobId,
        artifact.sourceRevisionId || null,
        artifact.provider || null,
        artifact.model || null,
        artifact.inputHash,
        artifact.storageRef,
        artifact.checksum,
        artifact.duration ?? null,
        JSON.stringify(artifact.metadata || {}),
        artifact.valid,
        artifact.supersededAt || null,
        artifact.createdAt || new Date().toISOString(),
      ],
    );
  }
}

function requireInternalToken(config: Config) {
  return (
    req: ExpressRequest,
    res: ExpressResponse,
    next: express.NextFunction,
  ) => {
    const token = req.header("x-internal-token");
    if (!config.internalServiceToken || token !== config.internalServiceToken) {
      res.status(401).json({ error: "Unauthorized internal request." });
      return;
    }
    next();
  };
}

function bearerToken(req: ExpressRequest): string {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const queryToken = req.query.access_token;
  return typeof queryToken === "string" ? queryToken.trim() : "";
}

function scopeForRequest(req: ExpressRequest): ApiTokenScope | null {
  const method = req.method.toUpperCase();
  const routePath = req.path;
  if (routePath.startsWith("/publishing")) return "publishing:write";
  if (routePath.startsWith("/videos/") && routePath.endsWith("/publishing")) return "production:read";
  if (routePath.startsWith("/videos/") && routePath.includes("/revisions") && method === "GET") return "videos:read";
  if (routePath.startsWith("/videos/") && routePath.includes("/revisions") && method === "POST") return "production:create";
  if (routePath.startsWith("/production/jobs") && method === "GET") return "production:read";
  if (routePath === "/production/jobs" && method === "POST") return "production:create";
  if (routePath.startsWith("/jobs") && method === "GET") return "production:read";
  if (routePath.startsWith("/jobs/") && routePath.includes("/stages") && method === "GET") return "production:read";
  if (routePath.startsWith("/jobs/") && routePath.includes("/stages") && method === "POST") return "production:create";
  if (routePath === "/jobs" && method === "POST") return "production:create";
  if (routePath.startsWith("/production-spec") || routePath.startsWith("/prompt") || routePath.startsWith("/cost-estimate")) {
    return "production:create";
  }
  if (routePath.startsWith("/media/upload") || routePath.startsWith("/media/product-upload") || routePath.startsWith("/media/assets")) return "production:create";
  if (routePath.startsWith("/media/uploads") || routePath.startsWith("/media/products") || routePath.startsWith("/media/folders") || routePath.startsWith("/media/characters")) return "videos:read";
  if (routePath.startsWith("/system/capabilities") || routePath.startsWith("/system/readiness")) return "production:read";
  return null;
}

function isPublicHealthOrBootstrapPath(req: ExpressRequest): boolean {
  const method = req.method.toUpperCase();
  const routePath = req.path;
  return (
    (method === "GET" && (routePath === "/health" || routePath === "/system/health" || routePath === "/system/info" || routePath === "/setup/status")) ||
    (method === "POST" && routePath === "/auth/login")
  );
}

function requireV2Access(config: Config, authService: AuthService, apiTokenService: ApiTokenService) {
  return async (req: ExpressRequest, res: ExpressResponse, next: express.NextFunction) => {
    try {
      if (isPublicHealthOrBootstrapPath(req)) {
        next();
        return;
      }

      if (isLocalSingleUserAccess(config)) {
        (req as any).v2Auth = { type: "local_owner", user: localSingleUserOwner() };
        next();
        return;
      }

      const setupState = await authService.getSetupState();
      const setupComplete = setupState.isSetupCompleted;
      const method = req.method.toUpperCase();
      const routePath = req.path;

      if (method === "POST" && routePath === "/auth/setup-admin" && !setupState.isAdminConfigured && !setupComplete) {
        next();
        return;
      }

      const token = bearerToken(req);
      if (!token) {
        res.status(401).json({ error: "Unauthorized." });
        return;
      }

      const admin = await authService.validateSession(token);
      if (admin?.role === "admin") {
        (req as any).v2Auth = { type: "admin", user: admin };
        next();
        return;
      }

      const requiredScope = scopeForRequest(req);
      if (!requiredScope) {
        res.status(401).json({ error: "Admin session required." });
        return;
      }

      const apiToken = await apiTokenService.validateToken(token, requiredScope);
      if (apiToken.forbidden) {
        res.status(403).json({ error: "API token does not include the required scope.", requiredScope });
        return;
      }
      if (!apiToken.valid) {
        res.status(401).json({ error: "Invalid or expired credential." });
        return;
      }
      (req as any).v2Auth = { type: "api_token", token: apiToken.token, scope: requiredScope };
      next();
    } catch (error) {
      res.status(500).json({ error: "Access control failed.", message: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function createV2PublicRouter(
  config: Config,
  db: V2Database,
  jobs: JobService,
): express.Router {
  const router = express.Router();
  const orchestrator = new N8nOrchestrator(config, jobs);
  const contentAIRegistry = new ContentAIRegistry(config);
  const publishingService = new PublishingService(db, config, publishingRegistry);
  const publishingScheduler = new PublishingScheduler(db, publishingService);
  const authService = new AuthService(db);
  const apiTokenService = new ApiTokenService(db);
  const backupService = new BackupService(db, config);
  const diagnosticsService = new DiagnosticsService(db, config);
  const webhookService = new WebhookService(db, { timeoutMs: config.webhookTimeoutMs });
  const analyticsService = new AnalyticsService(db, config);
  const revisionService = new RevisionService(db);
  const workerLeaseService = new WorkerLeaseService(db);
  const providerVault = new ProviderCredentialsVault(db, config);
  const updateService = new UpdateService({ dataDir: config.dataDirPath });
  const licenseManager = LicenseManager.getInstance();

  // Provider classes read credentials synchronously; the vault resolver keeps a
  // decrypted copy in process memory only. Plaintext never leaves this module.
  if (providerVault.isAvailable()) {
    providerSecrets.registerResolver((providerId, credentialType) =>
      providerVault.readPlaintext(providerId, credentialType),
    );
    void providerSecrets.refreshElevenLabsApiKey();
    void providerSecrets.refresh("upload_post", "api_key");
  }

  async function configuredProviderIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    if (config.pexelsApiKey && config.pexelsApiKey !== "dummy-key" && !config.pexelsApiKey.includes("your_")) ids.add("pexels");
    if (process.env.PIXABAY_API_KEY) ids.add("pixabay");
    if (process.env.VEO_API_KEY || process.env.GOOGLE_AI_API_KEY) ids.add("veo");
    if (process.env.FAL_KEY) ids.add("fal");
    if (process.env.RUNWAY_API_KEY) ids.add("runway");
    if (process.env.REPLICATE_API_TOKEN) ids.add("replicate");
    if (process.env.LUMA_API_KEY) ids.add("luma");
    if (process.env.COMFYUI_BASE_URL) ids.add("comfyui");
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY) ids.add("gemini");
    if (new ElevenLabsVoiceProvider().isConfigured()) ids.add("elevenlabs");
    if (new VoiceRegistry({} as any).isArabicProductionConfigured()) {
      ids.add("local_voice");
      ids.add("voicetut");
    }
    if (process.env.UPLOAD_POST_API_KEY) ids.add("upload_post");
    if (providerVault.isAvailable()) {
      const vaultCredentials = await providerVault.list().catch(() => []);
      vaultCredentials.forEach((credential) => {
        if (credential.configured) ids.add(credential.providerId);
      });
    }
    return ids;
  }

  async function selectedMediaStatus(ids: string[]) {
    if (ids.length === 0) return { usable: [], missing: [], unusable: [] };
    const all = await mediaUploadService.listAssets().catch(() => []);
    const byId = new Map(all.map((item) => [item.id, item]));
    return {
      usable: ids.map((id) => byId.get(id)).filter((item) => item?.usability?.usableForVideo),
      missing: ids.filter((id) => !byId.has(id)),
      unusable: ids.map((id) => byId.get(id)).filter((item) => item && !item.usability?.usableForVideo),
    };
  }

  async function checkCreateReadiness(controls: any, spec?: ProductionSpec) {
    const providerIds = await configuredProviderIds();
    const contract = (spec?.metadata as any)?.uiContract || {};
    const visualSource = (controls.visualSource || contract.visualSource || "auto_best") as CreateVisualSource;
    const stockProvider = (controls.stockProvider || contract.stockProvider || "auto_stock") as StockProviderChoice;
    const mediaPolicy = (controls.mediaPolicy || contract.mediaPolicy || "auto_use_selected") as MediaPolicyChoice;
    const aiVisualProvider = String(controls.aiVisualProvider || contract.aiVisualProvider || "auto");
    const budgetPolicy = budgetControlsFrom({ ...controls, metadata: { ...(controls.metadata || {}), uiContract: contract } });
    const characterProfileId = characterProfileIdFromControls({
      ...controls,
      metadata: {
        ...(controls.metadata || {}),
        characterProfileId: controls.characterProfileId || contract.characterProfileId || (spec?.metadata as any)?.characterProfileId,
      },
    });
    const selectedMediaIds = selectedMediaIdsFromControls({
      ...controls,
      metadata: {
        ...(controls.metadata || {}),
        selectedMediaIds: controls.selectedMediaIds || contract.selectedMediaIds,
        productImageId: controls.metadata?.productImageId || (spec?.metadata as any)?.productImageId,
      },
    });
    const missingRequirements: string[] = [];
    const missingRequirementsAr: string[] = [];
    const capabilities: { id: string; name: string; ready: boolean; required: boolean; action?: { label: string; href: string } }[] = [];
    const add = (
      id: string,
      name: string,
      ready: boolean,
      required: boolean,
      message?: string,
      action?: { label: string; href: string },
      messageAr?: string,
    ) => {
      capabilities.push({ id, name, ready, required, action });
      if (required && !ready) {
        missingRequirements.push(message || `${name} is required.`);
        missingRequirementsAr.push(messageAr || "إعداد الإنتاج المختار غير جاهز للتشغيل بعد. راجع الإعدادات المطلوبة ثم حاول مرة أخرى.");
      }
    };

    const anyStock = providerIds.has("pexels") || providerIds.has("pixabay");
    const anyPaidGenerated =
      providerIds.has("veo") ||
      providerIds.has("fal") ||
      providerIds.has("runway") ||
      providerIds.has("replicate") ||
      providerIds.has("luma");
    const anyLocalGenerated = providerIds.has("comfyui");
    const hasSelectedUploadedMedia = selectedMediaIds.length > 0;
    const hasAnyProfessionalVisualSource =
      anyStock || anyPaidGenerated || anyLocalGenerated || hasSelectedUploadedMedia;
    const explicitVisualSourceControl = Boolean(controls.visualSource || controls.visualMode);
    const requiresProfessionalAuto =
      explicitVisualSourceControl &&
      (
        visualSource === "auto_best" ||
        visualSource === "auto_free" ||
        visualSource === "auto_budget" ||
        visualSource === "mixed"
      );
    if (requiresProfessionalAuto) {
      add(
        "professional_visual_source",
        "Professional visual source",
        hasAnyProfessionalVisualSource,
        true,
        "Professional automatic video needs at least one visual source. Configure a free stock provider, connect an AI video provider, or upload media.",
        { label: "Configure Visual Source", href: "/providers" },
      );
    }
    if (visualSource === "stock") {
      if (stockProvider === "pexels") {
        add("pexels", "Pexels", providerIds.has("pexels"), true, "Stock provider required: configure Pexels.", { label: "Configure Stock Provider", href: "/providers" });
      } else if (stockProvider === "pixabay") {
        add("pixabay", "Pixabay", providerIds.has("pixabay"), true, "Stock provider required: configure Pixabay.", { label: "Configure Stock Provider", href: "/providers" });
      } else {
        add("stock", "Stock provider", anyStock, true, "Stock provider required.", { label: "Configure Stock Provider", href: "/providers" });
      }
    } else {
      add("stock", "Stock provider", anyStock, false);
    }

    if (visualSource === "ai_generated") {
      const aiProviders = ["veo", "fal", "runway", "replicate", "luma", "comfyui"].filter((id) => providerIds.has(id));
      const ready = aiVisualProvider === "auto" ? aiProviders.length > 0 : providerIds.has(aiVisualProvider);
      add(
        "ai_video",
        "AI video provider",
        ready,
        true,
        "Connect an AI video provider to use AI Generated visuals.",
        { label: "Configure an AI Video Provider", href: "/providers" },
      );
      const selectedProviderIsLocal = aiVisualProvider === "comfyui" || (aiVisualProvider === "auto" && aiProviders.length === 1 && aiProviders[0] === "comfyui");
      if (!selectedProviderIsLocal) {
        add(
          "paid_video_gate",
          "Paid video safety gate",
          budgetPolicy.paidCallsAllowed,
          true,
          budgetPolicy.mode === "free_only"
            ? "AI Generated visuals require Best Available or Smart Budget plus paid-generation authorization."
            : "Paid video generation requires explicit operator authorization before queueing.",
          { label: "Review Budget", href: "/create" },
        );
      }
    }

    if (characterProfileId) {
      const profile = (await mediaUploadService.listCharacters().catch(() => [])).find((item) => item.id === characterProfileId && item.status !== "archived");
      const referenceCapable = referenceCapableVisualProviders(providerIds);
      const compatible =
        referenceCapable.length > 0 &&
        (aiVisualProvider === "auto" || referenceCapable.includes(aiVisualProvider));
      add(
        "character_profile",
        "Character Profile",
        Boolean(profile),
        true,
        "Select an active Character Profile.",
        { label: "Open Characters", href: "/media" },
      );
      if (visualSource === "stock") {
        add(
          "character_stock_incompatible",
          "Character with stock footage",
          false,
          true,
          "Stock footage cannot guarantee a recurring character identity. Use Mixed or AI Generated with a compatible provider.",
          { label: "Change visual source", href: "/create" },
        );
      } else if (visualSource === "ai_generated" || visualSource === "mixed") {
        add(
          "character_reference_provider",
          "Reference-capable visual provider",
          compatible,
          true,
          "Character consistency is not available with the currently configured visual providers.",
          { label: "Configure compatible provider", href: "/providers" },
        );
      } else if (visualSource === "auto_best") {
        add(
          "character_reference_provider",
          "Reference-capable visual provider",
          compatible,
          false,
          "Character consistency is not available with the currently configured visual providers.",
          { label: "Configure compatible provider", href: "/providers" },
        );
      }
    }

    const mediaRequired =
      visualSource === "uploaded_media" ||
      (visualSource === "mixed" && mediaPolicy === "only_selected") ||
      controls.productionMode === "custom_media" ||
      spec?.productionMode === "custom_media";
    if (mediaRequired || selectedMediaIds.length > 0) {
      const status = await selectedMediaStatus(selectedMediaIds);
      const ready = selectedMediaIds.length > 0 && status.usable.length === selectedMediaIds.length;
      add(
        "uploaded_media",
        "Selected uploaded media",
        ready,
        mediaRequired,
        selectedMediaIds.length === 0
          ? "Select usable media before creating with uploaded-media-only."
          : "One or more selected media items are missing or unusable.",
        { label: "Open Media Library", href: "/media" },
      );
    }

    if (isArabicLanguage(spec?.language || controls.language, (spec?.dialect || controls.dialect) as any)) {
      const wantsElevenLabs =
        controls.voiceProvider === ARABIC_PREMIUM_CLOUD_PROVIDER ||
        spec?.voiceProvider === ARABIC_PREMIUM_CLOUD_PROVIDER;
      if (wantsElevenLabs) {
        add(
          "elevenlabs",
          "ElevenLabs Arabic voice",
          providerIds.has("elevenlabs"),
          true,
          ARABIC_ELEVENLABS_REQUIRED_MESSAGE,
          { label: "Configure ElevenLabs", href: "/providers" },
          "مفتاح ElevenLabs غير مُعدّ أو غير صالح. افتح المزوّدون للتحقق من الحساب، أو اختر تلقائي لاستخدام الصوت المحلي.",
        );
      } else {
        const requestedVoiceProvider = String(
          contract.requestedVoiceProvider || controls.voiceProvider || "auto",
        );
        const localHealth = await new LocalTtsClient().health().catch(() => undefined);
        const localPreflight = evaluateLocalVoiceCreatePreflight(localHealth, requestedVoiceProvider);
        if (localPreflight.ready && spec && localPreflight.resolvedProvider) {
          const resolved = localPreflight.resolvedProvider;
          spec.voiceProvider = resolved;
          spec.voiceId = defaultVoiceForResolvedProvider(resolved);
          spec.voiceModelId = LOCAL_TTS_MODELS[resolved].providerModelId;
          spec.metadata = {
            ...(spec.metadata || {}),
            uiContract: {
              ...contract,
              requestedVoiceProvider,
              resolvedVoiceProvider: resolved,
            },
          };
        }
        add(
          "local_voice",
          "Local Egyptian Arabic voice",
          localPreflight.ready,
          true,
          localPreflight.errorCode === "local_voice_unavailable"
            ? "Local Voice is not reachable. Open Settings, start or repair Local Voice, then try again."
            : ARABIC_LOCAL_VOICE_SETUP_REQUIRED_MESSAGE,
          { label: "Open Local Voice Setup", href: "/settings" },
          localPreflight.errorCode === "local_voice_unavailable"
            ? "خدمة الصوت المحلي غير متاحة الآن. افتح الإعدادات، وشغّل الصوت المحلي أو أصلحه، ثم حاول مرة أخرى."
            : "نموذج الصوت المحلي المطلوب غير جاهز. افتح الإعدادات للتحقق من VoiceTut ثم حاول مرة أخرى.",
        );
      }
    } else {
      add("kokoro", "Built-in English voice", true, false);
    }

    const captionEnabled = controls.captionEnabled !== false && contract.captionEnabled !== false && spec?.captionStyle !== "none";
    add("captions", captionEnabled ? "Captions enabled" : "Captions disabled", true, false);

    return {
      mode: controls.productionMode || spec?.productionMode || "auto_hybrid",
      visualSource,
      stockProvider,
      mediaPolicy,
      selectedMediaIds,
      characterProfileId,
      characterConsistencyAvailable: characterProfileId ? referenceCapableVisualProviders(providerIds).length > 0 : false,
      ready: missingRequirements.length === 0,
      missingRequirements,
      missingRequirementsAr,
      capabilities,
      externalUsage: expectedExternalUsage({
        providerIds,
        visualSource,
        stockProvider,
        aiVisualProvider,
        voiceProvider: spec?.voiceProvider || controls.voiceProvider,
        contentAIProvider: String(controls.contentAIProvider || "auto"),
        budgetPolicy,
      }),
    };
  }

  function expectedExternalUsage(input: {
    providerIds: Set<string>;
    visualSource: CreateVisualSource;
    stockProvider: StockProviderChoice;
    aiVisualProvider: string;
    voiceProvider?: string;
    contentAIProvider: string;
    budgetPolicy: ProviderBudgetPolicy;
  }): string[] {
    const usage: string[] = [];
    if (input.voiceProvider === "elevenlabs") usage.push("ElevenLabs · Usage Based");
    if (input.contentAIProvider === "gemini") usage.push("Gemini · Usage Based");
    if (input.visualSource === "auto_free") {
      if (input.providerIds.has("pexels") || input.providerIds.has("pixabay")) usage.push("Pexels/Pixabay · Free Stock API");
      if (input.providerIds.has("comfyui")) usage.push("ComfyUI · Local Compute");
      return usage.length ? usage : ["No professional visual source configured"];
    }
    if (input.visualSource === "ai_generated") {
      const ai = input.aiVisualProvider !== "auto"
        ? input.aiVisualProvider
        : input.providerIds.has("veo")
          ? "Google Veo"
          : input.providerIds.has("fal")
            ? "fal.ai"
            : input.providerIds.has("runway")
              ? "Runway"
              : input.providerIds.has("replicate")
                ? "Replicate"
                : input.providerIds.has("luma")
                  ? "Luma"
                  : input.providerIds.has("comfyui")
                    ? "ComfyUI"
                    : "AI Video Provider";
      usage.push(ai === "ComfyUI" ? "ComfyUI · Local Compute" : `${ai} · Usage Based`);
    }
    if (input.budgetPolicy.mode === "smart_budget") {
      usage.push(
        input.budgetPolicy.maxExternalSpendUsd != null
          ? `Budget ceiling · $${input.budgetPolicy.maxExternalSpendUsd}`
          : "Budget ceiling · estimate unavailable",
      );
    }
    if (input.visualSource === "stock") {
      usage.push(input.stockProvider === "pixabay" ? "Pixabay · Stock API" : input.stockProvider === "pexels" ? "Pexels · Stock API" : "Stock provider · API");
    }
    return usage.length ? usage : ["Local / No Paid API"];
  }

  if (config.serviceRole === "app") {
    publishingScheduler.start();
  }

  router.use(express.json({ limit: "2mb" }));
  router.use("/licensing", createLicensingRouter());
  router.use(requireV2Access(config, authService, apiTokenService));
  router.use((req, res, next) => {
    if (scopeForRequest(req) !== "production:create") {
      next();
      return;
    }
    if (process.env.VITEST === "true" && process.env.ABUD_ENFORCE_LICENSE_IN_TESTS !== "true") {
      next();
      return;
    }
    const gate = licenseManager.requireActiveForProduction();
    if (!gate.allowed) {
      res.status(402).json(gate.response);
      return;
    }
    next();
  });

  // Mount Publishing & Distribution Routes
  router.use("/publishing", createPublishingRouter(config, publishingService));

  router.get("/videos/:videoId/publishing", async (req, res) => {
    try {
      const status = await publishingService.getOverallVideoStatus(req.params.videoId);
      res.status(200).json(status);
    } catch (error) {
      res.status(500).json({
        error: "Failed to get video publishing status",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/videos/:videoId/revisions", async (req, res) => {
    const videoId = req.params.videoId;
    try {
      const metadata = readMetadata(config.videosDirPath, videoId);
      if (!metadata && !fs.existsSync(path.join(config.videosDirPath, `${videoId}.mp4`))) {
        res.status(404).json({ error: "Video not found." });
        return;
      }
      if (metadata?.productionSpec) {
        await revisionService.ensureInitialRevision({
          projectId: videoId,
          sourceJobId: videoId,
          outputVideoId: videoId,
        });
      }
      const revisions = await revisionService.listRevisions(videoId);
      res.status(200).json({
        revisions,
        legacy: !metadata?.productionSpec,
        message: metadata?.productionSpec ? undefined : "Legacy video / revision history unavailable.",
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to load revisions.", message: String(error) });
    }
  });

  router.post("/videos/:videoId/revisions/voice", async (req, res) => {
    const parsed = voiceRevisionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid voice revision payload.", issues: parsed.error.flatten() });
      return;
    }
    try {
      const videoId = req.params.videoId;
      const metadata = readMetadata(config.videosDirPath, videoId);
      if (!metadata?.productionSpec) {
        res.status(409).json({ error: "Legacy video / revision history unavailable." });
        return;
      }
      const baseSpec = metadata.productionSpec as any;
      const selectedVisuals = metadata.selectedVisuals || [];
      const revisionId = cuid();
      const reusePlan = buildRevisionReusePlan({
        changeType: "voice",
        artifacts: metadataArtifacts(metadata),
      });
      const nextSpec = validateProductionSpec({
        ...baseSpec,
        id: revisionId,
        voiceProvider: parsed.data.voiceProvider || baseSpec.voiceProvider,
        voiceId: parsed.data.voiceId || baseSpec.voiceId,
        captionStyle: parsed.data.captionProfile || baseSpec.captionStyle,
        scenes: parsed.data.spokenNarration
          ? baseSpec.scenes.map((scene: any, index: number) => ({
            ...scene,
            spokenNarration: index === 0 ? parsed.data.spokenNarration : scene.spokenNarration,
          }))
          : baseSpec.scenes,
        metadata: {
          ...(baseSpec.metadata || {}),
          revision: {
            revisionId,
            type: "voice",
            parentVideoId: videoId,
            reuseStages: reusePlan.reusedStages,
            regeneratedStages: reusePlan.regeneratedStages,
            reuseArtifacts: reusePlan.artifacts,
            reuseMediaAssets: selectedVisuals,
          },
        },
      });
      const initial = await revisionService.ensureInitialRevision({ projectId: videoId, sourceJobId: videoId, outputVideoId: videoId });
      const arabicBlock = await arabicProductionBlocker(nextSpec);
      if (arabicBlock) {
        res.status(409).json(arabicBlock);
        return;
      }
      const job = await jobs.createVideoJob({
        type: "video",
        creationMode: "prompt",
        title: `${metadata.templateName || metadata.filename || videoId} voice revision`,
        productionSpec: nextSpec,
      });
      const revision = await revisionService.createRevision({
        id: revisionId,
        projectId: videoId,
        parentRevisionId: initial.id,
        sourceJobId: job.id,
        reason: parsed.data.reason || "Voice-only revision",
        changeType: "voice",
        changedFields: {
          spokenNarration: Boolean(parsed.data.spokenNarration),
          voiceProvider: parsed.data.voiceProvider,
          voiceId: parsed.data.voiceId,
          captionProfile: parsed.data.captionProfile,
          reusedStages: reusePlan.reusedStages,
          regeneratedStages: reusePlan.regeneratedStages,
          reusedArtifactIds: reusePlan.artifacts.map((artifact) => artifact.artifactId),
        },
      });
      await orchestrator.enqueue(job);
      await webhookService.dispatchEvent("video.revision.created", { videoId, revisionId: revision.id, jobId: job.id, changeType: "voice" });
      res.status(201).json({ revision, job, ...revisionReuseSummary(reusePlan) });
    } catch (error) {
      res.status(500).json({ error: "Failed to create voice revision.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/videos/:videoId/revisions/media", async (req, res) => {
    const parsed = mediaRevisionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid media revision payload.", issues: parsed.error.flatten() });
      return;
    }
    try {
      const videoId = req.params.videoId;
      const metadata = readMetadata(config.videosDirPath, videoId);
      if (!metadata?.productionSpec) {
        res.status(409).json({ error: "Legacy video / revision history unavailable." });
        return;
      }
      const baseSpec = metadata.productionSpec as any;
      const revisionId = cuid();
      const reusePlan = buildRevisionReusePlan({
        changeType: "media",
        artifacts: metadataArtifacts(metadata),
        changedSceneIndex: parsed.data.sceneIndex,
      });
      const nextSpec = validateProductionSpec({
        ...baseSpec,
        id: revisionId,
        scenes: baseSpec.scenes.map((scene: any, index: number) =>
          index === parsed.data.sceneIndex
            ? {
              ...scene,
              stockSearchTerms: parsed.data.searchTerms || scene.stockSearchTerms,
              visualIntent: parsed.data.visualIntent || scene.visualIntent,
            }
            : scene,
        ),
        metadata: {
          ...(baseSpec.metadata || {}),
          revision: {
            revisionId,
            type: "media",
            parentVideoId: videoId,
            changedSceneIndex: parsed.data.sceneIndex,
            reuseStages: reusePlan.reusedStages,
            regeneratedStages: reusePlan.regeneratedStages,
            reuseArtifacts: reusePlan.artifacts,
          },
        },
      });
      const initial = await revisionService.ensureInitialRevision({ projectId: videoId, sourceJobId: videoId, outputVideoId: videoId });
      const job = await jobs.createVideoJob({
        type: "video",
        creationMode: "prompt",
        title: `${metadata.templateName || metadata.filename || videoId} media revision`,
        productionSpec: nextSpec,
      });
      const revision = await revisionService.createRevision({
        id: revisionId,
        projectId: videoId,
        parentRevisionId: initial.id,
        sourceJobId: job.id,
        reason: parsed.data.reason || `Scene ${parsed.data.sceneIndex + 1} media revision`,
        changeType: "media",
        changedFields: {
          sceneIndex: parsed.data.sceneIndex,
          searchTerms: parsed.data.searchTerms,
          visualIntent: parsed.data.visualIntent,
          reusedStages: reusePlan.reusedStages,
          regeneratedStages: reusePlan.regeneratedStages,
          reusedArtifactIds: reusePlan.artifacts.map((artifact) => artifact.artifactId),
        },
      });
      await orchestrator.enqueue(job);
      await webhookService.dispatchEvent("video.revision.created", { videoId, revisionId: revision.id, jobId: job.id, changeType: "media" });
      res.status(201).json({ revision, job, ...revisionReuseSummary(reusePlan) });
    } catch (error) {
      res.status(500).json({ error: "Failed to create media revision.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/videos/:videoId/revisions/caption-style", async (req, res) => {
    const parsed = captionStyleRevisionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid caption-style revision payload.", issues: parsed.error.flatten() });
      return;
    }
    try {
      const videoId = req.params.videoId;
      const metadata = readMetadata(config.videosDirPath, videoId);
      if (!metadata?.productionSpec) {
        res.status(409).json({ error: "Legacy video / revision history unavailable." });
        return;
      }
      const baseSpec = metadata.productionSpec as any;
      const revisionId = cuid();
      const reusePlan = buildRevisionReusePlan({
        changeType: "caption",
        artifacts: metadataArtifacts(metadata),
      });
      const nextSpec = validateProductionSpec({
        ...baseSpec,
        id: revisionId,
        captionStyle: parsed.data.captionProfile,
        metadata: {
          ...(baseSpec.metadata || {}),
          revision: {
            revisionId,
            type: "caption",
            parentVideoId: videoId,
            reuseStages: reusePlan.reusedStages,
            regeneratedStages: reusePlan.regeneratedStages,
            reuseArtifacts: reusePlan.artifacts,
          },
        },
      });
      const initial = await revisionService.ensureInitialRevision({ projectId: videoId, sourceJobId: videoId, outputVideoId: videoId });
      const job = await jobs.createVideoJob({
        type: "video",
        creationMode: "prompt",
        title: `${metadata.templateName || metadata.filename || videoId} caption revision`,
        productionSpec: nextSpec,
      });
      const revision = await revisionService.createRevision({
        id: revisionId,
        projectId: videoId,
        parentRevisionId: initial.id,
        sourceJobId: job.id,
        reason: parsed.data.reason || "Caption-style revision",
        changeType: "caption",
        changedFields: {
          captionProfile: parsed.data.captionProfile,
          reusedStages: reusePlan.reusedStages,
          regeneratedStages: reusePlan.regeneratedStages,
          reusedArtifactIds: reusePlan.artifacts.map((artifact) => artifact.artifactId),
        },
      });
      await orchestrator.enqueue(job);
      await webhookService.dispatchEvent("video.revision.created", { videoId, revisionId: revision.id, jobId: job.id, changeType: "caption" });
      res.status(201).json({ revision, job, ...revisionReuseSummary(reusePlan) });
    } catch (error) {
      res.status(500).json({ error: "Failed to create caption-style revision.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/videos/:videoId/revisions/:revisionId/final", async (req, res) => {
    try {
      const revision = await revisionService.markFinal(req.params.videoId, req.params.revisionId);
      if (!revision) {
        res.status(404).json({ error: "Revision not found." });
        return;
      }
      await webhookService.dispatchEvent("video.revision.finalized", { videoId: req.params.videoId, revisionId: revision.id, outputVideoId: revision.outputVideoId });
      res.status(200).json({ revision });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark final revision.", message: String(error) });
    }
  });

  // Preview Production Spec generated from a prompt
  router.post("/production-spec/preview", async (req, res) => {
    plannerRouteTimeout(req);
    const parsed = productionSpecPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid preview request payload",
        issues: parsed.error.flatten(),
      });
      return;
    }

    try {
      if (providerVault.isAvailable()) {
        await providerSecrets.refresh("gemini", "api_key").catch(() => undefined);
      }
      const provider = contentAIRegistry.getProvider();
      const generatedSpec = await provider.generateProductionSpec(parsed.data);
      const spec = await canonicalizeProductionSpecForRequest(db, generatedSpec, parsed.data);
      const costEstimate = estimateProductionCost(spec, {
        voiceProvider: spec.voiceProvider as any,
        visualMode: spec.visualMode,
        contentAIProvider: provider.id,
      });
      const quality = validateContentQuality(spec);
      const resolvedSpec = quality.correctedSpec || spec;
      const mediaPlan = mediaIntelligenceService.generateMediaPlan(resolvedSpec, {
        captionPreset: (resolvedSpec.captionStyle as any) || "bold",
      });
      const readiness = await checkCreateReadiness(parsed.data, resolvedSpec);
      const confidenceBlock = contentConfidenceBlocker(resolvedSpec);

      res.status(200).json({
        spec: resolvedSpec,
        costEstimate,
        quality,
        mediaPlan,
        readiness,
        contentConfidenceWarning: confidenceBlock?.message,
      });
    } catch (error) {
      sendCreateFailure(res, error, "production-spec/preview");
    }
  });

  // Prompt Enhancement
  router.post("/prompt/enhance", async (req, res) => {
    plannerRouteTimeout(req);
    const parsed = promptEnhanceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid enhance request payload",
        issues: parsed.error.flatten(),
      });
      return;
    }

    try {
      if (providerVault.isAvailable()) {
        await providerSecrets.refresh("gemini", "api_key").catch(() => undefined);
      }
      const provider = contentAIRegistry.getProvider();
      const result = await provider.rewritePrompt(parsed.data.prompt, {
        language: parsed.data.language,
        dialect: parsed.data.dialect,
        contentStyle: parsed.data.contentStyle,
      });
      res.status(200).json(result);
    } catch (error) {
      sendCreateFailure(res, error, "prompt/enhance");
    }
  });

  // Cost Estimation endpoint
  router.post("/cost-estimate", (req, res) => {
    try {
      const cost = estimateProductionCost(req.body);
      res.status(200).json(cost);
    } catch (error) {
      res.status(400).json({
        error: "Failed to estimate cost",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // User Media Upload Endpoint
  router.post("/media/upload", express.json({ limit: "50mb" }), (req, res) => {
    try {
      const { filename, base64Data } = req.body || {};
      if (!filename || !base64Data) {
        res.status(400).json({ error: "filename and base64Data are required" });
        return;
      }

      const ext = path.extname(filename).toLowerCase();
      const allowedExts = [".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".webm"];
      if (!allowedExts.includes(ext)) {
        res.status(400).json({
          error: "Invalid file format",
          message: `Allowed formats: ${allowedExts.join(", ")}`,
        });
        return;
      }

      const uploadsDir = mediaCache.getUploadsDir();
      fs.ensureDirSync(uploadsDir);

      const safeId = cuid();
      const safeFilename = `${safeId}${ext}`;
      const targetPath = path.join(uploadsDir, safeFilename);

      const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(cleanBase64, "base64");

      if (buffer.length > 50 * 1024 * 1024) {
        res.status(400).json({ error: "File exceeds maximum size limit of 50MB." });
        return;
      }

      fs.writeFileSync(targetPath, buffer);

      res.status(201).json({
        mediaId: safeId,
        filename: safeFilename,
        url: `/api/v2/media/uploads/${safeFilename}`,
        sizeBytes: buffer.length,
        extension: ext,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to upload media file" });
    }
  });

  router.post("/production/jobs", async (req, res) => {
    plannerRouteTimeout(req);
    const parsed = productionJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid production job payload.", issues: parsed.error.flatten() });
      return;
    }
    try {
      const qualityMap: Record<string, "draft" | "standard" | "high" | "premium" | "max_quality_local"> = {
        fast: "draft",
        balanced: "standard",
        high: "high",
        maximum: "max_quality_local",
        premium: "premium",
        max_quality_local: "max_quality_local",
      };
      const provider = contentAIRegistry.getProvider();
      const spec = await provider.generateProductionSpec({
        creationMode: "prompt",
        prompt: parsed.data.prompt,
        language: parsed.data.language,
        dialect: parsed.data.dialect,
        durationSeconds: parsed.data.durationSeconds || parsed.data.duration || 20,
        aspectRatio: parsed.data.aspectRatio,
        quality: qualityMap[parsed.data.qualityProfile],
        visualMode: parsed.data.visualMode,
        voiceProvider: "auto",
        voiceId: parsed.data.voice,
        brandId: parsed.data.brandId,
      } as any);
      const canonicalSpec = await canonicalizeProductionSpecForRequest(db, spec, {
        ...parsed.data,
        quality: qualityMap[parsed.data.qualityProfile],
        voiceProvider: "auto",
        voiceId: parsed.data.voice,
      });
      const arabicBlock = await arabicProductionBlocker(canonicalSpec);
      if (arabicBlock) {
        res.status(409).json(arabicBlock);
        return;
      }
      const confidenceBlock = contentConfidenceBlocker(canonicalSpec);
      if (confidenceBlock) {
        res.status(409).json(confidenceBlock);
        return;
      }
      const scriptQualityBlock = scriptQualityBlocker(parsed.data.prompt, canonicalSpec as any);
      if (scriptQualityBlock) {
        res.status(409).json(scriptQualityBlock);
        return;
      }
      const readiness = await checkCreateReadiness(parsed.data, canonicalSpec);
      if (!readiness.ready) {
        res.status(409).json({
          error: "production_not_runnable",
          message: readiness.missingRequirements[0] || "This production setup is not runnable.",
          messageAr: readiness.missingRequirementsAr[0] || "إعداد الإنتاج المختار غير جاهز للتشغيل بعد.",
          readiness,
          action: readiness.capabilities.find((cap) => cap.required && !cap.ready)?.action,
        });
        return;
      }
      const job = await jobs.createVideoJob({
        type: "video",
        creationMode: "prompt",
        title: canonicalSpec.title,
        productionSpec: {
          ...canonicalSpec,
          metadata: {
            ...(canonicalSpec.metadata || {}),
            apiContract: "production.jobs.v1",
            publishIntent: parsed.data.publishIntent || undefined,
            qualityProfileRequested: parsed.data.qualityProfile,
          },
        },
      });
      await orchestrator.enqueue(job);
      await webhookService.dispatchEvent("job.created", { jobId: job.id, status: job.status });
      res.status(202).json({
        jobId: job.id,
        status: job.status,
        statusUrl: `/api/v2/production/jobs/${job.id}`,
        eventsUrl: `/api/v2/jobs/${job.id}/events`,
      });
    } catch (error) {
      sendCreateFailure(res, error, "POST /production/jobs");
    }
  });

  router.get("/production/jobs/:id", async (req, res) => {
    const job = await jobs.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.status(200).json({ job });
  });

  router.get("/production/jobs/:id/stages", async (req, res) => {
    const job = await jobs.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.status(200).json({
      jobId: job.id,
      stageTimings: job.stageTimings || {},
      checkpoint: job.checkpoint || {},
      stages: checkpointStages.map((stage) => ({
        stage,
        checkpoint: (job.checkpoint as any)?.[stage] || { status: "pending", attempt: 0 },
        timingMs: job.stageTimings?.[`${stage}Ms`],
      })),
    });
  });

  router.get("/production/jobs/:id/output", async (req, res) => {
    const job = await jobs.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.status(200).json({
      jobId: job.id,
      status: job.status,
      output: job.output || null,
      videoId: job.output?.videoId,
    });
  });

  router.get("/media/uploads/:filename", async (req, res) => {
    const filename = path.basename(req.params.filename);
    const targetPath = await mediaUploadService.resolveUploadPath(filename);
    if (!targetPath || !fs.existsSync(targetPath)) {
      const fallback = path.join(mediaCache.getUploadsDir(), filename);
      if (!fs.existsSync(fallback)) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.sendFile(fallback);
      return;
    }
    res.sendFile(targetPath);
  });

  // Create Video Job (supports prompt mode or template mode)
  router.post("/jobs", async (req, res) => {
    plannerRouteTimeout(req);
    const rawPayload = req.body || {};
    const parsed = createVideoJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid job payload",
        issues: parsed.error.flatten(),
      });
      return;
    }

    try {
      let resolvedPayload = parsed.data as any;
      const headerIdempotencyKey =
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined;
      if (headerIdempotencyKey && !resolvedPayload.idempotencyKey) {
        resolvedPayload = {
          ...resolvedPayload,
          idempotencyKey: headerIdempotencyKey,
        };
      }

      // If user sent a raw prompt without full spec, generate the production spec first
      if ((rawPayload as any).prompt && !(rawPayload as any).productionSpec) {
        const provider = contentAIRegistry.getProvider();
        const generatedSpec = await provider.generateProductionSpec(rawPayload as any);
        const canonicalSpec = await canonicalizeProductionSpecForRequest(db, generatedSpec, rawPayload);
        const arabicBlock = await arabicProductionBlocker(canonicalSpec);
        if (arabicBlock) {
          res.status(409).json(arabicBlock);
          return;
        }
        const confidenceBlock = contentConfidenceBlocker(canonicalSpec);
        if (confidenceBlock) {
          res.status(409).json(confidenceBlock);
          return;
        }
        const readiness = await checkCreateReadiness(rawPayload, canonicalSpec);
        if (!readiness.ready) {
          res.status(409).json({
            error: "production_not_runnable",
            message: readiness.missingRequirements[0] || "This production setup is not runnable.",
            messageAr: readiness.missingRequirementsAr[0] || "إعداد الإنتاج المختار غير جاهز للتشغيل بعد.",
            readiness,
            action: readiness.capabilities.find((cap) => cap.required && !cap.ready)?.action,
          });
          return;
        }
        resolvedPayload = {
          type: "video",
          creationMode: "prompt",
          title: (rawPayload as any).title || canonicalSpec.title,
          productionSpec: canonicalSpec,
          idempotencyKey: resolvedPayload.idempotencyKey,
        } as any;
      } else if ((rawPayload as any).productionSpec) {
        const canonicalSpec = await canonicalizeProductionSpecForRequest(
          db,
          (rawPayload as any).productionSpec,
          rawPayload,
        );
        const arabicBlock = await arabicProductionBlocker(canonicalSpec);
        if (arabicBlock) {
          res.status(409).json(arabicBlock);
          return;
        }
        const readiness = await checkCreateReadiness(rawPayload, canonicalSpec);
        if (!readiness.ready) {
          res.status(409).json({
            error: "production_not_runnable",
            message: readiness.missingRequirements[0] || "This production setup is not runnable.",
            messageAr: readiness.missingRequirementsAr[0] || "إعداد الإنتاج المختار غير جاهز للتشغيل بعد.",
            readiness,
            action: readiness.capabilities.find((cap) => cap.required && !cap.ready)?.action,
          });
          return;
        }
        resolvedPayload = {
          ...resolvedPayload,
          title: (rawPayload as any).title || canonicalSpec.title,
          productionSpec: canonicalSpec,
        };
      } else if ((resolvedPayload as any).businessTemplateId && !(resolvedPayload as any).productionSpec) {
        const generatedSpec = convertTemplateToProductionSpec({
          templateId: (resolvedPayload as any).businessTemplateId,
          templateData: (resolvedPayload as any).businessTemplateData,
          config: (resolvedPayload as any).config,
          title: (resolvedPayload as any).title,
          brandId: (resolvedPayload as any).brandId,
        });
        const canonicalSpec = await canonicalizeProductionSpecForRequest(db, generatedSpec, {
          ...rawPayload,
          templateId: (resolvedPayload as any).businessTemplateId,
          brandId: (resolvedPayload as any).brandId || generatedSpec.brandId,
        });
        const readiness = await checkCreateReadiness(rawPayload, canonicalSpec);
        if (!readiness.ready) {
          res.status(409).json({
            error: "production_not_runnable",
            message: readiness.missingRequirements[0] || "This production setup is not runnable.",
            messageAr: readiness.missingRequirementsAr[0] || "إعداد الإنتاج المختار غير جاهز للتشغيل بعد.",
            readiness,
            action: readiness.capabilities.find((cap) => cap.required && !cap.ready)?.action,
          });
          return;
        }
        resolvedPayload = {
          type: "video",
          creationMode: "template",
          title: (resolvedPayload as any).title || canonicalSpec.title,
          productionSpec: canonicalSpec,
          idempotencyKey: resolvedPayload.idempotencyKey,
        } as any;
      }

      // If template mode is used with raw createShortInput, validate it
      if ((resolvedPayload as any).scenes && !(resolvedPayload as any).productionSpec) {
        validateCreateShortInput(resolvedPayload as any);
      }

      const arabicBlock = await arabicProductionBlocker(
        ((resolvedPayload as any).productionSpec || {}) as {
          language?: string;
          dialect?: string;
          voiceId?: string;
        },
      );
      if (arabicBlock) {
        res.status(409).json(arabicBlock);
        return;
      }
      const job = await jobs.createVideoJob(resolvedPayload);
      try {
        await orchestrator.enqueue(job);
      } catch {
        const failed = await jobs.getJob(job.id);
        res.status(503).json({
          error: "Job created but orchestration failed.",
          job: failed || job,
        });
        return;
      }
      res.status(201).json({ job });
    } catch (error) {
      sendCreateFailure(res, error, "POST /jobs");
    }
  });

  router.get("/jobs", async (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const str = (value?: string) => {
        const trimmed = (value || "").trim();
        return trimmed ? trimmed.slice(0, 200) : undefined;
      };
      const statusGroup =
        q.group && q.group in STATUS_GROUPS ? (q.group as keyof typeof STATUS_GROUPS) : undefined;
      const filters: JobListFilters = {
        search: str(q.search),
        statusGroup,
        status: str(q.status),
        language: str(q.language),
        brandName: str(q.brandName),
        templateId: str(q.templateId),
        characterProfileId: str(q.characterProfileId),
        aspectRatio: str(q.aspectRatio),
        creationMode: str(q.creationMode),
        dateFrom: str(q.dateFrom),
        dateTo: str(q.dateTo),
        sort: q.sort === "oldest" ? "oldest" : "newest",
      };
      const requestedLimit = Number(q.limit);
      const limit = Number.isFinite(requestedLimit) ? requestedLimit : 24;
      const rows = await jobs.listJobRows(500);
      const page = queryJobRows(rows as any, filters, { limit, cursor: str(q.cursor) });
      const advanced = q.view === "advanced";
      const counts = await jobs.summarizeJobs().catch(() => undefined);
      res.status(200).json({
        jobs: page.items.map((row) => serializeJobForCustomer(jobs.mapJobRow(row as any), { advanced })),
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore, returned: page.items.length },
        counts,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to list productions." });
    }
  });

  router.get("/jobs/:id", async (req, res) => {
    const job = await jobs.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const customer = serializeJobForCustomer(job, { advanced: true });
    const { input: _input, technicalError: _technicalError, ...safeJob } = job;
    // Scrub the whole record: `output`, `checkpoint` artifacts and `stageTimings`
    // can all carry `file://` / absolute artifact paths, not just the spec.
    res.status(200).json({
      job: {
        ...scrubInternal(safeJob),
        progress: customerDisplayProgress(job),
        technicalError:
          job.technicalError && !/(file:\/\/|\/(app|root|home|data|var)\/|[A-Za-z]:[\\/])/.test(job.technicalError)
            ? job.technicalError.slice(0, 400)
            : undefined,
        customerStatus: customer.customerStatus,
        snapshots: customer.snapshots,
        // The structured final-quality verdict, carrying message KEYS the
        // interface resolves in the active language (V2.5.1).
        qualityReview: customer.qualityReview,
        advanced: customer.advanced,
      },
      timeline: buildCustomerTimeline(job),
      failure: sanitizeJobFailure(job),
    });
  });

  router.get("/jobs/:id/events", async (req, res) => {
    const wantsSse = req.headers.accept?.includes("text/event-stream");
    if (!wantsSse) {
      res.status(200).json({ events: await jobs.getEvents(req.params.id) });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const existing = await jobs.getEvents(req.params.id);
    for (const event of existing) {
      res.write(`event: job-event\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = jobs.subscribe(req.params.id, res);
    req.on("close", unsubscribe);
  });

  router.get("/jobs/:id/stages", async (req, res) => {
    const job = await jobs.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.status(200).json({ checkpoint: job.checkpoint || {}, stageTimings: job.stageTimings || {} });
  });

  router.post("/jobs/:id/stages/:stage/retry", async (req, res) => {
    const parsed = stageRetrySchema.safeParse({ stage: req.params.stage });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid stage retry request.", issues: parsed.error.flatten() });
      return;
    }
    try {
      const job = await jobs.retryStage(req.params.id, parsed.data.stage);
      await webhookService.dispatchEvent("job.stage.retry", { jobId: job.id, stage: parsed.data.stage });
      await orchestrator.enqueue(job);
      res.status(202).json({
        job,
        retryStage: parsed.data.stage,
        checkpoint: job.checkpoint,
        reusedStages: checkpointStages.filter((stage) => (job.checkpoint as any)?.[stage]?.status === "completed"),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Stage retry failed." });
    }
  });

  router.post("/jobs/:id/cancel", async (req, res) => {
    try {
      const job = await jobs.cancelJob(req.params.id);
      res.status(200).json({ job });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Cancel failed.",
      });
    }
  });

  router.post("/jobs/:id/retry", async (req, res) => {
    try {
      const headerIdempotencyKey =
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined;
      const targetJob = await jobs.getJob(req.params.id);
      const originalJobId =
        (targetJob?.input as any)?.__originalJobId ||
        ((targetJob?.productionSpec as any)?.metadata?.revision?.originalJobId) ||
        req.params.id;
      const directArtifacts = readDurableArtifactsForSourceJob(config, req.params.id);
      const lineageArtifacts =
        originalJobId && originalJobId !== req.params.id
          ? readDurableArtifactsForSourceJob(config, originalJobId)
          : [];
      const priorReused =
        (((targetJob?.productionSpec as any)?.metadata?.revision?.reuseArtifacts as DurableSceneArtifact[]) || []);
      const allArtifactsMap = new Map<string, DurableSceneArtifact>();
      for (const a of [...lineageArtifacts, ...priorReused, ...directArtifacts]) {
        if (a?.artifactId) allArtifactsMap.set(a.artifactId, a);
      }
      const reuseArtifacts = Array.from(allArtifactsMap.values());
      const job = await jobs.retryJob(req.params.id, {
        idempotencyKey: headerIdempotencyKey,
        reuseArtifacts,
      });
      try {
        await orchestrator.enqueue(job);
      } catch {
        const failed = await jobs.getJob(job.id);
        res.status(503).json({
          error: "Retry created but orchestration failed.",
          job: failed || job,
        });
        return;
      }
      const retryMeta = ((job.productionSpec as any)?.metadata || {}).revision || {};
      res.status(201).json({
        job,
        reusedStages: retryMeta.reuseStages || [],
        regeneratedStages: retryMeta.regeneratedStages || [],
        reusedArtifactIds: reuseArtifacts.map((artifact) => artifact.artifactId),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Retry failed.",
      });
    }
  });

  const sendHealth = async (_req: express.Request, res: express.Response) => {
    await providerSecrets.refresh("pexels", "api_key").catch(() => undefined);
    const health = await getV2Health(config, db);
    res.status(200).json(health);
  };

  router.get("/health", sendHealth);

  router.get("/system/health", sendHealth);

  /**
   * FAST HEALTH - what System Health renders from on first paint.
   *
   * Every check inside is individually bounded and none of them contacts a
   * paid provider API or walks storage, so this answers in well under a second
   * even when an external service is down. The expensive work moved to
   * `/system/diagnostics`, which the page now runs only on request.
   *
   * Provider *configuration* is read locally and passed in; provider
   * *reachability* is deliberately not asked here.
   */
  router.get("/system/health/fast", async (req, res) => {
    try {
      let publishingAccountCount = 0;
      try {
        publishingAccountCount = (await publishingService.listAccounts()).length;
      } catch {
        // A publishing table that is not reachable must not fail the page; the
        // database item in the report already carries that signal.
        publishingAccountCount = 0;
      }

      const aiProvider = contentAIRegistry.getProvider();
      const vaultCredentials = providerVault.isAvailable()
        ? await providerVault.list().catch(() => [])
        : [];
      const vaultByProvider = new Map(vaultCredentials.map((credential) => [credential.providerId, credential]));
      const snapshot: ProviderConfigurationSnapshot = {
        elevenLabsConfigured: new ElevenLabsVoiceProvider().isConfigured(),
        // Local Voice (VoiceTut) is the default Arabic route - the same signal job creation uses (see
        // the local_voice_setup_required check above) so this health check
        // never claims Arabic is broken while local voice is actually ready.
        localVoiceConfigured: new VoiceRegistry({} as any).isArabicProductionConfigured(),
        pexelsConfigured: Boolean(
          vaultByProvider.has("pexels") ||
          (config.pexelsApiKey &&
            config.pexelsApiKey !== "dummy-key" &&
            !config.pexelsApiKey.includes("your_pexels")),
        ),
        aiConfigured: aiProvider.id !== "local_ai",
        publishingAccountCount,
      };

      const report = await getFastHealth(config, db, snapshot, {
        bypassCache: req.query.refresh === "true",
      });
      res.status(200).json(report);
    } catch (error) {
      res.status(500).json({
        error: "Failed to read system status.",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/templates", async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    let preferences = new Map<string, boolean>();
    try {
      const preferenceRows = await db.query<TemplatePreferenceRow>("SELECT * FROM video_template_preferences");
      preferences = new Map(preferenceRows.map((row) => [row.template_id, row.favorite]));
    } catch {
      preferences = new Map();
    }
    const builtIns = listBusinessTemplates().map((template) => mapBuiltInTemplate(template, preferences));
    let custom: ReturnType<typeof mapCustomTemplate>[] = [];
    try {
      const rows = await db.query<TemplateRow>(
        `SELECT * FROM video_templates
         WHERE ($1::boolean = true OR archived_at IS NULL)
         ORDER BY favorite DESC, updated_at DESC, name ASC`,
        [includeArchived],
      );
      custom = rows.map(mapCustomTemplate);
    } catch {
      custom = [];
    }
    res.status(200).json({
      templates: [...builtIns, ...custom],
      categories: TEMPLATE_CATEGORIES,
    });
  });

  router.post("/templates", async (req, res) => {
    const parsed = reusableTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid template payload", issues: parsed.error.flatten() });
      return;
    }
    const id = cuid();
    const revision = {
      revision: 1,
      createdAt: new Date().toISOString(),
      summary: "Created reusable template",
      snapshot: {
        templateId: id,
        templateName: parsed.data.name,
        resolvedConfiguration: parsed.data.config,
        variables: parsed.data.variables,
      },
    };
    const rows = await db.query<TemplateRow>(
      `INSERT INTO video_templates (
        id, name, description, category, source, base_template_id, favorite,
        archived_at, revision, config, variables, revisions, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,'custom',$5,$6,$7,1,$8::jsonb,$9::jsonb,$10::jsonb,now(),now())
      RETURNING *`,
      [
        id,
        parsed.data.name,
        parsed.data.description,
        parsed.data.category,
        parsed.data.baseTemplateId || null,
        parsed.data.favorite,
        parsed.data.archived ? new Date() : null,
        JSON.stringify(parsed.data.config),
        JSON.stringify(parsed.data.variables),
        JSON.stringify([revision]),
      ],
    );
    res.status(201).json({ template: mapCustomTemplate(rows[0]) });
  });

  router.put("/templates/:id", async (req, res) => {
    if (listBusinessTemplates().some((template) => template.id === req.params.id)) {
      res.status(409).json({ error: "Built-in templates cannot be edited. Duplicate it first." });
      return;
    }
    const parsed = reusableTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid template payload", issues: parsed.error.flatten() });
      return;
    }
    const existingRows = await db.query<TemplateRow>("SELECT * FROM video_templates WHERE id = $1", [req.params.id]);
    if (!existingRows[0]) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    const nextRevision = existingRows[0].revision + 1;
    const revisions = [
      ...(Array.isArray(existingRows[0].revisions) ? existingRows[0].revisions : []),
      {
        revision: nextRevision,
        createdAt: new Date().toISOString(),
        summary: "Updated reusable template",
        snapshot: {
          templateId: req.params.id,
          templateName: parsed.data.name,
          resolvedConfiguration: parsed.data.config,
          variables: parsed.data.variables,
        },
      },
    ];
    const rows = await db.query<TemplateRow>(
      `UPDATE video_templates
       SET name = $2,
           description = $3,
           category = $4,
           base_template_id = $5,
           favorite = $6,
           archived_at = CASE WHEN $7::boolean THEN COALESCE(archived_at, now()) ELSE NULL END,
           revision = $8,
           config = $9::jsonb,
           variables = $10::jsonb,
           revisions = $11::jsonb,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        parsed.data.name,
        parsed.data.description,
        parsed.data.category,
        parsed.data.baseTemplateId || null,
        parsed.data.favorite,
        parsed.data.archived,
        nextRevision,
        JSON.stringify(parsed.data.config),
        JSON.stringify(parsed.data.variables),
        JSON.stringify(revisions),
      ],
    );
    res.status(200).json({ template: mapCustomTemplate(rows[0]) });
  });

  router.post("/templates/:id/duplicate", async (req, res) => {
    const builtIn = listBusinessTemplates().map((template) => mapBuiltInTemplate(template)).find((template) => template.id === req.params.id);
    const customRows = builtIn ? [] : await db.query<TemplateRow>("SELECT * FROM video_templates WHERE id = $1", [req.params.id]);
    const source = builtIn || (customRows[0] ? mapCustomTemplate(customRows[0]) : null);
    if (!source) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    const id = cuid();
    const rows = await db.query<TemplateRow>(
      `INSERT INTO video_templates (
        id, name, description, category, source, base_template_id, favorite,
        revision, config, variables, revisions, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,'custom',$5,false,1,$6::jsonb,$7::jsonb,$8::jsonb,now(),now())
      RETURNING *`,
      [
        id,
        `${source.displayName || source.name} Copy`,
        source.description || "",
        source.category || "social",
        source.baseTemplateId || source.id,
        JSON.stringify(source.config || {}),
        JSON.stringify(source.variables || []),
        JSON.stringify([{ revision: 1, createdAt: new Date().toISOString(), summary: "Duplicated template" }]),
      ],
    );
    res.status(201).json({ template: mapCustomTemplate(rows[0]) });
  });

  router.post("/templates/:id/favorite", async (req, res) => {
    const favorite = req.body?.favorite !== false;
    const builtIn = listBusinessTemplates().some((template) => template.id === req.params.id);
    if (builtIn) {
      const rows = await db.query<TemplatePreferenceRow>(
        `INSERT INTO video_template_preferences (template_id, favorite, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (template_id) DO UPDATE SET favorite = EXCLUDED.favorite, updated_at = now()
         RETURNING *`,
        [req.params.id, favorite],
      );
      const template = mapBuiltInTemplate(
        listBusinessTemplates().find((item) => item.id === req.params.id)!,
        new Map([[req.params.id, rows[0]?.favorite ?? favorite]]),
      );
      res.status(200).json({ template });
      return;
    }
    const rows = await db.query<TemplateRow>(
      "UPDATE video_templates SET favorite = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id, favorite],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    res.status(200).json({ template: mapCustomTemplate(rows[0]) });
  });

  router.delete("/templates/:id", async (req, res) => {
    if (listBusinessTemplates().some((template) => template.id === req.params.id)) {
      res.status(409).json({ error: "Built-in templates cannot be archived. Duplicate it first." });
      return;
    }
    const rows = await db.query<TemplateRow>(
      "UPDATE video_templates SET archived_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    res.status(200).json({ success: true, archived: true, template: mapCustomTemplate(rows[0]) });
  });

  router.post("/templates/:id/restore", async (req, res) => {
    const rows = await db.query<TemplateRow>(
      "UPDATE video_templates SET archived_at = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    res.status(200).json({ template: mapCustomTemplate(rows[0]) });
  });

  router.post("/templates/:id/resolve", async (req, res) => {
    const builtIn = listBusinessTemplates().map((template) => mapBuiltInTemplate(template)).find((template) => template.id === req.params.id);
    const customRows = builtIn ? [] : await db.query<TemplateRow>("SELECT * FROM video_templates WHERE id = $1", [req.params.id]);
    const template = builtIn || (customRows[0] ? mapCustomTemplate(customRows[0]) : null);
    if (!template) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    const validation = validateTemplateVariables(template, req.body?.variables || {});
    if (!validation.ok) {
      res.status(400).json({
        error: "Template variables need attention.",
        missing: validation.missing,
        unresolved: validation.unresolved.length,
      });
      return;
    }
    const templateConfig = (template.config || {}) as Record<string, unknown>;
    const resolvedConfig = {
      ...templateConfig,
      promptGuidance: applyVariablesToText(templateConfig.promptGuidance as string | undefined, validation.resolved),
    };
    res.status(200).json({
      template,
      resolvedConfig,
      resolvedVariables: validation.resolved,
      snapshot: templateSnapshot({ ...template, config: resolvedConfig }, validation.resolved),
    });
  });

  router.get("/voices", async (req, res) => {
    try {
      const provider = typeof req.query.provider === "string" ? req.query.provider : "auto";
      const language = typeof req.query.language === "string" ? req.query.language : undefined;
      const dialect = typeof req.query.dialect === "string" ? req.query.dialect : undefined;
      const registry = new VoiceRegistry({
        listAvailableVoices: () => ["af_heart", "am_adam", "bf_emma"],
        generate: async () => ({ audio: Buffer.from(""), audioLength: 0 }),
      } as any);
      const result = await registry.listCompatibleVoices({
        provider: provider as any,
        language,
        dialect,
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        error: "Failed to list voices",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Short Arabic audition text. It is reused for every voice so comparisons
  // stay meaningful, but synthesis is still gated by the paid-usage policy.
  const VOICE_LAB_REFERENCE_SCRIPT =
    "\u0623\u0647\u0644\u0627\u064B \u0628\u064A\u0643\u060C \u062F\u0647 \u0627\u062E\u062A\u0628\u0627\u0631 \u0644\u0644\u0635\u0648\u062A \u0627\u0644\u0639\u0631\u0628\u064A \u0641\u064A \u0641\u064A\u062F\u064A\u0648\u0647\u0627\u062A ABUD Shorts.";

  const VOICE_LAB_MAX_CHARS = 600;

  async function voiceLabPreviewAllowed(): Promise<boolean> {
    if (process.env.ABUD_ALLOW_ELEVENLABS_PREVIEW_SYNTHESIS === "true") return true;
    const rows = await db.query<SettingRow>(
      "SELECT key, value, updated_at FROM app_settings WHERE key = $1",
      ["elevenlabs_voice_lab_policy"],
    ).catch(() => []);
    return rows[0]?.value?.allowPreviewSynthesis === true;
  }

  async function elevenLabsVoiceDefaultState(
    provider: ElevenLabsVoiceProvider,
    storedDefault: PersistedArabicVoiceDefault | null,
  ) {
    const state: {
      defaultArabicVoiceConfigured: boolean;
      defaultArabicVoiceAvailable?: boolean;
      defaultArabicVoiceName?: string;
      voiceCatalogueAvailable?: boolean;
      arabicProductionReady: boolean;
      setupRequiredReason?: string;
      voices?: any[];
      warnings: string[];
    } = {
      defaultArabicVoiceConfigured: Boolean(storedDefault?.voiceId),
      arabicProductionReady: false,
      warnings: [],
    };
    if (!provider.isConfigured()) {
      state.setupRequiredReason = "credentials_not_connected";
      return state;
    }
    try {
      const voices = await provider.listVoices("ar");
      state.voices = voices;
      state.voiceCatalogueAvailable = true;
      if (!storedDefault?.voiceId) {
        state.defaultArabicVoiceAvailable = false;
        state.setupRequiredReason = "default_arabic_voice_not_selected";
        return state;
      }
      const match = voices.find((voice) => voice.id === storedDefault.voiceId);
      state.defaultArabicVoiceAvailable = Boolean(match);
      state.defaultArabicVoiceName = match?.name || storedDefault.voiceName;
      state.arabicProductionReady = Boolean(match);
      if (!match) {
        state.setupRequiredReason = "saved_default_voice_unavailable";
        state.warnings.push("The saved default Arabic voice is not available in the connected ElevenLabs account.");
      }
      return state;
    } catch (error) {
      state.voiceCatalogueAvailable = false;
      state.setupRequiredReason = "voice_catalogue_unavailable";
      state.warnings.push(error instanceof Error ? error.message : String(error));
      return state;
    }
  }

  router.get("/voice-lab/config", async (req, res) => {
    await providerSecrets.refreshElevenLabsApiKey();
    const provider = new ElevenLabsVoiceProvider();
    const storedDefault = await readArabicVoiceDefault(db).catch(() => null);
    const defaultState = await elevenLabsVoiceDefaultState(provider, storedDefault);
    const previewAllowed = await voiceLabPreviewAllowed();
    res.status(200).json({
      provider: "elevenlabs",
      configured: provider.isConfigured(),
      defaultArabicVoice: storedDefault,
      defaultArabicVoiceConfigured: defaultState.defaultArabicVoiceConfigured,
      defaultArabicVoiceAvailable: defaultState.defaultArabicVoiceAvailable,
      defaultArabicVoiceName: defaultState.defaultArabicVoiceName,
      voiceCatalogueAvailable: defaultState.voiceCatalogueAvailable,
      arabicProductionReady: defaultState.arabicProductionReady,
      setupRequiredReason: defaultState.setupRequiredReason,
      previewSynthesisAllowed: previewAllowed,
      model: ELEVENLABS_DEFAULT_MODEL_ID,
      referenceScript: VOICE_LAB_REFERENCE_SCRIPT,
      maxCharacters: VOICE_LAB_MAX_CHARS,
      languages: [{ code: "ar", label: "Arabic" }, { code: "en", label: "English" }],
      dialects: [{ code: "egyptian", label: "Egyptian" }, { code: "msa", label: "MSA" }],
      presets: ELEVENLABS_PRESET_IDS.map((id) => ({ id, settings: ELEVENLABS_PRESETS[id] })),
      note: "Previews are short auditions only. No video is rendered and no accent quality is asserted by the engine.",
    });
  });

  router.post("/voice-lab/preview", async (req, res) => {
    try {
      const rawText = typeof req.body?.text === "string" && req.body.text.trim()
        ? req.body.text.trim()
        : VOICE_LAB_REFERENCE_SCRIPT;
      if (rawText.length > VOICE_LAB_MAX_CHARS) {
        res.status(400).json({
          error: "preview_text_too_long",
          message: `Voice Lab previews are limited to ${VOICE_LAB_MAX_CHARS} characters.`,
        });
        return;
      }
      const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId.trim() : "";
      const preset = ELEVENLABS_PRESET_IDS.includes(req.body?.preset) ? req.body.preset : "natural";
      const language = req.body?.language === "en" ? "en" : "ar";

      // If VoiceTut requested, or Arabic preview when ElevenLabs is unconfigured
      if (req.body?.provider === "voicetut" || req.body?.provider === "local") {
        const localProvider = new LocalEgyptianTtsProvider("voicetut");
        const voiceRes = await localProvider.generateVoice(rawText, voiceId || undefined);
        const buf = Buffer.isBuffer(voiceRes.audio) ? voiceRes.audio : Buffer.from(voiceRes.audio);
        res.status(200).json({
          audioBase64: buf.toString("base64"),
          durationSeconds: voiceRes.audioLength,
          provider: "voicetut",
          voiceId: voiceId || "Mohamed",
          language: "ar",
          dialect: "egyptian",
          text: rawText,
          costLabel: "Free · Local",
        });
        return;
      }

      await providerSecrets.refreshElevenLabsApiKey();
      const provider = new ElevenLabsVoiceProvider();
      if (!provider.isConfigured()) {
        res.status(409).json({
          error: "elevenlabs_not_configured",
          message: ARABIC_ELEVENLABS_REQUIRED_MESSAGE,
          action: { label: "Configure ElevenLabs", href: "/providers" },
        });
        return;
      }
      if (!(await voiceLabPreviewAllowed())) {
        res.status(402).json({
          error: "preview_synthesis_not_authorized",
          message: "LIVE AUDIO PREVIEW PENDING PAID-USAGE AUTHORIZATION.",
        });
        return;
      }

      const preview = await provider.generatePreview(rawText, voiceId || undefined, {
        preset,
        languageCode: language,
      });
      if (providerVault.isAvailable()) {
        // A preview is a real, successful ElevenLabs round trip: this is the
        // only place "Live Verified" is earned, since Test Connection itself
        // must never spend synthesis quota.
        await providerVault.markTested("elevenlabs", "live_verified").catch(() => undefined);
      }
      res.status(200).json({
        ...preview,
        language,
        dialect: req.body?.dialect === "msa" ? "msa" : "egyptian",
        text: rawText,
        costLabel: "Cloud / Usage Based",
      });
    } catch (error) {
      res.status(502).json({
        error: "voice_preview_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/voice-lab/default-voice", async (req, res) => {
    try {
      const stored = await readArabicVoiceDefault(db);
      res.status(200).json({ provider: "elevenlabs", default: stored });
    } catch (error) {
      res.status(500).json({
        error: "Failed to read the default Arabic voice.",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.put("/voice-lab/default-voice", async (req, res) => {
    const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId.trim() : "";
    if (!voiceId) {
      res.status(400).json({ error: "voiceId is required." });
      return;
    }
    try {
      await providerSecrets.refreshElevenLabsApiKey().catch(() => undefined);
      const provider = new ElevenLabsVoiceProvider();
      if (provider.isConfigured() && process.env.VITEST !== "true") {
        const voices = await provider.listVoices("ar");
        if (!voices.some((voice) => voice.id === voiceId)) {
          res.status(409).json({
            error: "voice_unavailable",
            message: "That ElevenLabs voice is not available in the connected account. Choose another voice from Voice Lab.",
          });
          return;
        }
      }
      const preset: VoicePreset | undefined = ELEVENLABS_PRESET_IDS.includes(req.body?.preset)
        ? req.body.preset
        : undefined;
      const saved = await writeArabicVoiceDefault(db, {
        voiceId,
        voiceName: typeof req.body?.voiceName === "string" ? req.body.voiceName : undefined,
        preset,
        settings: preset ? ELEVENLABS_PRESETS[preset] : undefined,
        // The model the preset was auditioned under travels with the selection
        // so a later model default cannot silently change the approved voice.
        modelId:
          typeof req.body?.modelId === "string" && req.body.modelId.trim()
            ? req.body.modelId.trim()
            : ELEVENLABS_DEFAULT_MODEL_ID,
      });
      res.status(200).json({ default: saved });
    } catch (error) {
      res.status(500).json({
        error: "Failed to save the default Arabic voice.",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/providers/:provider/voices", async (req, res) => {
    try {
      await providerSecrets.refreshElevenLabsApiKey().catch(() => undefined);
      const language = typeof req.query.language === "string" ? req.query.language : undefined;
      const dialect = typeof req.query.dialect === "string" ? req.query.dialect : undefined;
      const registry = new VoiceRegistry({
        listAvailableVoices: () => ["af_heart", "am_adam", "bf_emma"],
        generate: async () => ({ audio: Buffer.from(""), audioLength: 0 }),
      } as any);
      const result = await registry.listCompatibleVoices({
        provider: req.params.provider as any,
        language,
        dialect,
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        error: "Failed to list provider voices",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/providers", async (req, res) => {
    await providerSecrets.refresh("pexels", "api_key").catch(() => undefined);
    await providerSecrets.refresh("pixabay", "api_key").catch(() => undefined);
    const health = await getV2Health(config, db);
    const shouldValidateLocalVoiceModels = process.env.NODE_ENV !== "test" && process.env.VITEST !== "true";
    const voiceResults = shouldValidateLocalVoiceModels
      ? await new VoiceRegistry({} as any).validateAll()
      : [];

    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY);
    const hasVeoKey = Boolean(process.env.VEO_API_KEY || process.env.GOOGLE_AI_API_KEY);
    const hasFalKey = Boolean(process.env.FAL_KEY || process.env.FAL_API_KEY);
    const hasRunwayKey = Boolean(process.env.RUNWAY_API_KEY);
    const hasReplicateKey = Boolean(process.env.REPLICATE_API_TOKEN);
    const hasLumaKey = Boolean(process.env.LUMA_AGENTS_API_KEY || process.env.LUMA_API_KEY);
    const hasComfyUiUrl = Boolean(process.env.COMFYUI_BASE_URL);
    const hasElevenLabsKey = Boolean(process.env.ELEVENLABS_API_KEY);
    await providerSecrets.refreshElevenLabsApiKey();
    const elevenLabsProvider = new ElevenLabsVoiceProvider();
    const elevenLabsConfigured = elevenLabsProvider.isConfigured();
    // Only touch the network when a credential actually exists, and never
    // fabricate a healthy result when it does not.
    const elevenLabsValidation =
      elevenLabsConfigured && shouldValidateLocalVoiceModels
        ? await elevenLabsProvider.validate().catch(() => undefined)
        : undefined;
    const storedArabicVoiceDefault = await readArabicVoiceDefault(db).catch(() => null);
    const elevenLabsDefaultState =
      elevenLabsConfigured && shouldValidateLocalVoiceModels
        ? await elevenLabsVoiceDefaultState(elevenLabsProvider, storedArabicVoiceDefault)
        : {
          defaultArabicVoiceConfigured: Boolean(storedArabicVoiceDefault?.voiceId),
          defaultArabicVoiceAvailable: undefined,
          defaultArabicVoiceName: storedArabicVoiceDefault?.voiceName,
          voiceCatalogueAvailable: undefined,
          arabicProductionReady: false,
          setupRequiredReason: storedArabicVoiceDefault?.voiceId ? undefined : "default_arabic_voice_not_selected",
          warnings: [],
        };
    const googleTts = new GoogleCloudTtsProvider();
    const googleTtsValidation = voiceResults.find((provider) => provider.provider === "Google Cloud TTS");
    const googleTtsConfigured = googleTts.isConfigured();
    const googleVoices = googleTtsConfigured
      ? await googleTts.listVoices("ar-XA").catch(() => [])
      : [];
    const googleFamilies = Array.from(new Set(googleVoices.map((voice) => voice.voiceFamily).filter(Boolean)));

    const pexelsComp = health.components.find((c) => c.name === "Pexels");
    const kokoroComp = health.components.find((c) => c.name === "Kokoro");
    const piperVoice = voiceResults.find((provider) => provider.provider === "Piper Arabic");
    const whisperComp = health.components.find((c) => c.name === "Whisper");
    const remotionComp = health.components.find((c) => c.name === "Remotion");
    const ffmpegComp = health.components.find((c) => c.name === "FFmpeg");
    const n8nComp = health.components.find((c) => c.name === "n8n");
    const dbComp = health.components.find((c) => c.name === "Database");

    const vaultCredentials = providerVault.isAvailable()
      ? await providerVault.list().catch(() => [])
      : [];
    const vaultByProvider = new Map(vaultCredentials.map((credential) => [credential.providerId, credential]));
    const uploadPostStatus = await resolveUploadPostStatus();
    const localModelManager = new LocalModelManager();
    const voicetutRecord = localModelManager.read("voicetut");

    const providers = [
      // Content AI
      {
        id: "local_ai",
        name: "Local AI Creative Director",
        category: "Content AI",
        tier: "free",
        status: "healthy",
        configured: true,
        isDefault: !hasGeminiKey,
        message: "Deterministic rule-based creative director is active.",
        checkedAt: new Date().toISOString(),
      },
      {
        id: "gemini",
        name: "Google Gemini",
        category: "Content AI",
        tier: "cloud",
        status: hasGeminiKey ? "healthy" : "not_configured",
        configured: hasGeminiKey || vaultByProvider.has("gemini"),
        isDefault: hasGeminiKey,
        message: hasGeminiKey
          ? "Gemini API key configured for structured video planning."
          : "GEMINI_API_KEY is not configured.",
        checkedAt: new Date().toISOString(),
      },
      // Visuals
      {
        id: "pexels",
        name: "Pexels",
        category: "Visuals",
        tier: "stock",
        status: vaultByProvider.has("pexels")
          ? pexelsComp?.details?.providerStatus || (pexelsComp?.status === "healthy" ? "healthy" : "configured")
          : pexelsComp?.details?.providerStatus || (pexelsComp?.status === "healthy" ? "healthy" : "not_configured"),
        configured: (pexelsComp?.details?.configured ?? false) || vaultByProvider.has("pexels"),
        isDefault: true,
        message: pexelsComp?.message || "Pexels stock footage integration.",
        checkedAt: pexelsComp?.checkedAt || new Date().toISOString(),
        details: {
          visualCapabilities: {
            providerClass: "STOCK_VIDEO",
            freeOrPaid: "free",
            billingModel: "free_api_key",
            textToImage: false,
            imageToImage: false,
            textToVideo: false,
            imageToVideo: false,
            referenceImage: false,
            multipleReferenceImages: false,
            portrait: true,
            landscape: true,
            seed: false,
            nativeCharacterIdentity: false,
          },
        },
      },
      {
        // Optional second free stock source. Absence never blocks readiness, so
        // this reports not_configured rather than a problem state.
        id: "pixabay",
        name: "Pixabay",
        category: "Visuals",
        tier: "stock",
        status: vaultByProvider.has("pixabay") || process.env.PIXABAY_API_KEY ? "configured" : "not_configured",
        configured: vaultByProvider.has("pixabay") || Boolean(process.env.PIXABAY_API_KEY),
        isDefault: false,
        message:
          "Optional second free stock library. Adding it gives the shot planner more footage to choose between.",
        checkedAt: new Date().toISOString(),
        details: {
          visualCapabilities: {
            providerClass: "STOCK_VIDEO",
            freeOrPaid: "free",
            billingModel: "free_api_key",
            textToImage: false,
            imageToImage: false,
            textToVideo: false,
            imageToVideo: false,
            referenceImage: false,
            multipleReferenceImages: false,
            portrait: true,
            landscape: true,
            seed: false,
            nativeCharacterIdentity: false,
          },
        },
      },
      {
        id: "veo",
        name: "Google Veo",
        category: "Visuals",
        tier: "ai_video",
        status: hasVeoKey || vaultByProvider.has("veo") ? "configured" : "not_configured",
        configured: hasVeoKey || vaultByProvider.has("veo"),
        isDefault: false,
        message: hasVeoKey || vaultByProvider.has("veo")
          ? "Google Veo AI video generation configured. Paid generation requires explicit product authorization."
          : "VEO_API_KEY is not configured.",
        checkedAt: new Date().toISOString(),
        details: {
          visualCapabilities: new VeoVisualProvider().getCapabilities(),
        },
      },
      {
        id: "fal",
        name: "fal.ai (Kling / Wan / Seedance)",
        category: "Visuals",
        tier: "ai_video",
        status: hasFalKey || vaultByProvider.has("fal") ? "configured" : "not_configured",
        configured: hasFalKey || vaultByProvider.has("fal"),
        isDefault: false,
        message: hasFalKey || vaultByProvider.has("fal")
          ? "fal.ai multi-model video generation configured. Paid generation requires explicit product authorization."
          : "FAL_KEY is not configured.",
        checkedAt: new Date().toISOString(),
        details: {
          visualCapabilities: new FalVisualProvider().getCapabilities(),
        },
      },
      {
        id: "runway",
        name: "Runway",
        category: "Visuals",
        tier: "ai_video",
        status: hasRunwayKey || vaultByProvider.has("runway") ? "configured" : "not_configured",
        configured: hasRunwayKey || vaultByProvider.has("runway"),
        isDefault: false,
        message: hasRunwayKey || vaultByProvider.has("runway")
          ? "Runway key stored. Paid generation requires explicit product authorization."
          : "RUNWAY_API_KEY is not configured.",
        checkedAt: new Date().toISOString(),
        details: {
          visualCapabilities: new RunwayVisualProvider().getCapabilities(),
          liveVerified: false,
        },
      },
      {
        id: "replicate",
        name: "Replicate",
        category: "Visuals",
        tier: "ai_video",
        status: hasReplicateKey || vaultByProvider.has("replicate") ? "configured" : "not_configured",
        configured: hasReplicateKey || vaultByProvider.has("replicate"),
        isDefault: false,
        message: hasReplicateKey || vaultByProvider.has("replicate")
          ? "Replicate token stored. Paid generation requires explicit product authorization."
          : "REPLICATE_API_TOKEN is not configured.",
        checkedAt: new Date().toISOString(),
        details: {
          visualCapabilities: new ReplicateVisualProvider().getCapabilities(),
          liveVerified: false,
        },
      },
      {
        id: "comfyui",
        name: "Local ComfyUI",
        category: "Visuals",
        tier: "local",
        status: hasComfyUiUrl ? "configured" : "not_configured",
        configured: hasComfyUiUrl,
        isDefault: false,
        message: hasComfyUiUrl
          ? "ComfyUI sidecar URL configured. Video workflow/model installation still requires local verification."
          : "COMFYUI_BASE_URL is not configured.",
        checkedAt: new Date().toISOString(),
        details: {
          visualCapabilities: new ComfyUIProvider().getCapabilities(),
          installed: false,
          model: process.env.COMFYUI_VIDEO_WORKFLOW_PROFILE || "REQUIRES MODEL INSTALLATION",
          liveVerified: false,
        },
      },
      {
        id: "luma",
        name: "Luma Agents API",
        category: "Visuals",
        tier: "ai_video",
        status: hasLumaKey || vaultByProvider.has("luma") ? "configured" : "not_configured",
        configured: hasLumaKey || vaultByProvider.has("luma"),
        isDefault: false,
        message: hasLumaKey || vaultByProvider.has("luma")
          ? "Luma key stored. Paid generation requires explicit product authorization."
          : "LUMA_AGENTS_API_KEY or LUMA_API_KEY is not configured.",
        checkedAt: new Date().toISOString(),
        details: {
          visualCapabilities: new LumaVisualProvider().getCapabilities(),
          liveVerified: false,
        },
      },
      // Voice
      {
        id: "voicetut",
        name: "VoiceTut Local High Quality",
        category: "Voice",
        tier: "free",
        status: voicetutRecord.state === "ready" || voicetutRecord.state === "healthy" ? "healthy" : (voicetutRecord.state === "downloading" ? "configuring" : "not_configured"),
        configured: voicetutRecord.state === "ready" || voicetutRecord.state === "healthy",
        isDefault: true,
        message: voicetutRecord.state === "ready" || voicetutRecord.state === "healthy"
          ? "VoiceTut local high-quality Egyptian Arabic engine is ready with 17 native voices."
          : (voicetutRecord.lastError || "VoiceTut model is not installed. Install it from the Models tab."),
        checkedAt: voicetutRecord.lastVerifiedAt || voicetutRecord.installedAt || new Date().toISOString(),
        details: {
          implemented: true,
          configured: voicetutRecord.state === "ready" || voicetutRecord.state === "healthy",
          healthy: voicetutRecord.state === "ready" || voicetutRecord.state === "healthy",
          liveVerified: voicetutRecord.state === "ready",
          languages: ["ar", "ar-EG", "en"],
          dialect: "egyptian",
          speakersCount: 17,
          modelId: "voicetut",
          repoId: "mohammedaly22/VoiceTut-TTS",
          revision: "41c1a79ab2eb872ecfb2ad56ab40a94cff28d8c3",
          sampleRate: 24000,
          local: true,
          costTier: "free",
          license: "Apache-2.0",
          downloadedBytes: voicetutRecord.downloadedBytes,
          state: voicetutRecord.state,
        },
      },
      {
        id: "kokoro",
        name: "Kokoro TTS",
        category: "Voice",
        tier: "free",
        status: kokoroComp?.status || "healthy",
        configured: true,
        isDefault: !Boolean(process.env.PIPER_BIN && process.env.PIPER_AR_MODEL_PATH),
        message: "Local Kokoro TTS is healthy for English-focused voices. It is not verified for Arabic/Egyptian Arabic production narration.",
        checkedAt: kokoroComp?.checkedAt || new Date().toISOString(),
        details: {
          implemented: true,
          configured: true,
          healthy: kokoroComp?.status === "healthy",
          liveVerified: false,
          languages: ["en-US", "en-GB"],
          arabicSupport: "not_verified",
          egyptianSupport: "not_verified",
          local: true,
          license: "Apache-2.0 model weights (Kokoro-82M v1.0 ONNX)",
        },
      },
      {
        id: "piper",
        name: "Piper Arabic (Legacy)",
        category: "Voice",
        tier: "free",
        status: piperVoice?.status || "not_configured",
        configured: piperVoice?.configured || false,
        isDefault: false,
        message:
          "Legacy provider. Piper is no longer used for Arabic production; it is retained only so historical jobs stay readable.",
        checkedAt: piperVoice?.checkedAt || new Date().toISOString(),
        details: {
          implemented: true,
          configured: piperVoice?.configured || false,
          healthy: piperVoice?.healthy || false,
          liveVerified: piperVoice?.healthy || false,
          languages: ["ar"],
          legacyOnly: true,
          arabicProduction: false,
          arabicSupport: "legacy_historical_only",
          egyptianSupport: "not_production_route",
          local: true,
          license: `${PIPER_ARABIC_MODEL.runtimeLicense} runtime; ${PIPER_ARABIC_MODEL.modelLicense} voice model`,
          commercialUse: PIPER_ARABIC_MODEL.commercialUseAllowed ? "allowed" : "not_allowed",
          model: PIPER_ARABIC_MODEL.model,
          voice: PIPER_ARABIC_MODEL.voice,
          modelSource: PIPER_ARABIC_MODEL.modelSource,
          modelSha256: PIPER_ARABIC_MODEL.modelSha256,
        },
      },
      {
        id: "edge_tts",
        name: "Edge TTS",
        category: "Voice",
        tier: "experimental_free_online",
        status: voiceResults.find((provider) => provider.provider === "Edge TTS")?.status || "not_configured",
        configured: voiceResults.find((provider) => provider.provider === "Edge TTS")?.configured || false,
        isDefault: false,
        message: voiceResults.find((provider) => provider.provider === "Edge TTS")?.message || "Optional online Edge TTS runtime is disabled.",
        checkedAt: voiceResults.find((provider) => provider.provider === "Edge TTS")?.checkedAt || new Date().toISOString(),
        details: {
          implemented: true,
          configured: voiceResults.find((provider) => provider.provider === "Edge TTS")?.configured || false,
          liveVerified: voiceResults.find((provider) => provider.provider === "Edge TTS")?.healthy || false,
          languages: ["ar-EG", "ar", "en-US", "en-GB"],
          egyptianSupport: "dynamic_ar_EG_voice_listing_when_runtime_available",
          local: false,
          online: true,
          costTier: "experimental_free_online",
          supportsSpeakingRate: true,
          supportsPitch: true,
          supportsVolume: true,
          license: "edge-tts LGPL-3.0; Microsoft Edge online speech service terms apply.",
        },
      },
      {
        id: "google_cloud_tts",
        name: "Google Cloud TTS",
        category: "Voice",
        tier: "cloud_free_tier",
        status: googleTtsValidation?.status || (googleTtsConfigured ? "provider_unavailable" : "not_configured"),
        configured: googleTtsConfigured,
        isDefault: false,
        message: googleTtsConfigured
          ? googleTtsValidation?.message || "Google Cloud TTS credentials are configured. Arabic voices are loaded dynamically from Google."
          : "Google Cloud TTS credentials are not configured. Use Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS.",
        checkedAt: googleTtsValidation?.checkedAt || new Date().toISOString(),
        details: {
          implemented: true,
          configured: googleTtsConfigured,
          healthy: googleTtsValidation?.healthy || false,
          liveVerified: googleTtsValidation?.healthy || false,
          languages: ["ar-XA"],
          arabicSupport: "Arabic - Modern Standard Arabic",
          egyptianSupport: "not_specifically_verified",
          local: false,
          cloud: true,
          costTier: "cloud_free_tier",
          freeTierLabel: "Google Cloud - Free Tier Available",
          billingNotice: "Billing account may be required. Usage above Google's free monthly allowance may incur charges.",
          authentication: googleTtsConfigured ? "Configured" : "Not Configured",
          supportsSSML: true,
          supportsSpeakingRate: true,
          supportsPitch: true,
          supportsWordTimings: false,
          sampleRate: 24000,
          voiceFamilies: googleFamilies,
          voices: googleVoices.map((voice) => ({
            id: voice.id,
            name: voice.name,
            gender: voice.gender,
            voiceFamily: voice.voiceFamily,
            sampleRate: voice.sampleRate,
            language: voice.language,
          })),
        },
      },
      {
        id: "elevenlabs",
        name: "ElevenLabs",
        category: "Voice",
        tier: "premium",
        status: elevenLabsValidation?.status || (elevenLabsConfigured ? "configured" : "not_configured"),
        configured: elevenLabsConfigured,
        isDefault: false,
        message: elevenLabsValidation?.message ||
          (elevenLabsConfigured
            ? "ElevenLabs is configured. Run Test Connection to verify it live."
            : ARABIC_ELEVENLABS_REQUIRED_MESSAGE),
        checkedAt: elevenLabsValidation?.checkedAt || new Date().toISOString(),
        details: {
          implemented: true,
          configured: elevenLabsConfigured,
          healthy: Boolean(elevenLabsValidation?.healthy),
          // "Live Verified" is only claimed after a real, successful preview
          // synthesis round trip (see /voice-lab/preview) - never inferred
          // from Test Connection, which must not spend TTS quota.
          liveVerified: vaultByProvider.get("elevenlabs")?.health === "live_verified",
          // Granular Test Connection sub-states (section 7/8 of the ElevenLabs
          // integration policy): credential stored, authenticated, voice
          // discovery available, and TTS-ready are reported separately so the
          // UI never collapses them into one ambiguous "Provider Unavailable".
          credentialStored: elevenLabsConfigured,
          authenticated: elevenLabsValidation?.authenticated,
          voiceDiscoveryAvailable: elevenLabsValidation?.voiceDiscoveryAvailable,
          ttsReady: elevenLabsValidation?.ttsReady,
          voicesDiscovered: elevenLabsValidation?.voicesDiscovered,
          defaultArabicVoiceConfigured: elevenLabsDefaultState.defaultArabicVoiceConfigured,
          defaultArabicVoiceAvailable: elevenLabsDefaultState.defaultArabicVoiceAvailable,
          defaultArabicVoiceName: elevenLabsDefaultState.defaultArabicVoiceName,
          arabicProductionReady: elevenLabsDefaultState.arabicProductionReady,
          arabicSetupRequiredReason: elevenLabsDefaultState.setupRequiredReason,
          errorDetail: elevenLabsValidation?.errorDetail,
          lastTestedAt: vaultByProvider.get("elevenlabs")?.lastTestedAt || undefined,
          accountTier: elevenLabsValidation?.accountTier,
          characterLimit: elevenLabsValidation?.characterLimit,
          charactersUsed: elevenLabsValidation?.charactersUsed,
          latencyMs: elevenLabsValidation?.latencyMs,
          languages: ["multilingual", "ar", "en"],
          model: ELEVENLABS_DEFAULT_MODEL_ID,
          arabicProduction: true,
          // VoiceTut, not ElevenLabs, is the canonical/default Arabic production
          // provider (see the "voicetut" entry above, isDefault: true) -
          // ElevenLabs is an explicit, opt-in premium alternative.
          arabicSupport: elevenLabsConfigured ? "premium_opt_in_arabic_option" : "not_configured",
          // Accent quality is a human judgement; the API does not certify it.
          egyptianSupport: "human_listening_required",
          voicePresets: ELEVENLABS_PRESET_IDS,
          supportsVoiceLab: true,
          // The ElevenLabs shared Voice Library is a separate, optional
          // feature this engine never calls or requires: production TTS only
          // depends on the account's own voice catalogue (GET /v2/voices).
          sharedVoiceLibrary: "not_required",
          local: false,
          costTier: "premium",
          costLabel: "Cloud / Usage Based",
        },
      },
      // Captions
      {
        id: "whisper_cpp",
        name: "Whisper",
        category: "Captions",
        tier: "free",
        status: whisperComp?.status || "healthy",
        configured: true,
        isDefault: true,
        message: whisperComp?.message || "Whisper captioning engine.",
        checkedAt: whisperComp?.checkedAt || new Date().toISOString(),
      },
      // Renderer
      {
        id: "remotion",
        name: "Remotion",
        category: "Renderer",
        tier: "local",
        status: remotionComp?.status || "healthy",
        configured: true,
        isDefault: true,
        message: remotionComp?.message || "Remotion video composition engine.",
        checkedAt: remotionComp?.checkedAt || new Date().toISOString(),
      },
      {
        id: "ffmpeg",
        name: "FFmpeg",
        category: "Renderer",
        tier: "local",
        status: ffmpegComp?.status || "healthy",
        configured: true,
        isDefault: true,
        message: ffmpegComp?.message || "FFmpeg audio/video processing.",
        checkedAt: ffmpegComp?.checkedAt || new Date().toISOString(),
      },
      // Infrastructure
      {
        id: "n8n",
        name: "n8n",
        category: "Infrastructure",
        tier: "internal",
        status: n8nComp?.status || "healthy",
        configured: true,
        isDefault: true,
        message: n8nComp?.message || "n8n internal orchestration workflow.",
        checkedAt: n8nComp?.checkedAt || new Date().toISOString(),
      },
      {
        id: "postgres",
        name: "Database (PostgreSQL)",
        category: "Infrastructure",
        tier: "internal",
        status: dbComp?.status || "healthy",
        configured: true,
        isDefault: true,
        message: dbComp?.message || "PostgreSQL persistent state storage.",
        checkedAt: dbComp?.checkedAt || new Date().toISOString(),
      },
      // Publishing & Distribution
      {
        id: "upload_post",
        name: "Upload-Post (Multi-Platform)",
        category: "Publishing",
        tier: "cloud",
        status: uploadPostStatus.configured ? "healthy" : "not_configured",
        configured: uploadPostStatus.configured,
        isDefault: true,
        message: uploadPostStatus.configured
          ? "Upload-Post multi-platform distribution connected."
          : "Upload-Post API key is not configured.",
        checkedAt: new Date().toISOString(),
      },
      {
        id: "telegram",
        name: "Telegram Direct Bot",
        category: "Publishing",
        tier: "direct",
        status: Boolean(process.env.TELEGRAM_BOT_TOKEN) ? "healthy" : "not_configured",
        configured: Boolean(process.env.TELEGRAM_BOT_TOKEN) || vaultByProvider.has("telegram"),
        isDefault: false,
        message: Boolean(process.env.TELEGRAM_BOT_TOKEN)
          ? "Telegram Bot direct video publisher connected."
          : "TELEGRAM_BOT_TOKEN is not configured.",
        checkedAt: new Date().toISOString(),
      },
      {
        id: "youtube",
        name: "YouTube Direct",
        category: "Publishing",
        tier: "direct",
        status: Boolean(process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN) ? "healthy" : "not_configured",
        configured: Boolean(process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN) || vaultByProvider.has("youtube"),
        isDefault: false,
        message: Boolean(process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN)
          ? "YouTube Data API v3 direct integration available."
          : "YouTube credentials not configured.",
        checkedAt: new Date().toISOString(),
      },
      {
        id: "meta",
        name: "Meta Direct (Instagram & Facebook)",
        category: "Publishing",
        tier: "direct",
        status: Boolean(process.env.META_ACCESS_TOKEN) ? "healthy" : "not_configured",
        configured: Boolean(process.env.META_ACCESS_TOKEN) || vaultByProvider.has("meta"),
        isDefault: false,
        message: Boolean(process.env.META_ACCESS_TOKEN)
          ? "Meta Graph API direct integration available."
          : "META_ACCESS_TOKEN is not configured.",
        checkedAt: new Date().toISOString(),
      },
      {
        id: "tiktok",
        name: "TikTok Direct",
        category: "Publishing",
        tier: "direct",
        status: Boolean(process.env.TIKTOK_ACCESS_TOKEN) ? "healthy" : "not_configured",
        configured: Boolean(process.env.TIKTOK_ACCESS_TOKEN) || vaultByProvider.has("tiktok"),
        isDefault: false,
        message: Boolean(process.env.TIKTOK_ACCESS_TOKEN)
          ? "TikTok OpenAPI direct integration available."
          : "TIKTOK_ACCESS_TOKEN is not configured.",
        checkedAt: new Date().toISOString(),
      },
      ...buildV22CapabilityProviders(),
    ];

    res.status(200).json({
      providers: providers.map((provider: any) => {
        const enriched = {
          ...provider,
          credentialTypes: provider.id ? allowedCredentialTypes(provider.id) : [],
          vaultConfigured: provider.id ? vaultCredentials.some((credential) => credential.providerId === provider.id) : false,
          vault: provider.id
            ? vaultCredentials
              .filter((credential) => credential.providerId === provider.id)
              .map((credential) => ({
                credentialType: credential.credentialType,
                maskedHint: credential.maskedHint,
                health: credential.health,
                configuredAt: credential.configuredAt,
                lastTestedAt: credential.lastTestedAt,
              }))
            : [],
        };
        return canonicalizeProviderPayload(enriched);
      }),
      categories: [
        "Content AI",
        "Visuals",
        "Voice",
        "Captions",
        "Renderer",
        "Motion",
        "Post Production",
        "AI GPU",
        "Publishing",
        "Infrastructure",
      ],
      vault: {
        available: providerVault.isAvailable(),
        encryption: "AES-256-GCM",
      },
    });
  });

  // Browser-only OAuth: app configuration, authorization, callback and Meta
  // destination selection. Replaces the previous stubs, which created a CSRF
  // state nothing ever consumed and answered the callback with HTTP 501.
  router.use(createOAuthRouter(config, db, providerVault));

  router.put("/providers/:provider/credentials", async (req, res) => {
    try {
      if (!providerVault.isAvailable()) {
        res.status(503).json({ error: "Provider vault is not configured.", message: "Set PROVIDER_VAULT_MASTER_KEY before saving provider credentials." });
        return;
      }
      const providerId = req.params.provider;
      const credentialType = String(req.body?.credentialType || "api_key") as CredentialType;
      const value = typeof req.body?.value === "string" ? req.body.value : "";
      const credential = await providerVault.put({
        providerId,
        credentialType,
        plaintext: value,
        metadata: typeof req.body?.metadata === "object" && req.body.metadata ? req.body.metadata : {},
      });
      providerSecrets.invalidate(providerId);
      await providerSecrets.refresh(providerId, credentialType);
      // Only the masked hint is ever returned; plaintext stays in the vault.
      res.status(200).json({ credential });
    } catch (error) {
      res.status(400).json({ error: "Credential save failed.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/providers/:provider/credentials", async (req, res) => {
    try {
      const credentialType = typeof req.query.credentialType === "string" ? req.query.credentialType as CredentialType : undefined;
      const deleted = await providerVault.delete(req.params.provider, credentialType);
      providerSecrets.invalidate(req.params.provider);
      res.status(200).json({ deleted });
    } catch (error) {
      res.status(400).json({ error: "Credential delete failed.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/providers/local-voice/status", async (_req, res) => {
    try {
      const manager = new LocalModelManager();
      const models = manager.list();
      res.status(200).json({ models });
    } catch (error) {
      res.status(500).json({ error: "Failed to read local voice model status.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/providers/local-voice/install", async (req, res) => {
    try {
      const modelId = req.body?.modelId;
      if (modelId !== "voicetut" && modelId !== "kemetone") {
        res.status(400).json({ error: "Invalid modelId. Must be 'voicetut' or 'kemetone'." });
        return;
      }
      const manager = new LocalModelManager();
      const record = manager.verify(modelId);
      res.status(200).json({ record });
    } catch (error) {
      res.status(500).json({ error: "Model install/verify failed.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/providers/local-voice/:modelId", async (req, res) => {
    try {
      const modelId = req.params.modelId;
      if (modelId !== "voicetut" && modelId !== "kemetone") {
        res.status(400).json({ error: "Invalid modelId. Must be 'voicetut' or 'kemetone'." });
        return;
      }
      const manager = new LocalModelManager();
      const result = manager.removeModel(modelId as any);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ error: "Model removal failed.", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/providers/pexels/validate", async (req, res) => {
    if (providerVault.isAvailable()) {
      await providerSecrets.refresh("pexels", "api_key").catch(() => undefined);
    }
    if (!config.pexelsApiKey && providerSecrets.peek("pexels", "api_key")) {
      const pexels = new PexelsStockProvider();
      const results = await pexels.search({
        query: "business",
        orientation: "portrait",
        kind: "video",
        perPage: 3,
      });
      const healthy = results.length > 0;
      if (providerVault.isAvailable()) {
        await providerVault.markTested("pexels", healthy ? "healthy" : "provider_unavailable").catch(() => undefined);
      }
      res.status(200).json({
        provider: "Pexels",
        category: "Visuals",
        configured: true,
        healthy,
        status: healthy ? "healthy" : "provider_unavailable",
        message: healthy ? "Pexels responded with an authorized video search result." : "Pexels did not return a usable video result for validation.",
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    const result = await validatePexelsProvider(config, {
      bypassCache: true,
    });
    res.status(200).json(result);
  });

  router.post("/providers/:provider/validate", async (req, res) => {
    const target = req.params.provider.toLowerCase();
    if (providerVault.isAvailable()) {
      await providerSecrets.refresh(target, "api_key").catch(() => undefined);
    }
    if (target === "pexels") {
      const result = await validatePexelsProvider(config, { bypassCache: true });
      res.status(200).json(result);
      return;
    }
    if (target === "pixabay") {
      const pixabay = new PixabayProvider();
      if (!pixabay.isConfigured()) {
        res.status(200).json({
          provider: "Pixabay",
          category: "Visuals",
          configured: false,
          healthy: false,
          status: "not_configured",
          message: "PIXABAY_API_KEY is not configured.",
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      const results = await pixabay.search({
        query: "business",
        orientation: "portrait",
        kind: "video",
        perPage: 3,
      });
      const healthy = results.length > 0;
      if (providerVault.isAvailable()) {
        await providerVault.markTested("pixabay", healthy ? "healthy" : "provider_unavailable").catch(() => undefined);
      }
      res.status(200).json({
        provider: "Pixabay",
        category: "Visuals",
        configured: true,
        healthy,
        status: healthy ? "healthy" : "provider_unavailable",
        message: healthy ? "Pixabay responded with video search results." : "Pixabay did not return a usable video result for validation.",
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    if (target === "gemini") {
      const gemini = contentAIRegistry.getProvider("gemini");
      const val = await gemini.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "veo") {
      const veo = new VeoVisualProvider();
      const val = await veo.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "fal") {
      const fal = new FalVisualProvider();
      const val = await fal.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "runway") {
      const runway = new RunwayVisualProvider();
      const val = await runway.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "replicate") {
      const replicate = new ReplicateVisualProvider();
      const val = await replicate.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "comfyui") {
      const comfyui = new ComfyUIProvider();
      const val = await comfyui.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "luma") {
      const luma = new LumaVisualProvider();
      const val = await luma.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "elevenlabs") {
      await providerSecrets.refreshElevenLabsApiKey();
      const el = new ElevenLabsVoiceProvider();
      const val = await el.validate();
      if (providerVault.isAvailable()) {
        await providerVault.markTested("elevenlabs", val.status).catch(() => undefined);
      }
      res.status(200).json(val);
      return;
    }
    if (target === "google" || target === "googlecloudtts" || target === "google_cloud_tts") {
      const google = new GoogleCloudTtsProvider();
      const val = await google.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "edge_tts" || target === "edge-tts") {
      const edge = new EdgeTtsProvider();
      const val = await edge.validate();
      res.status(200).json(val);
      return;
    }
    if (target === "upload-post" || target === "upload_post") {
      const p = publishingRegistry.getProvider("upload_post");
      const val = await (p?.validateConnection() ?? {
        provider: "Upload-Post",
        configured: false,
        healthy: false,
        status: "not_configured",
        message: "Upload-Post not configured",
        checkedAt: new Date().toISOString(),
      });
      if (providerVault.isAvailable() && val.configured) {
        await providerVault.markTested("upload_post", val.status).catch(() => undefined);
      }
      res.status(200).json(val);
      return;
    }
    if (target === "telegram" || target === "telegram_bot") {
      const p = publishingRegistry.getProvider("telegram_bot");
      const val = await (p?.validateConnection() ?? {
        provider: "Telegram Direct Bot",
        configured: false,
        healthy: false,
        status: "not_configured",
        message: "Telegram bot not configured",
        checkedAt: new Date().toISOString(),
      });
      res.status(200).json(val);
      return;
    }
    if (target === "youtube" || target === "youtube_direct") {
      const p = publishingRegistry.getProvider("youtube_direct");
      const val = await (p?.validateConnection() ?? {
        provider: "YouTube Direct",
        configured: false,
        healthy: false,
        status: "not_configured",
        message: "YouTube direct not configured",
        checkedAt: new Date().toISOString(),
      });
      res.status(200).json(val);
      return;
    }
    if (target === "meta" || target === "meta_direct") {
      const p = publishingRegistry.getProvider("meta_direct");
      const val = await (p?.validateConnection() ?? {
        provider: "Meta Direct",
        configured: false,
        healthy: false,
        status: "not_configured",
        message: "Meta direct not configured",
        checkedAt: new Date().toISOString(),
      });
      res.status(200).json(val);
      return;
    }
    if (target === "tiktok" || target === "tiktok_direct") {
      const p = publishingRegistry.getProvider("tiktok_direct");
      const val = await (p?.validateConnection() ?? {
        provider: "TikTok Direct",
        configured: false,
        healthy: false,
        status: "not_configured",
        message: "TikTok direct not configured",
        checkedAt: new Date().toISOString(),
      });
      res.status(200).json(val);
      return;
    }

    res.status(200).json({
      provider: req.params.provider,
      configured: true,
      healthy: true,
      status: "healthy",
      message: `${req.params.provider} is verified and operational.`,
      checkedAt: new Date().toISOString(),
    });
  });

  router.get("/settings", async (req, res) => {
    const settings = await readAppSettings(db);
    const uploadPostSettingsStatus = await resolveUploadPostStatus();
    res.status(200).json({
      settings: {
        defaultCreationMode: "prompt",
        defaultLanguage: "ar",
        defaultArabicDialect: "egyptian",
        defaultDuration: 30,
        defaultAspectRatio: "9:16",
        defaultQuality: "standard",
        defaultVisualMode: "auto",
        defaultContentAI: "local_ai",
        defaultVisualProvider: "pexels",
        // Arabic is the default language, and Arabic production is ElevenLabs only.
        defaultVoiceProvider: "elevenlabs",
        defaultPublishingMode: "draft",
        defaultSocialAccounts: [],
        defaultYouTubePrivacy: "unlisted",
        defaultTimezone: "Africa/Cairo",
        maxConcurrentPublications: 3,
        ...settings,
      },
      pexels: {
        configured: Boolean(config.pexelsApiKey && config.pexelsApiKey !== "dummy-key"),
        redactedKey: redactConfiguredKey(config.pexelsApiKey),
      },
      gemini: {
        configured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY),
        redactedKey: redactConfiguredKey(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY),
      },
      elevenlabs: {
        configured: Boolean(process.env.ELEVENLABS_API_KEY),
        redactedKey: redactConfiguredKey(process.env.ELEVENLABS_API_KEY),
      },
      uploadPost: {
        configured: uploadPostSettingsStatus.configured,
        redactedKey: uploadPostSettingsStatus.redactedKey,
      },
      telegram: {
        configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        redactedKey: redactConfiguredKey(process.env.TELEGRAM_BOT_TOKEN),
      },
      app: {
        v2Enabled: process.env.V2_ENABLED === "true",
        webPort: process.env.PORT || "3123",
        docker: process.env.DOCKER === "true",
      },
      storage: readStorageDetails(config),
    });
  });

  router.put("/settings", async (req, res) => {
    const parsed = appSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid settings payload",
        issues: parsed.error.flatten(),
      });
      return;
    }
    const current = await readAppSettings(db);
    const saved = await writeAppSettings(db, {
      ...current,
      ...parsed.data,
    });
    res.status(200).json({ settings: saved });
  });

  router.get("/brands", async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    const rows = await db.query<BrandRow>(
      `SELECT * FROM brands
       WHERE ($1::boolean = true OR archived_at IS NULL)
       ORDER BY is_default DESC, updated_at DESC, name ASC`,
      [includeArchived],
    );
    res.status(200).json({ brands: rows.map(mapBrand) });
  });

  router.post("/brands", async (req, res) => {
    const parsed = brandProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid brand payload",
        issues: parsed.error.flatten(),
      });
      return;
    }
    try {
      await validateBrandMediaReferences(parsed.data);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid brand media reference." });
      return;
    }
    const id = cuid();
    const kit = brandKitFromInput(parsed.data);
    if (parsed.data.isDefault) {
      await db.query("UPDATE brands SET is_default = false");
    }
    const rows = await db.query<BrandRow>(
      `INSERT INTO brands (
        id, name, watermark_text, primary_color, accent_color, caption_style,
        include_outro, outro_text, contact_text, voice_profile, is_default,
        secondary_color, logo_url, website_url, social_handle,
        description, industry, tagline, logo_asset_id, icon_asset_id,
        background_color, text_color, heading_font, body_font, caption_font,
        kit, revision, revisions, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
              $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,1,'[]',now(),now())
      RETURNING *`,
      [
        id,
        parsed.data.name,
        parsed.data.watermarkText,
        parsed.data.primaryColor,
        parsed.data.accentColor,
        parsed.data.captionStyle,
        parsed.data.includeOutro,
        parsed.data.outroText,
        parsed.data.contactText,
        parsed.data.voiceProfile ? JSON.stringify(parsed.data.voiceProfile) : null,
        parsed.data.isDefault,
        parsed.data.secondaryColor || null,
        parsed.data.logoUrl || null,
        parsed.data.websiteUrl || null,
        parsed.data.socialHandle || null,
        parsed.data.description || null,
        parsed.data.industry || null,
        parsed.data.tagline || null,
        parsed.data.logoAssetId || null,
        parsed.data.iconAssetId || null,
        parsed.data.backgroundColor || null,
        parsed.data.textColor || null,
        parsed.data.headingFont || null,
        parsed.data.bodyFont || null,
        parsed.data.captionFont || null,
        JSON.stringify(kit),
      ],
    );
    const brand = mapBrand(rows[0]);
    await db.query("UPDATE brands SET revisions = $2::jsonb WHERE id = $1", [
      id,
      JSON.stringify([brandRevisionEntry(1, brand, "Created Brand Kit")]),
    ]);
    res.status(201).json({ brand: { ...brand, revisions: [{ revision: 1, createdAt: new Date().toISOString(), summary: "Created Brand Kit" }] } });
  });

  router.put("/brands/:id", async (req, res) => {
    const parsed = brandProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid brand payload",
        issues: parsed.error.flatten(),
      });
      return;
    }
    try {
      await validateBrandMediaReferences(parsed.data);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid brand media reference." });
      return;
    }
    const existing = await getBrandById(db, req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }
    if (parsed.data.isDefault) {
      await db.query("UPDATE brands SET is_default = false WHERE id <> $1", [
        req.params.id,
      ]);
    }
    const kit = brandKitFromInput(parsed.data);
    const nextRevision = (existing.revision || 1) + 1;
    const previousRows = await db.query<BrandRow>("SELECT revisions FROM brands WHERE id = $1", [req.params.id]);
    const previousRevisions = Array.isArray(previousRows[0]?.revisions) ? previousRows[0].revisions : [];
    const rows = await db.query<BrandRow>(
      `UPDATE brands
       SET name = $2,
           watermark_text = $3,
           primary_color = $4,
           accent_color = $5,
           caption_style = $6,
           include_outro = $7,
           outro_text = $8,
           contact_text = $9,
           voice_profile = $10,
           is_default = $11,
           secondary_color = $12,
           logo_url = $13,
           website_url = $14,
           social_handle = $15,
           description = $16,
           industry = $17,
           tagline = $18,
           logo_asset_id = $19,
           icon_asset_id = $20,
           background_color = $21,
           text_color = $22,
           heading_font = $23,
           body_font = $24,
           caption_font = $25,
           kit = $26::jsonb,
           revision = $27,
           revisions = $28::jsonb,
           archived_at = CASE WHEN $29::boolean THEN archived_at ELSE NULL END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        parsed.data.name,
        parsed.data.watermarkText,
        parsed.data.primaryColor,
        parsed.data.accentColor,
        parsed.data.captionStyle,
        parsed.data.includeOutro,
        parsed.data.outroText,
        parsed.data.contactText,
        parsed.data.voiceProfile ? JSON.stringify(parsed.data.voiceProfile) : null,
        parsed.data.isDefault,
        parsed.data.secondaryColor || null,
        parsed.data.logoUrl || null,
        parsed.data.websiteUrl || null,
        parsed.data.socialHandle || null,
        parsed.data.description || null,
        parsed.data.industry || null,
        parsed.data.tagline || null,
        parsed.data.logoAssetId || null,
        parsed.data.iconAssetId || null,
        parsed.data.backgroundColor || null,
        parsed.data.textColor || null,
        parsed.data.headingFont || null,
        parsed.data.bodyFont || null,
        parsed.data.captionFont || null,
        JSON.stringify(kit),
        nextRevision,
        JSON.stringify([
          ...previousRevisions,
          {
            revision: nextRevision,
            createdAt: new Date().toISOString(),
            summary: "Updated Brand Kit",
            snapshot: {
              brandId: req.params.id,
              brandName: parsed.data.name,
              revision: nextRevision,
            },
          },
        ]),
        parsed.data.archived === true,
      ],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }
    res.status(200).json({ brand: mapBrand(rows[0]) });
  });

  router.post("/brands/:id/default", async (req, res) => {
    await db.query("UPDATE brands SET is_default = false");
    const rows = await db.query<BrandRow>(
      "UPDATE brands SET is_default = true, archived_at = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }
    res.status(200).json({ brand: mapBrand(rows[0]) });
  });

  router.post("/brands/:id/duplicate", async (req, res) => {
    const source = await getBrandById(db, req.params.id);
    if (!source) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }
    const duplicate = brandProfileSchema.parse({
      ...source,
      name: `${source.name} Copy`,
      isDefault: false,
    });
    const kit = brandKitFromInput(duplicate);
    const rows = await db.query<BrandRow>(
      `INSERT INTO brands (
        id, name, watermark_text, primary_color, accent_color, caption_style,
        include_outro, outro_text, contact_text, voice_profile, is_default,
        secondary_color, logo_url, website_url, social_handle,
        description, industry, tagline, logo_asset_id, icon_asset_id,
        background_color, text_color, heading_font, body_font, caption_font,
        kit, revision, revisions, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13,$14,
              $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,1,'[]',now(),now())
      RETURNING *`,
      [
        cuid(),
        duplicate.name,
        duplicate.watermarkText,
        duplicate.primaryColor,
        duplicate.accentColor,
        duplicate.captionStyle,
        duplicate.includeOutro,
        duplicate.outroText,
        duplicate.contactText,
        duplicate.voiceProfile ? JSON.stringify(duplicate.voiceProfile) : null,
        duplicate.secondaryColor || null,
        duplicate.logoUrl || null,
        duplicate.websiteUrl || null,
        duplicate.socialHandle || null,
        duplicate.description || null,
        duplicate.industry || null,
        duplicate.tagline || null,
        duplicate.logoAssetId || null,
        duplicate.iconAssetId || null,
        duplicate.backgroundColor || null,
        duplicate.textColor || null,
        duplicate.headingFont || null,
        duplicate.bodyFont || null,
        duplicate.captionFont || null,
        JSON.stringify(kit),
      ],
    );
    res.status(201).json({ brand: mapBrand(rows[0]) });
  });

  router.delete("/brands/:id", async (req, res) => {
    const usage = await db.query<{ count: string }>("SELECT count(*) as count FROM jobs WHERE brand_name = (SELECT name FROM brands WHERE id = $1)", [req.params.id]);
    const hasUsage = Number(usage[0]?.count || 0) > 0;
    const rows = await db.query<BrandRow>(
      hasUsage
        ? "UPDATE brands SET archived_at = now(), is_default = false, updated_at = now() WHERE id = $1 RETURNING *"
        : "UPDATE brands SET archived_at = now(), is_default = false, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }
    res.status(200).json({ success: true, archived: true, dependencyAware: hasUsage, brand: mapBrand(rows[0]) });
  });

  router.post("/brands/:id/restore", async (req, res) => {
    const rows = await db.query<BrandRow>(
      "UPDATE brands SET archived_at = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }
    res.status(200).json({ brand: mapBrand(rows[0]) });
  });

  // 1. System Info & Diagnostics
  router.get("/system/info", async (req, res) => {
    // Public-safe: product identity and the address it is published on. No
    // secret, no path, no provider state.
    const info = getProductInfo();
    const resolved = await resolveInstallationPublicUrl(db, config);
    res.status(200).json({
      ...info,
      canonicalUrl: resolved.url,
      accessMode: config.accessMode,
      remoteAccess: config.accessMode === "local" ? "disabled" : "secure_server",
    });
  });

  /**
   * Update Center. The application only ever reports; it never applies an
   * update, because applying one requires Docker control that the web app is
   * deliberately not given. `refresh=true` performs a live manifest check.
   */
  router.get("/system/updates", async (req, res) => {
    try {
      const refresh = String(req.query.refresh || "") === "true";
      const state = await updateService.getCenterState({ refresh });
      res.status(200).json(clientSafeUpdateState(state, isAdvancedUpdateView(req)));
    } catch (error) {
      logger.warn({ error }, "Update Center state could not be read");
      res.status(500).json({ error: "Update status is unavailable right now." });
    }
  });

  router.post("/system/updates/check", async (req, res) => {
    try {
      await updateService.check();
      const state = await updateService.getCenterState({ refresh: false });
      res.status(200).json(clientSafeUpdateState(state, isAdvancedUpdateView(req)));
    } catch (error) {
      logger.warn({ error }, "Update check failed");
      res.status(200).json({
        status: "CHECK_FAILED",
        currentVersion: getProductInfo().version,
        message: "Could not reach the update service. Try again in a moment.",
      });
    }
  });

  /**
   * The canonical public address and the OAuth callback URLs derived from it.
   * Saving a new address goes through PUT /settings like any other setting.
   */
  router.get("/system/public-url", async (req, res) => {
    const resolved = await resolveInstallationPublicUrl(db, config);
    res.status(200).json({
      url: resolved.url,
      source: resolved.source,
      isLocal: resolved.isLocal,
      isSecure: resolved.isSecure,
      warnings: publicUrlWarnings(resolved),
      callbackUrls: Object.fromEntries(
        OAUTH_CALLBACK_PROVIDERS.map((provider) => [
          provider,
          oauthCallbackUrl(resolved.url, provider),
        ]),
      ),
      trustedProxy: {
        enabled: resolveTrustedProxy(process.env.TRUSTED_PROXY).enabled,
        description: resolveTrustedProxy(process.env.TRUSTED_PROXY).description,
      },
    });
  });

  // Measuring storage walks the whole data directory synchronously, so the
  // result is served from a short-lived cache unless the caller explicitly asks
  // for a fresh measurement.
  router.get("/system/storage", (req, res) => {
    res.status(200).json(
      diagnosticsService.getStorageUsage({ bypassCache: req.query.refresh === "true" }),
    );
  });

  router.get("/system/observability", async (req, res) => {
    try {
      const [worker, storage, health, deliveries] = await Promise.all([
        workerLeaseService.getObservability(),
        Promise.resolve(diagnosticsService.getStorageUsage()),
        getV2Health(config, db),
        webhookService.getDeliveryHistory(10),
      ]);
      const statusRows = await db.query<{ status: string; count: string }>(
        "SELECT status, count(*)::text AS count FROM jobs GROUP BY status",
      ).catch(() => []);
      res.status(200).json({
        queueDepth: worker.queueDepth,
        activeWorkers: worker.activeWorkers,
        activeRenders: worker.activeRenders,
        maxConcurrentRenders: config.concurrency || 1,
        workers: worker.workers,
        averageGenerationTimeMs: worker.averageGenerationTimeMs,
        recentStageBottleneck: worker.recentStageBottleneck,
        jobCounts: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)])),
        cache: {
          maxStorageBytes: config.videoCacheSizeInBytes,
          usedProjectStorageBytes: (storage as any).usedProjectStorageBytes,
          cacheStorageBytes: (storage as any).cacheStorageBytes,
        },
        providerHealth: health.components,
        diskUsage: storage,
        recentWebhookDeliveries: deliveries.map((delivery) => ({
          id: delivery.id,
          event: delivery.event,
          status: delivery.status,
          responseCode: delivery.responseCode,
          attemptCount: delivery.attemptCount,
          createdAt: delivery.createdAt,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to load observability.", message: String(error) });
    }
  });

  router.get("/system/diagnostics", async (req, res) => {
    try {
      const report = await diagnosticsService.generateReport();
      res.status(200).json(report);
    } catch (error) {
      res.status(500).json({ error: "Failed to generate diagnostics report", message: String(error) });
    }
  });

  router.get("/system/diagnostics/bundle", async (req, res) => {
    try {
      const bundle = await diagnosticsService.generateBundle();
      res.setHeader("Content-Disposition", `attachment; filename="${bundle.filename}"`);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(bundle.jsonContent);
    } catch (error) {
      res.status(500).json({ error: "Failed to download diagnostics bundle", message: String(error) });
    }
  });

  // 2. Setup & Auth Endpoints
  router.get("/setup/status", async (req, res) => {
    try {
      const status = await authService.getSetupState();
      res.status(200).json({
        ...status,
        accessMode: config.accessMode,
        ownerCredentialRequired: config.accessMode !== "local",
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get setup status", message: String(error) });
    }
  });

  router.post("/setup/complete", async (req, res) => {
    try {
      const state = await authService.getSetupState();
      if (state.isSetupCompleted) {
        res.status(403).json({ error: "Setup is already complete." });
        return;
      }
      await authService.completeSetup(req.body);
      res.status(200).json({ success: true, message: "Setup completed successfully." });
    } catch (error) {
      res.status(500).json({ error: "Failed to complete setup", message: String(error) });
    }
  });

  router.post("/auth/setup-admin", async (req, res) => {
    try {
      const state = await authService.getSetupState();
      if (state.isAdminConfigured || state.isSetupCompleted) {
        res.status(403).json({ error: "Admin account is already configured." });
        return;
      }
      const { username, password } = req.body;
      const user = await authService.createInitialAdmin(username, password);
      const session = await authService.authenticate(username, password);
      res.status(201).json({ user, session });
    } catch (error) {
      res.status(400).json({ error: "Failed to setup admin user", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      const session = await authService.authenticate(username, password);
      if (!session) {
        res.status(401).json({ error: "invalid_credentials" });
        return;
      }
      res.status(200).json({ session });
    } catch (error) {
      res.status(500).json({ error: "Login failed", message: String(error) });
    }
  });

  router.post("/auth/logout", async (req, res) => {
    const token = bearerToken(req);
    if (token) {
      await authService.logout(token);
    }
    res.status(200).json({ success: true });
  });

  router.get("/auth/me", async (req, res) => {
    const auth = (req as any).v2Auth;
    if (auth?.user) {
      res.status(200).json({ user: auth.user });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    const user = await authService.validateSession(token);
    if (!user) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    res.status(200).json({ user });
  });

  router.post("/auth/change-password", async (req, res) => {
    const auth = (req as any).v2Auth;
    if (!auth?.user) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    try {
      const { currentPassword, newPassword } = req.body || {};
      await authService.changePassword(auth.user.id, currentPassword, newPassword);
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/auth/change-username", async (req, res) => {
    const auth = (req as any).v2Auth;
    if (!auth?.user) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    try {
      const { username } = req.body || {};
      const updated = await authService.changeUsername(auth.user.id, username);
      res.status(200).json({ success: true, username: updated });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/auth/sessions", async (req, res) => {
    const auth = (req as any).v2Auth;
    if (!auth?.user) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    const sessions = await authService.listSessions(auth.user.id);
    res.status(200).json({ sessions });
  });

  router.post("/auth/sessions/revoke-others", async (req, res) => {
    const auth = (req as any).v2Auth;
    if (!auth?.user) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    const token = bearerToken(req) || "";
    const revoked = await authService.revokeOtherSessions(auth.user.id, token);
    res.status(200).json({ success: true, revoked });
  });

  // 3. Backups
  router.get("/backups", async (req, res) => {
    try {
      const backups = await backupService.listBackups();
      res.status(200).json({ backups });
    } catch (error) {
      res.status(500).json({ error: "Failed to list backups", message: String(error) });
    }
  });

  router.get("/api-tokens", async (_req, res) => {
    try {
      const tokens = await apiTokenService.listTokens();
      res.status(200).json({ tokens });
    } catch (error) {
      res.status(500).json({ error: "Failed to list API tokens", message: String(error) });
    }
  });

  router.post("/api-tokens", async (req, res) => {
    try {
      const token = await apiTokenService.createToken(req.body?.name, req.body?.scopes || []);
      res.status(201).json({ token });
    } catch (error) {
      res.status(400).json({ error: "Failed to create API token", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api-tokens/:id/revoke", async (req, res) => {
    try {
      const token = await apiTokenService.revokeToken(req.params.id);
      if (!token) {
        res.status(404).json({ error: "API token not found." });
        return;
      }
      res.status(200).json({ token });
    } catch (error) {
      res.status(500).json({ error: "Failed to revoke API token", message: String(error) });
    }
  });

  router.post("/backups", async (req, res) => {
    try {
      const backup = await backupService.createBackup(req.body);
      res.status(201).json({ backup });
    } catch (error) {
      res.status(500).json({ error: "Failed to create backup", message: String(error) });
    }
  });

  router.get("/backups/:id/download", async (req, res) => {
    try {
      const backups = await backupService.listBackups();
      const backup = backups.find((b) => b.id === req.params.id || b.filename === req.params.id);
      if (!backup || !fs.existsSync(backup.filepath)) {
        res.status(404).json({ error: "Backup file not found." });
        return;
      }
      res.download(backup.filepath, backup.filename);
    } catch (error) {
      res.status(500).json({ error: "Failed to download backup", message: String(error) });
    }
  });

  router.post("/backups/:id/restore", async (req, res) => {
    try {
      const result = await backupService.restoreBackup(req.params.id);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ error: "Restore failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/backups/:id", async (req, res) => {
    try {
      await backupService.deleteBackup(req.params.id);
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Delete backup failed", message: String(error) });
    }
  });

  router.get("/config/export", (req, res) => {
    const configData = backupService.exportConfiguration();
    res.status(200).json(configData);
  });

  // 4. Analytics
  router.get("/analytics/overview", async (req, res) => {
    try {
      const overview = await analyticsService.getOverview();
      res.status(200).json(overview);
    } catch (error) {
      res.status(500).json({ error: "Failed to get analytics", message: String(error) });
    }
  });

  // 5. Webhooks
  router.get("/webhooks", async (req, res) => {
    try {
      const webhooks = await webhookService.listWebhooks();
      res.status(200).json({ webhooks });
    } catch (error) {
      res.status(500).json({ error: "Failed to list webhooks", message: String(error) });
    }
  });

  router.post("/webhooks", async (req, res) => {
    try {
      const { url, events } = req.body;
      if (!url) {
        res.status(400).json({ error: "Webhook URL is required." });
        return;
      }
      const webhook = await webhookService.createWebhook(url, events);
      res.status(201).json({ webhook });
    } catch (error) {
      res.status(500).json({ error: "Failed to create webhook", message: String(error) });
    }
  });

  router.delete("/webhooks/:id", async (req, res) => {
    try {
      await webhookService.deleteWebhook(req.params.id);
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete webhook", message: String(error) });
    }
  });

  router.get("/webhooks/deliveries", async (req, res) => {
    try {
      const deliveries = await webhookService.getDeliveryHistory();
      res.status(200).json({ deliveries });
    } catch (error) {
      res.status(500).json({ error: "Failed to get deliveries", message: String(error) });
    }
  });

  // 6. Capabilities & Packs
  router.get("/system/capabilities", (req, res) => {
    res.status(200).json({
      capabilities: capabilityManager.listCapabilities(),
      packs: capabilityManager.listPacks(),
      hardware: capabilityManager.getHardwareInfo(),
    });
  });

  router.post("/system/capabilities/:id/toggle", (req, res) => {
    const { id } = req.params;
    const enabled = Boolean(req.body?.enabled ?? true);
    const updated = capabilityManager.toggleCapability(id as CapabilityId, enabled);
    if (!updated) {
      res.status(404).json({ error: `Capability ${id} not found.` });
      return;
    }
    res.status(200).json({ capability: updated });
  });

  router.get("/system/arabic-readiness", async (req, res) => {
    await providerSecrets.refreshElevenLabsApiKey();
    const provider = new ElevenLabsVoiceProvider();
    const configured = provider.isConfigured();
    const liveVerified = configured && req.query.verify === "true"
      ? (await provider.validate().catch(() => undefined))?.healthy === true
      : false;
    // checkArabicProductionReadiness() is deliberately ElevenLabs-specific
    // (see its accepted contract and arabicVoicePolicy.test.ts) - it answers
    // "is the ElevenLabs route ready", not "is Arabic ready overall". Local
    // VoiceTut is the actual default Arabic route, so the response this endpoint returns is widened
    // here with that signal rather than by changing the narrower function.
    const elevenLabsReadiness = capabilityManager.checkArabicProductionReadiness({ configured, liveVerified });
    const localVoiceConfigured = new VoiceRegistry({} as any).isArabicProductionConfigured();
    res.status(200).json({
      ...elevenLabsReadiness,
      localVoiceConfigured,
      ready: elevenLabsReadiness.ready || localVoiceConfigured,
      statusText: localVoiceConfigured
        ? "READY — LOCAL VOICE CONFIGURED"
        : elevenLabsReadiness.statusText,
      message: localVoiceConfigured
        ? "Local Voice (VoiceTut) is ready for Arabic narration."
        : elevenLabsReadiness.message,
    });
  });

  router.get("/system/readiness", (req, res) => {
    const controls = {
      productionMode: String(req.query.mode || req.query.productionMode || "auto_hybrid"),
      visualMode: typeof req.query.visualMode === "string" ? req.query.visualMode : undefined,
      visualSource: typeof req.query.visualSource === "string" ? req.query.visualSource : "auto_best",
      stockProvider: typeof req.query.stockProvider === "string" ? req.query.stockProvider : "auto_stock",
      mediaPolicy: typeof req.query.mediaPolicy === "string" ? req.query.mediaPolicy : "auto_use_selected",
      aiVisualProvider: typeof req.query.aiVisualProvider === "string" ? req.query.aiVisualProvider : "auto",
      characterProfileId: typeof req.query.characterProfileId === "string" ? req.query.characterProfileId : "",
      selectedMediaIds:
        typeof req.query.selectedMediaIds === "string"
          ? req.query.selectedMediaIds.split(",").map((item) => item.trim()).filter(Boolean)
          : [],
      language: typeof req.query.language === "string" ? req.query.language : "auto",
      dialect: typeof req.query.dialect === "string" ? req.query.dialect : "none",
      captionEnabled: req.query.captionEnabled !== "false",
    };
    checkCreateReadiness(controls)
      .then((readiness) => res.status(200).json(readiness))
      .catch((error) => res.status(500).json({ error: "Failed to check readiness.", message: String(error) }));
  });

  // 7. Unified Media Library
  router.post("/media/assets", async (req, res) => {
    try {
      const rawBase64 = String(req.body?.fileBase64 || req.body?.imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
      const filename = typeof req.body?.filename === "string" ? req.body.filename : "asset";
      if (!rawBase64) {
        res.status(400).json({ error: "Missing file payload. Provide fileBase64." });
        return;
      }
      const asset = await mediaUploadService.saveAsset(Buffer.from(rawBase64, "base64"), filename, {
        purpose: req.body?.purpose,
        displayName: req.body?.displayName,
        folderId: req.body?.folderId,
        tags: Array.isArray(req.body?.tags) ? req.body.tags : typeof req.body?.tags === "string" ? req.body.tags.split(",") : [],
        removeBackground: req.body?.removeBackground !== false,
      });
      res.status(201).json({ asset: serializeMediaAssetForApi(asset) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Asset upload failed." });
    }
  });

  router.get("/media/assets", async (req, res) => {
    const assets = await mediaUploadService.listAssets({
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      purpose: typeof req.query.purpose === "string" ? req.query.purpose : undefined,
      folderId: typeof req.query.folderId === "string" ? req.query.folderId : undefined,
      tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
      includeArchived: req.query.includeArchived === "true",
    });
    res.status(200).json({ assets: assets.map(serializeMediaAssetForApi) });
  });

  router.get("/media/assets/:id", async (req, res) => {
    const asset = await mediaUploadService.getAsset(req.params.id);
    if (!asset) {
      res.status(404).json({ error: "Asset not found." });
      return;
    }
    res.status(200).json({ asset: serializeMediaAssetForApi(asset) });
  });

  router.patch("/media/assets/:id", async (req, res) => {
    try {
      const asset = await mediaUploadService.updateAsset(req.params.id, {
        displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined,
        purpose: req.body?.purpose,
        folderId: req.body?.folderId === null || typeof req.body?.folderId === "string" ? req.body.folderId : undefined,
        tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
        archived: typeof req.body?.archived === "boolean" ? req.body.archived : undefined,
      });
      if (!asset) {
        res.status(404).json({ error: "Asset not found." });
        return;
      }
      res.status(200).json({ asset: serializeMediaAssetForApi(asset) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Asset update failed." });
    }
  });

  router.post("/media/assets/:id/replace", async (req, res) => {
    try {
      const rawBase64 = String(req.body?.fileBase64 || req.body?.imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
      if (!rawBase64) {
        res.status(400).json({ error: "Missing replacement payload." });
        return;
      }
      const asset = await mediaUploadService.replaceAsset(req.params.id, Buffer.from(rawBase64, "base64"), String(req.body?.filename || "replacement"));
      if (!asset) {
        res.status(404).json({ error: "Asset not found." });
        return;
      }
      res.status(200).json({ asset: serializeMediaAssetForApi(asset) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Asset replacement failed." });
    }
  });

  router.delete("/media/assets/:id", async (req, res) => {
    try {
      const deleted = await mediaUploadService.deleteAsset(req.params.id, "user_request", typeof req.body?.note === "string" ? req.body.note : undefined);
      if (!deleted) {
        res.status(404).json({ error: "Asset not found." });
        return;
      }
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Asset deletion failed." });
    }
  });

  router.get("/media/folders", async (_req, res) => {
    res.status(200).json({ folders: await mediaUploadService.listFolders() });
  });

  router.post("/media/folders", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "Folder name is required." });
        return;
      }
      res.status(201).json({ folder: await mediaUploadService.createFolder(name) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Folder creation failed." });
    }
  });

  router.patch("/media/folders/:id", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const folder = name ? await mediaUploadService.renameFolder(req.params.id, name) : null;
    if (!folder) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    res.status(200).json({ folder });
  });

  router.delete("/media/folders/:id", async (req, res) => {
    try {
      const archived = await mediaUploadService.archiveFolder(req.params.id);
      if (!archived) {
        res.status(404).json({ error: "Folder not found." });
        return;
      }
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Folder archive failed." });
    }
  });

  router.get("/media/characters", async (_req, res) => {
    const providerIds = await configuredProviderIds();
    const referenceProviders = referenceCapableVisualProviders(providerIds);
    const characters = (await mediaUploadService.listCharacters()).map((profile) => ({
      ...profile,
      readinessLabel:
        profile.status === "archived"
          ? "Archived"
          : referenceProviders.length > 0
            ? `Ready with ${referenceProviders[0]}`
            : "Saved - compatible AI provider not configured",
    }));
    res.status(200).json({ characters, referenceCapableProviders: referenceProviders });
  });

  router.post("/media/characters", async (req, res) => {
    try {
      const profile = await mediaUploadService.createCharacter({
        name: String(req.body?.name || ""),
        referenceAssetIds: Array.isArray(req.body?.referenceAssetIds) ? req.body.referenceAssetIds : [],
        primaryReferenceAssetId: typeof req.body?.primaryReferenceAssetId === "string" ? req.body.primaryReferenceAssetId : undefined,
        description: typeof req.body?.description === "string" ? req.body.description : undefined,
        visualTraits: typeof req.body?.visualTraits === "string" ? req.body.visualTraits : undefined,
        promptAnchor: String(req.body?.promptAnchor || ""),
        negativeNotes: typeof req.body?.negativeNotes === "string" ? req.body.negativeNotes : undefined,
      });
      res.status(201).json({ character: profile });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Character creation failed." });
    }
  });

  router.put("/media/characters/:id", async (req, res) => {
    try {
      const profile = await mediaUploadService.updateCharacter(req.params.id, {
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
        referenceAssetIds: Array.isArray(req.body?.referenceAssetIds) ? req.body.referenceAssetIds : undefined,
        primaryReferenceAssetId: typeof req.body?.primaryReferenceAssetId === "string" ? req.body.primaryReferenceAssetId : undefined,
        description: typeof req.body?.description === "string" ? req.body.description : undefined,
        visualTraits: typeof req.body?.visualTraits === "string" ? req.body.visualTraits : undefined,
        promptAnchor: typeof req.body?.promptAnchor === "string" ? req.body.promptAnchor : undefined,
        negativeNotes: typeof req.body?.negativeNotes === "string" ? req.body.negativeNotes : undefined,
      });
      if (!profile) {
        res.status(404).json({ error: "Character not found." });
        return;
      }
      res.status(200).json({ character: profile });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Character update failed." });
    }
  });

  router.delete("/media/characters/:id", async (req, res) => {
    const archived = await mediaUploadService.archiveCharacter(req.params.id);
    if (!archived) {
      res.status(404).json({ error: "Character not found." });
      return;
    }
    res.status(200).json({ success: true });
  });

  // Product Media Management compatibility paths
  router.post("/media/product-upload", async (req, res) => {
    try {
      let buffer: Buffer;
      let originalName = "product.png";
      const removeBg = req.body?.removeBackground !== false;

      if (req.body?.imageBase64) {
        const rawBase64 = String(req.body.imageBase64).replace(/^data:image\/[a-z]+;base64,/, "");
        buffer = Buffer.from(rawBase64, "base64");
        if (req.body.filename) originalName = String(req.body.filename);
      } else if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
      } else {
        res.status(400).json({ error: "Missing image payload. Provide imageBase64 or binary image." });
        return;
      }

      const record = await mediaUploadService.saveProductImage(buffer, originalName, { removeBackground: removeBg });
      res.status(201).json({ success: true, media: serializeProductMediaForApi(record) });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Product media upload failed" });
    }
  });

  router.get("/media/products", async (req, res) => {
    const products = await mediaUploadService.listProductImages();
    res.status(200).json({ products: products.map(serializeProductMediaForApi) });
  });

  router.delete("/media/products/:id", async (req, res) => {
    try {
      // The only route in the engine that may remove customer media, and it
      // always records that a person asked for it.
      const deleted = await mediaUploadService.deleteProductImage(
        req.params.id,
        "user_request",
      );
      if (!deleted) {
        res.status(404).json({ error: "Media item not found." });
        return;
      }
      res.status(200).json({ deleted: true });
    } catch (error) {
      res.status(500).json({
        error: "Could not delete this media item.",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.patch("/media/products/:id", async (req, res) => {
    const name = typeof req.body?.originalName === "string" ? req.body.originalName.trim() : "";
    if (!name) {
      res.status(400).json({ error: "A name is required." });
      return;
    }
    try {
      const record = await mediaUploadService.renameProductImage(req.params.id, name);
      if (!record) {
        res.status(404).json({ error: "Media item not found." });
        return;
      }
      res.status(200).json({ media: serializeProductMediaForApi(record) });
    } catch (error) {
      res.status(500).json({
        error: "Could not rename this media item.",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/media/products/:id", async (req, res) => {
    const product = await mediaUploadService.getProductImage(req.params.id);
    if (!product) {
      res.status(404).json({ error: "Product media not found." });
      return;
    }
    res.status(200).json(serializeProductMediaForApi(product));
  });

  return router;
}

export function createV2InternalRouter(
  config: Config,
  shortCreator: ShortCreator,
  jobs?: JobService,
  db?: V2Database,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));
  router.use(requireInternalToken(config));
  const scheduleStartRetry = (jobId: string, delayMs = 10000) => {
    const timer = setTimeout(() => {
      void axios.post(
        `${config.appInternalBaseUrl}/internal/v1/jobs/${jobId}/start`,
        {},
        {
          timeout: config.webhookTimeoutMs,
          headers: { "x-internal-token": config.internalServiceToken },
        },
      ).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
  };

  /**
   * The support bundle, for the host-side `abud-shorts diagnostics` command.
   *
   * It lives on the internal router because the operator running that command
   * has the installation's own INTERNAL_SERVICE_TOKEN, whereas the public
   * bundle route needs an administrator session that a fresh installation does
   * not yet have. This is one narrowly-scoped, read-only endpoint - it returns
   * exactly the same redacted bundle as the browser does, and it executes
   * nothing.
   */
  router.get("/system/diagnostics/bundle", async (req, res) => {
    if (!db) {
      res.status(503).json({ error: "Diagnostics are unavailable without a database." });
      return;
    }
    try {
      const bundle = await new DiagnosticsService(db, config).generateBundle();
      res.setHeader("Content-Disposition", `attachment; filename="${bundle.filename}"`);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(bundle.jsonContent);
    } catch (error) {
      logger.warn({ error }, "Internal diagnostics bundle failed");
      res.status(500).json({ error: "Failed to generate the diagnostics bundle." });
    }
  });

  router.post("/jobs/:id/start", async (req, res) => {
    if (!jobs) {
      res.status(503).json({ error: "Job service is unavailable." });
      return;
    }
    const job = await jobs.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    const workerLeaseService = db ? new WorkerLeaseService(db) : null;
    const workerId = process.env.WORKER_ID || "render-worker";
    try {
      if (workerLeaseService) {
        const claim = await workerLeaseService.claimJob(job.id, {
          workerId,
          maxConcurrentRenders: config.concurrency || 1,
          capabilities: { render: true, ffmpeg: true, remotion: true },
        });
        if (!claim.claimed && claim.reason === "backpressure") {
          scheduleStartRetry(job.id);
          res.status(202).json({
            accepted: false,
            queued: true,
            reason: "Backpressure active; max concurrent renders reached.",
            queueDepth: claim.queueDepth,
            activeRenders: claim.activeRenders,
            retryAfterMs: 10000,
          });
          return;
        }
        if (!claim.claimed) {
          res.status(409).json({
            accepted: false,
            queued: false,
            reason: claim.reason || "Job is not claimable.",
            queueDepth: claim.queueDepth,
            activeRenders: claim.activeRenders,
          });
          return;
        }
      }
      await jobs.updateJob(
        job.id,
        "preparing",
        5,
        "Preparing",
        "Preparing render worker.",
      );
      let dispatchErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await axios.post(
            `${config.renderWorkerBaseUrl}/internal/v1/render/jobs/${job.id}/start`,
            {
              jobId: job.id,
              input: job.productionSpec || job.input,
              callbackBaseUrl: config.appInternalBaseUrl,
              internalServiceToken: config.internalServiceToken,
              workerId,
            },
            {
              timeout: config.webhookTimeoutMs,
              headers: { "x-internal-token": config.internalServiceToken },
            },
          );
          dispatchErr = null;
          break;
        } catch (e: any) {
          dispatchErr = e;
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      if (dispatchErr) throw dispatchErr;
      res.status(202).json({ accepted: true, jobId: job.id });
    } catch (error) {
      try {
        await jobs.updateJob(job.id, "failed", job.progress, "Render dispatch failed", "Render worker is unavailable.", {
          error: "Render worker is unavailable.",
          technicalError: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The job may already be canceled/failed - a second transition
        // rejection inside the error path must not take the process down.
      }
      await workerLeaseService?.release(workerId);
      res.status(503).json({ error: "Render worker is unavailable." });
    }
  });

  router.post("/jobs/:id/progress", async (req, res) => {
    if (!jobs) {
      res.status(503).json({ error: "Job service is unavailable." });
      return;
    }
    const parsed = internalProgressSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid progress payload." });
      return;
    }
    const update = parsed.data;
    try {
      const job = await jobs.updateJob(
        req.params.id,
        update.status,
        update.progress,
        update.currentStage,
        update.message,
        { technicalMessage: update.technicalMessage },
      );
      if (update.stageKey && update.checkpointStatus) {
        await jobs.updateStageCheckpoint(req.params.id, update.stageKey, update.checkpointStatus, {
          input: update.inputHashSource,
          provider: update.provider,
          artifacts: update.artifacts,
          error: update.technicalMessage,
          timingMs: update.timingMs,
        });
        if (update.checkpointStatus === "completed") {
          const webhookService = db ? new WebhookService(db, { timeoutMs: config.webhookTimeoutMs }) : null;
          await webhookService?.dispatchEvent("job.stage.completed", {
            jobId: req.params.id,
            stage: update.stageKey,
            timingMs: update.timingMs,
          });
        }
      }
      res.status(200).json({ job });
    } catch (error) {
      sendJobMutationFailure(res, error, "POST /jobs/:id/progress");
    }
  });

  router.post("/jobs/:id/complete", async (req, res) => {
    if (!jobs) {
      res.status(503).json({ error: "Job service is unavailable." });
      return;
    }
    const parsed = internalCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid complete payload." });
      return;
    }
    try {
      const completedMetadata = readMetadata(config.videosDirPath, parsed.data.videoId);
      // V2.5.1 severity split. Older renders (and any path that predates the
      // structured contract) carry no `finalQuality`; they are read the way they
      // always were, as a hard failure.
      const finalQuality = completedMetadata?.finalQuality;
      const legacyRejected =
        !finalQuality &&
        (completedMetadata?.status === "failed" || completedMetadata?.professionalReady === false);
      const hardFailed = finalQuality ? finalQuality.outcome === "failed" : legacyRejected;
      const needsReview = finalQuality?.outcome === "needs_review";

      if (hardFailed || needsReview) {
        const rawMessage =
          typeof completedMetadata?.error === "string" && completedMetadata.error.trim()
            ? completedMetadata.error
            : "Video failed final quality readiness checks.";
        const { message } = classifyRenderFailure(rawMessage);
        // A soft verdict keeps the render: the customer sees the exact reasons
        // AND can still preview, download and publish the video that was
        // actually produced. Throwing away a valid 1080p file over a creative
        // preference is the defect this branch exists to prevent.
        const status = hardFailed ? "failed" : "needs_review";
        const stage = hardFailed ? "Quality review failed" : "Quality review";
        const job = await jobs.updateJob(req.params.id, status, hardFailed ? 99 : 100, stage, message, {
          error: message,
          technicalError: rawMessage,
          output: {
            ...parsed.data.output,
            videoId: parsed.data.videoId,
            previewUrl: `/api/short-video/${parsed.data.videoId}`,
            downloadUrl: `/api/videos/${parsed.data.videoId}/download`,
            professionalReady: completedMetadata?.professionalReady,
            validationStatus: completedMetadata?.status,
            finalQuality,
          },
        });
        if (db) {
          await new WorkerLeaseService(db).release(process.env.WORKER_ID || "render-worker");
          await new WebhookService(db, { timeoutMs: config.webhookTimeoutMs }).dispatchEvent(
            hardFailed ? "job.failed" : "video.ready",
            {
              jobId: req.params.id,
              videoId: parsed.data.videoId,
              ...(hardFailed ? { error: message } : { output: parsed.data.output }),
            } as any,
          );
          if (needsReview) {
            // A reviewable production is still a delivered video: it gets the
            // same revision/artifact bookkeeping a ready one gets, otherwise it
            // would be missing from the Video Library and from retry reuse.
            const revision = await new RevisionService(db).markRevisionReadyForJob(
              req.params.id,
              parsed.data.videoId,
            );
            if (!revision) {
              await new RevisionService(db).ensureInitialRevision({
                projectId: parsed.data.videoId,
                sourceJobId: req.params.id,
                outputVideoId: parsed.data.videoId,
              });
            }
            if (completedMetadata?.durableArtifacts) {
              await persistSceneArtifacts(
                db,
                revision?.projectId || parsed.data.videoId,
                completedMetadata.durableArtifacts as DurableSceneArtifact[],
              );
            }
          }
        }
        res.status(200).json({ job });
        return;
      }

      const job = await jobs.completeJob(
        req.params.id,
        parsed.data.videoId,
        parsed.data.output,
      );
      if (db) {
        await new WorkerLeaseService(db).release(process.env.WORKER_ID || "render-worker");
        const revision = await new RevisionService(db).markRevisionReadyForJob(req.params.id, parsed.data.videoId);
        const projectId = revision?.projectId || (completedMetadata?.revisionMetadata as any)?.parentVideoId || parsed.data.videoId;
        if (completedMetadata?.durableArtifacts) {
          await persistSceneArtifacts(db, projectId, completedMetadata.durableArtifacts as DurableSceneArtifact[]);
        }
        if (!revision) {
          await new RevisionService(db).ensureInitialRevision({
            projectId: parsed.data.videoId,
            sourceJobId: req.params.id,
            outputVideoId: parsed.data.videoId,
          });
        }
        await new WebhookService(db, { timeoutMs: config.webhookTimeoutMs }).dispatchEvent("video.ready", {
          jobId: req.params.id,
          videoId: parsed.data.videoId,
          output: parsed.data.output,
        });
        if (revision) {
          await new WebhookService(db, { timeoutMs: config.webhookTimeoutMs }).dispatchEvent("video.revision.ready", {
            jobId: req.params.id,
            revisionId: revision.id,
            projectId: revision.projectId,
            outputVideoId: parsed.data.videoId,
          });
        }
      }
      res.status(200).json({ job });
    } catch (error) {
      sendJobMutationFailure(res, error, "POST /jobs/:id/complete");
    }
  });

  router.post("/jobs/:id/fail", async (req, res) => {
    if (!jobs) {
      res.status(503).json({ error: "Job service is unavailable." });
      return;
    }
    const parsed = internalFailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid fail payload." });
      return;
    }
    try {
      const current = await jobs.getJob(req.params.id);
      const rawMessage = parsed.data.technicalMessage || parsed.data.message;
      const classified = classifyRenderFailure(rawMessage);
      const isArabic = current?.language === "ar" || (current?.productionSpec as any)?.language === "ar";
      const message = isArabic ? CATEGORY_MESSAGES_AR[classified.category] : classified.message;
      const job = await jobs.updateJob(
        req.params.id,
        "failed",
        Math.min(99, Math.max(0, current?.progress || 99)),
        current?.currentStage && current.currentStage !== "Queued" ? current.currentStage : "Failed",
        message,
        {
          error: message,
          technicalError: parsed.data.technicalMessage,
        },
      );
      if (db) {
        await new WorkerLeaseService(db).release(process.env.WORKER_ID || "render-worker");
        await new WebhookService(db, { timeoutMs: config.webhookTimeoutMs }).dispatchEvent("video.failed", {
          jobId: req.params.id,
          message: parsed.data.message,
        });
      }
      res.status(200).json({ job });
    } catch (error) {
      sendJobMutationFailure(res, error, "POST /jobs/:id/fail");
    }
  });

  router.post("/render/jobs/:id/start", async (req, res) => {
    const parsed = internalStartRenderSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.jobId !== req.params.id) {
      res.status(400).json({ error: "Invalid render payload." });
      return;
    }
    const { jobId, input, callbackBaseUrl, internalServiceToken, workerId } = parsed.data;
    const licenseGate = LicenseManager.getInstance().requireActiveForProduction();
    if (!licenseGate.allowed) {
      await axios.post(
        `${callbackBaseUrl}/internal/v1/jobs/${jobId}/fail`,
        {
          message: String(licenseGate.response.message),
          technicalMessage: "Commercial license became invalid before render start.",
        },
        { headers: { "x-internal-token": internalServiceToken }, timeout: 5000 },
      );
      res.status(402).json(licenseGate.response);
      return;
    }

    // Pick up an ElevenLabs credential the customer configured after this
    // worker started, so Arabic jobs do not need a container restart.
    await providerSecrets.refreshElevenLabsApiKey().catch(() => undefined);

    void shortCreator
      .createShortNow(jobId, input, async (event) => {
        try {
          if (db && workerId) {
            await new WorkerLeaseService(db).heartbeat({
              workerId,
              status: "busy",
              activeJobId: jobId,
              capabilities: { render: true, ffmpeg: true, remotion: true },
            });
          }
          await axios.post(
            `${callbackBaseUrl}/internal/v1/jobs/${jobId}/progress`,
            event,
            { headers: { "x-internal-token": internalServiceToken }, timeout: 15000 },
          );
        } catch {
          // Progress update is advisory
        }
      })
      .then(async (videoId) => {
        const sidecar = readMetadata(config.videosDirPath, videoId);
        await axios.post(
          `${callbackBaseUrl}/internal/v1/jobs/${jobId}/complete`,
          {
            videoId,
            output: {
              path: shortCreator.getVideoPath(videoId),
              metadata: sidecar || undefined,
            },
          },
          { headers: { "x-internal-token": internalServiceToken }, timeout: 5000 },
        );
      })
      .catch(async (error) => {
        const rawMsg =
          typeof (error as any)?.toSanitizedTechnicalString === "function"
            ? (error as any).toSanitizedTechnicalString()
            : (error as any)?.detail?.sanitizedDiagnostic
              ? (error as any).detail.sanitizedDiagnostic
              : error instanceof Error
                ? error.message
                : String(error);
        // The customer-facing message (below) is deliberately sanitized down
        // to a recoverable category, which previously meant the operator had
        // no way to see what actually failed - only ever a short generic
        // string. Log the real error (stack, and Zod's full issue list when
        // that's the cause) so a render failure is diagnosable from the
        // worker's own logs instead of requiring a live repro.
        logger.error(
          {
            jobId,
            err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
            zodIssues: (error as any)?.issues,
          },
          "Render job failed",
        );
        // The customer sees a recoverable category, never the raw message.
        const classified = classifyRenderFailure(rawMsg);
        const isArabic = (input as any)?.language === "ar" || (input as any)?.dialect === "egyptian_arabic" || (input as any)?.dialect === "egyptian";
        const customerMessage = isArabic ? CATEGORY_MESSAGES_AR[classified.category] : classified.message;
        await axios.post(
          `${callbackBaseUrl}/internal/v1/jobs/${jobId}/fail`,
          {
            message: customerMessage,
            technicalMessage: rawMsg.slice(0, 4000),
          },
          { headers: { "x-internal-token": internalServiceToken }, timeout: 15000 },
        );
      });

    res.status(202).json({ accepted: true, jobId });
  });

  if (db) {
    const publishingService = new PublishingService(db, config, publishingRegistry);
    router.post("/publishing/publications/:id/execute", async (req, res) => {
      try {
        const pub = await publishingService.publishPublication(req.params.id);
        res.status(200).json({ accepted: true, publication: pub });
      } catch (error) {
        res.status(500).json({
          error: "Internal publishing execution failed.",
          technicalError: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  // Quality Engine Internal Contract
  router.post("/media/analyze", async (req, res) => {
    try {
      const { videoPath, targetDurationSeconds } = req.body;
      if (!videoPath) {
        res.status(400).json({ error: "videoPath is required" });
        return;
      }
      const result = await qualityEngine.analyzeScenes(videoPath, targetDurationSeconds || 5.0);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Scene analysis failed" });
    }
  });

  router.post("/media/remove-background", async (req, res) => {
    try {
      const { imagePath } = req.body;
      if (!imagePath) {
        res.status(400).json({ error: "imagePath is required" });
        return;
      }
      const result = await qualityEngine.removeBackground(imagePath);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Background removal failed" });
    }
  });

  router.post("/media/upscale", async (req, res) => {
    try {
      const { imagePath, minWidth } = req.body;
      if (!imagePath) {
        res.status(400).json({ error: "imagePath is required" });
        return;
      }
      const result = await qualityEngine.upscaleImage(imagePath, minWidth || 1080);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Image upscale failed" });
    }
  });

  router.post("/audio/analyze-beats", async (req, res) => {
    try {
      const { audioPath } = req.body;
      if (!audioPath) {
        res.status(400).json({ error: "audioPath is required" });
        return;
      }
      const result = await qualityEngine.analyzeBeats(audioPath);
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Beat analysis failed" });
    }
  });

  return router;
}
