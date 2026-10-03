import cuid from "cuid";
import { z } from "zod";
import {
  type ArabicDialect,
  type ProductionSceneSpec,
  type ProductionSpec,
  type ScenePurpose,
  validateContentQuality,
  validateProductionSpec,
} from "../../../types/productionSpec";
import type { GenerateSpecParams } from "./types";
import type { PromptIntentContract } from "./promptIntentContract";
import { buildPromptIntentContract, stripMetaInstructions } from "./promptIntentContract";
import { inventsUngroundedClaim, resolveCtaProvenance } from "../creative/ctaPolicy";
import { containsRawPromptLeak } from "../quality/professionalVisualQuality";
import { enforceAndRepairPromptFidelity } from "../quality/promptFidelityGate";
import { estimateSpeechSeconds, getSpeakingRate } from "./voiceSpeakingRate";
import { buildContentDurationBudget, checkContentDurationFeasibility } from "./scriptDurationController";
import {
  analyzeNarrationLanguage,
  buildLanguageQualityReport,
} from "./languageQualityGuard";

/**
 * The compact plan the creative model is asked for. It is deliberately small:
 * the model writes copy and visual intent; every structural/timing/routing
 * field of the real ProductionSpec is assembled deterministically afterwards.
 * A full-spec round-trip previously produced multi-KB responses that routinely
 * outran the API request timeout and silently discarded the LLM's work.
 */
export const creativePlanSceneSchema = z.object({
  purpose: z.string().trim().max(24).optional(),
  narration: z.string().trim().min(1).max(400),
  onScreenText: z.string().trim().max(80).optional(),
  visualIntent: z.string().trim().max(200).optional(),
  searchQueries: z.array(z.string().trim().min(2).max(80)).max(8).optional(),
  treatmentHint: z.string().trim().max(40).optional(),
});

export const creativePlanSchema = z.object({
  title: z.string().trim().max(140).optional(),
  tone: z.string().trim().max(80).optional(),
  scenes: z.array(creativePlanSceneSchema).min(1).max(8),
  cta: z.string().trim().max(160).optional(),
  expansionLines: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
});

export type CreativePlanScene = z.infer<typeof creativePlanSceneSchema>;
export type CreativePlan = z.infer<typeof creativePlanSchema>;

const KNOWN_PURPOSES = ["hook", "problem", "solution", "benefit", "proof", "cta"] as const;

function coerceStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const parts = value.split(/[\n;,،؛]+/).map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item.trim() : String(item ?? "").trim()))
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

/**
 * Schema repair for the creative plan. Small instruct models frequently
 * return the right content in a slightly wrong shape - purpose as a
 * descriptive phrase instead of the enum word, a string where an array was
 * asked for, verbose Arabic field phrasing. Repairing those surface
 * deviations is exactly the "schema repair" step; content itself is still
 * validated downstream, never trusted.
 */
/** Truncate at a word boundary so a sliced field never ends mid-token. */
function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? sliced.slice(0, lastSpace) : sliced).trim();
}

export function coercePlanShape(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  if (typeof out.cta === "string") out.cta = truncateAtWord(out.cta, 160);
  if (typeof out.title === "string") out.title = truncateAtWord(out.title, 140);
  if (typeof out.tone === "string") out.tone = truncateAtWord(out.tone, 80);
  if (typeof out.expansionLines !== "undefined") {
    out.expansionLines = (coerceStringList(out.expansionLines) || []).map((l) => truncateAtWord(l, 300)).slice(0, 8);
  }

  const scenesIn = Array.isArray(out.scenes) ? out.scenes : [];
  out.scenes = scenesIn.map((scene, index) => {
    if (!scene || typeof scene !== "object") return scene;
    const s = { ...(scene as Record<string, unknown>) };
    // purpose: normalize "Hook - grab attention" / "الهوك" / "cta scene" to
    // the enum by scanning for a known word, then truncate.
    const rawPurpose = typeof s.purpose === "string" ? s.purpose.toLowerCase() : "";
    const match = KNOWN_PURPOSES.find((p) => new RegExp(`\\b${p}\\b`).test(rawPurpose));
    if (match) {
      s.purpose = match;
    } else if (/هوك|افتتاح|بداية|انتباه/.test(rawPurpose)) {
      s.purpose = "hook";
    } else if (/ختام|دعوة|خاتمة/.test(rawPurpose) || index === scenesIn.length - 1) {
      s.purpose = "cta";
    } else {
      s.purpose = "solution";
    }
    const coercedQueries = coerceStringList(s.searchQueries);
    s.searchQueries = coercedQueries === undefined
      ? undefined
      : coercedQueries.map((q) => truncateAtWord(q, 80)).filter((q) => q.length >= 2).slice(0, 8);
    for (const key of ["title", "tone", "narration", "onScreenText", "visualIntent", "treatmentHint"]) {
      if (s[key] !== undefined && typeof s[key] !== "string") s[key] = String(s[key]);
    }
    // Over-limit strings are cosmetic model verbosity - truncate at a word
    // boundary rather than fail the whole plan on a Zod max() error.
    if (typeof s.narration === "string") s.narration = truncateAtWord(s.narration, 400);
    if (typeof s.onScreenText === "string") s.onScreenText = truncateAtWord(s.onScreenText, 80);
    if (typeof s.visualIntent === "string") s.visualIntent = truncateAtWord(s.visualIntent, 200);
    if (typeof s.treatmentHint === "string") s.treatmentHint = truncateAtWord(s.treatmentHint, 40);
    return s;
  });

  return out;
}

const PURPOSE_SET = new Set(["hook", "problem", "solution", "benefit", "proof", "cta"]);

function normalizePurpose(value: string | undefined, index: number, total: number): ScenePurpose {
  const normalized = (value || "").toLowerCase().trim();
  if (PURPOSE_SET.has(normalized)) return normalized as ScenePurpose;
  if (index === 0) return "hook";
  if (index === total - 1) return "cta";
  return "solution";
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[«»"'“”‘’().,،;؛:：!؟?\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ngrams(text: string, n: number): Set<string> {
  const words = normalizeText(text).split(" ").filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

/**
 * Regression invariant (Part F): generated narration must be newly written
 * speech, not the customer's brief read back. A shared 4+-word run between
 * prompt and narration that is not an explicitly quoted phrase or a named
 * entity marks the line as prompt leakage and the field is rejected.
 */
export function promptNarrationOverlap(prompt: string, narration: string, quotedPhrases: string[] = []): boolean {
  const promptGrams = ngrams(prompt, 4);
  if (promptGrams.size === 0) return false;
  const allowed = new Set<string>();
  for (const q of quotedPhrases) {
    for (const g of ngrams(q, 4)) allowed.add(g);
  }
  for (const g of ngrams(narration, 4)) {
    if (promptGrams.has(g) && !allowed.has(g)) return true;
  }
  return false;
}

/** Field-level safety gate shared by the LLM path and the Basic fallback. A
 *  field that invents a claim, leaks prompt text, or violates a negative
 *  constraint is replaced by `safeFallback`, not silently kept. */
export function safeCopy(
  value: string | undefined,
  prompt: string,
  contract: PromptIntentContract,
  safeFallback: string | undefined,
): string | undefined {
  if (!value || !value.trim()) return safeFallback;
  // forNarration: orchestration wording is stripped, but real negations are
  // kept - stripping "no"/"بدون" from spoken copy inverts its meaning.
  const text = stripMetaInstructions(value.trim(), contract.language === "ar", { forNarration: true });
  if (!text) return safeFallback;
  const unsafe =
    inventsUngroundedClaim(text, prompt) ||
    containsRawPromptLeak(prompt, text) ||
    promptNarrationOverlap(prompt, text, contract.quotedPhrases);
  return unsafe ? safeFallback : text;
}

export type PlannerMeta = {
  planner: string;
  plannerModel?: string;
  plannerLatencyMs?: number;
  plannerRetries?: number;
  fallbackUsed: boolean;
  fallbackReason?: string;
  contentProvenance: "MODEL_GENERATED" | "DETERMINISTIC" | "BASIC_FALLBACK";
  contentConfidence: "high" | "low";
};

/**
 * Assemble a real ProductionSpec from a compact creative plan. Timing, scene
 * allocation, CTA provenance, and every schema/quality gate stay
 * deterministic; the plan only supplies creative copy and visual intent.
 */
export function assembleProductionSpec(params: {
  plan: CreativePlan;
  specParams: GenerateSpecParams;
  contract?: PromptIntentContract;
  meta: PlannerMeta;
}): ProductionSpec {
  const { plan, specParams, meta } = params;
  const prompt = specParams.prompt.trim();
  const isAr =
    specParams.language === "ar" ||
    (specParams.language !== "en" && /[\u0600-\u06FF]/.test(prompt));
  const dialect: ArabicDialect =
    specParams.dialect && specParams.dialect !== "none" ? specParams.dialect : isAr ? "egyptian" : "none";
  const durationSeconds =
    specParams.requestedDurationSeconds ??
    specParams.durationSeconds ??
    specParams.duration ??
    30;

  const contract =
    params.contract ||
    buildPromptIntentContract(prompt, {
      language: isAr ? "ar" : "en",
      dialect,
      durationSeconds,
      contentStyle: specParams.contentStyle as any,
    });

  const resolvedCta = resolveCtaProvenance({
    prompt,
    isArabic: isAr,
    dialect,
    brandContactText: specParams.brandKit?.contactText || undefined,
    isCuriosityStyle:
      specParams.contentStyle === "viral_curiosity" ||
      specParams.contentStyle === "educational" ||
      specParams.contentStyle === "explainer",
  });

  // --- duration allocation by real estimated speech length -------------
  const rate = getSpeakingRate(specParams.voiceProvider || "", specParams.voiceId || "", isAr ? "ar" : "en");
  const outroSeconds = Math.min(2.5, Math.max(1.5, Math.round(durationSeconds * 0.1 * 10) / 10));
  const contentBudget = Math.max(durationSeconds - outroSeconds, 5);
  const sceneEstimates = plan.scenes.map((s) => estimateSpeechSeconds(s.narration, rate));
  const totalEstimate = sceneEstimates.reduce((a, b) => a + b, 0) || 1;
  const sceneDurations = sceneEstimates.map((est) =>
    Math.max(1.5, Math.round((est / totalEstimate) * contentBudget * 10) / 10),
  );

  // --- scenes -------------------------------------------------------------
  const defaultVisualSubjects = contract.concreteVisualSubjects;
  // Purpose diversity: small models frequently repeat "hook" for every
  // scene. Keep the model's choice when it is meaningful, otherwise enforce
  // the editorial spine hook -> middle beats -> cta by position.
  const purposesSeen = plan.scenes.map((s, i) => normalizePurpose(s.purpose, i, plan.scenes.length));
  const distinct = new Set(purposesSeen).size;
  if (distinct < Math.min(3, plan.scenes.length)) {
    for (let i = 0; i < purposesSeen.length; i++) {
      purposesSeen[i] = i === 0 ? "hook" : i === purposesSeen.length - 1 ? "cta" : "solution";
    }
  }

  // Genuine supporting lines the model offered for post-TTS duration
  // correction (see scriptDurationController.decideCorrectionAction) - one
  // per scene at most, only if individually safe.
  const expansionPool = (plan.expansionLines || [])
    .map((line) => safeCopy(line, prompt, contract, undefined))
    .filter((l): l is string => Boolean(l));

  const languageResults: Array<{ sceneIndex: number; result: import("./languageQualityGuard").LanguageQualityResult }> = [];
  const scenes: ProductionSceneSpec[] = plan.scenes.map((scene, index) => {
    // A rejected line falls back to a neutral on-topic sentence - never to
    // a claim-stripped version of the rejected text (that still leaks the
    // brief), which is exactly the verbatim-prompt defect this guard exists
    // to prevent. The fallback entity is meta-stripped so duration/style
    // wording from the brief can never be spoken ("إعلاني 20 ثانية...").
    // If the remaining "entity" is only a duration/number fragment
    // ("15 ثانية") or shorter than a word, it is not a speakable topic.
    // A truncated duration fragment ("إعلاني 15") leaves a bare trailing
    // number - drop it before deciding the entity is speakable.
    const strippedEntity = stripMetaInstructions(contract.coreEntity, isAr).replace(/\s+\d+$/, "").trim();
    const entityUsable =
      strippedEntity.length >= 3 &&
      !/^\d+\s*(?:ثانية|ثواني|ثوان|ثوانى|دقيقة|دقائق|seconds?|secs?|minutes?|mins?)?\.?$/i.test(strippedEntity) &&
      // Residual orchestration wording means the entity is still a raw
      // prompt fragment, not a speakable subject.
      !/(?:^|\s)(?:فيديو|شورت|مقطع|سكريبت|إعلاني?|اعلاني?|محتوى|ثانية|ثواني?|ثوانى?|دقيقة|دقائق|video|shorts?|clip|script|seconds?|minutes?)(?:\s|$)/i.test(
        strippedEntity,
      );
    const safeEntity = entityUsable ? strippedEntity : isAr ? "الموضوع" : "the topic";
    const langResult = analyzeNarrationLanguage(
      safeCopy(scene.narration, prompt, contract, undefined) || "",
      isAr ? "ar" : "en",
    );
    languageResults.push({ sceneIndex: index, result: langResult });
    const safeNarration =
      (langResult.text && !langResult.unusable ? langResult.text : undefined) ||
      (isAr ? `النقطة المهمة عن ${safeEntity}.` : `The key point about ${safeEntity}.`);
    // Stock providers (Pexels/Pixabay) index English footage metadata only -
    // an Arabic or transliterated query silently returns irrelevant clips.
    // Non-Latin queries are dropped and replaced by the contract's
    // already-translated concrete visual subjects.
    const latinOnly = (q: string) => !/[\u0600-\u06FF]/.test(q);
    const queriesRaw = (scene.searchQueries || []).filter(
      (q) => latinOnly(q) && !inventsUngroundedClaim(q, prompt) && !contract.forbiddenStockQueries.includes(q),
    );
    const queries = queriesRaw.length > 0 ? queriesRaw : defaultVisualSubjects;
    const visualIntent = safeCopy(scene.visualIntent, prompt, contract, undefined);
    return {
      sceneIndex: index,
      purpose: purposesSeen[index],
      durationSeconds: sceneDurations[index],
      narration: safeNarration,
      onScreenText: safeCopy(scene.onScreenText, prompt, contract, undefined),
      visualIntent: visualIntent ? visualIntent.slice(0, 80) : undefined,
      visualPrompt: visualIntent,
      stockSearchTerms: queries,
      visualSource: "stock",
      treatmentHint: scene.treatmentHint,
      transition: index === 0 ? "cut" : index % 2 === 0 ? "fade" : "cut",
      narrationExpansionUnits: expansionPool[index] ? [expansionPool[index]] : undefined,
    };
  });

  // --- feasibility gate (same guard the old planner used) -----------------
  const durationBudget = buildContentDurationBudget({
    requestedVideoSeconds: durationSeconds,
    reservedOutroSeconds: outroSeconds,
    sceneEstimatedSeconds: sceneEstimates,
  });
  const feasibility = checkContentDurationFeasibility(
    scenes.map((s, i) => ({ durationSeconds: s.durationSeconds, estimatedSeconds: sceneEstimates[i] })),
    durationBudget,
    2.5,
    0.5,
  );
  if (!feasibility.feasible) {
    throw new Error(
      `CONTENT_DURATION_BUDGET_NOT_MET: ${feasibility.reason} (requested ${durationSeconds}s, narration budget ${(durationBudget.narrationBudgetMs / 1000).toFixed(1)}s, estimated narration ${(durationBudget.estimatedNarrationMs / 1000).toFixed(1)}s).`,
    );
  }

  // CTA precedence: the customer's literal or brand-resolved CTA always
  // wins; the model may only reword a SAFE_INFERRED closer.
  const safePlanCta =
    resolvedCta.provenance === "SAFE_INFERRED"
      ? safeCopy(plan.cta, prompt, contract, undefined)
      : undefined;

  const rawSpec: ProductionSpec = {
    id: cuid(),
    creationMode: "prompt",
    title:
      safeCopy(plan.title, prompt, contract, undefined) ||
      (isAr ? `إنتاج: ${contract.coreEntity}` : `Production: ${contract.coreEntity}`),
    userPrompt: prompt,
    language: isAr ? "ar" : "en",
    dialect,
    tone: safeCopy(plan.tone, prompt, contract, undefined) || (isAr ? "حماسي وجذاب" : "energetic and engaging"),
    contentStyle: specParams.contentStyle || "advertisement",
    durationSeconds,
    aspectRatio: specParams.aspectRatio || "9:16",
    resolution: specParams.resolution || "1080p",
    quality: specParams.quality || "standard",
    sceneCount: scenes.length,
    productionMode: specParams.productionMode || "auto_hybrid",
    visualMode: specParams.visualMode || "auto",
    voiceProvider: specParams.voiceProvider || "auto",
    voiceId: specParams.voiceId || "",
    captionStyle: specParams.brandKit?.captionStyle || "bold",
    brandId: specParams.brandId,
    cta: { text: safePlanCta || resolvedCta.text, action: resolvedCta.action, contact: resolvedCta.contact },
    contact: resolvedCta.contact,
    scenes,
    brandKit: specParams.brandKit,
    metadata: {
      ...meta,
      plannerVersion: "4.0.0",
      promptCompiler: {
        version: "creative_planner.v1",
        rawPromptLeakGuard: true,
        truthGuard: true,
        promptNarrationOverlapGuard: true,
        ctaProvenance: resolvedCta.provenance,
        prohibitedInventedClaims: ["prices", "discounts", "phone_numbers", "whatsapp_cta", "statistics", "testimonials", "urls"],
      },
      promptIntentContract: contract,
      languageQuality: buildLanguageQualityReport(languageResults),
      durationBudget,
    },
  };

  const { spec: fidelitySpec } = enforceAndRepairPromptFidelity(rawSpec, contract);
  const validated = validateProductionSpec(fidelitySpec);
  const qualityCheck = validateContentQuality(validated);
  return qualityCheck.correctedSpec || validated;
}
