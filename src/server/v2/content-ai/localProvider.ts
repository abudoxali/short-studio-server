import cuid from "cuid";
import {
  type ArabicDialect,
  type ProductionSceneSpec,
  type ProductionSpec,
  validateContentQuality,
  validateProductionSpec,
} from "../../../types/productionSpec";
import type {
  ContentAIProvider,
  GenerateSpecParams,
  PromptRewriteResult,
  ProviderValidationResult,
  SpecReviewResult,
} from "./types";
import {
  inventsUngroundedClaim,
  resolveCtaProvenance,
  stripInventedClaims,
  type ResolvedCta,
} from "../creative/ctaPolicy";
import { detectContentStyle } from "./contentStyleDetector";
import { extractTopicConcepts } from "./scriptQuality";
import { estimateSpeechSeconds, getSpeakingRate } from "./voiceSpeakingRate";
import {
  buildContentDurationBudget,
  checkContentDurationFeasibility,
} from "./scriptDurationController";
import { buildPromptIntentContract, stripMetaInstructions } from "./promptIntentContract";
import { enforceAndRepairPromptFidelity } from "../quality/promptFidelityGate";

function isArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function detectArabicDialect(text: string): ArabicDialect {
  const lower = text.toLowerCase();
  if (
    /عايز|عاوز|دلوقتي|كده|علشان|عشان|ازاي|جامد|مية في المية|اطلب|يلا|كافيه|شياكة|خامة|حاجة|قاهرة|مصر/.test(
      lower,
    )
  ) {
    return "egyptian";
  }
  if (/ابي|تبغى|الحين|وش|سعودي|الرياض|جدة|هلا|حي|ابشر/.test(lower)) {
    return "saudi";
  }
  if (/شلونك|وايد|الكويت|دبي|الامارات|قطر/.test(lower)) {
    return "gulf";
  }
  if (/بدي|شو|هيك|كتير|شام|بيروت|عمان|لبنان|اردن/.test(lower)) {
    return "levantine";
  }
  if (isArabic(text)) {
    return "egyptian"; // Default for Arabic market in this engine
  }
  return "none";
}

function looksLikeRawInstruction(text: string, prompt: string): boolean {
  const normalizedText = text.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedPrompt = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  return Boolean(
    normalizedText &&
    (normalizedPrompt.startsWith(normalizedText) ||
      normalizedText.startsWith("create a") ||
      normalizedText.startsWith("make a video") ||
      normalizedText.startsWith("اعمل فيديو")),
  );
}

/** Generic, claim-free search terms for a CTA shot once the canned ones (which
 * often bake in an invented channel, e.g. "whatsapp communication") have been
 * discarded. Still on-topic for a satisfied-customer/result closing shot. */
const SAFE_CTA_SEARCH_TERMS = ["happy business owner", "professional service result", "satisfied customer smiling"];

function safeStockSearchTerms(terms: string[] | undefined, prompt: string): string[] {
  if (!terms || terms.length === 0) return terms || [];
  const kept = terms.filter((term) => !inventsUngroundedClaim(term, prompt));
  if (kept.length === terms.length) return terms;
  const padded = [...kept];
  for (const fallback of SAFE_CTA_SEARCH_TERMS) {
    if (padded.length >= terms.length) break;
    if (!padded.includes(fallback)) padded.push(fallback);
  }
  return padded;
}

function enforcePromptTruthSafety(
  scenes: ProductionSceneSpec[],
  prompt: string,
  isAr: boolean,
  dialect: ArabicDialect,
  resolvedCta: ResolvedCta,
): ProductionSceneSpec[] {
  return scenes.map((scene, index) => {
    const isCtaScene = scene.purpose === "cta";
    // A canned CTA line can hinge entirely on an invented channel or offer
    // ("Message our team on WhatsApp today... claim your limited discount").
    // Patching that word-by-word produces broken grammar ("message us on
    // message today"), so when the line depends on a claim the prompt never
    // authorized, the whole line - and the visual search terms that were
    // built around the same invented claim, e.g. `visualPrompt: "...with
    // WhatsApp message ready"` or `stockSearchTerms: ["whatsapp
    // communication", ...]` - is replaced with the canonically resolved,
    // truth-safe CTA instead.
    if (
      isCtaScene &&
      (inventsUngroundedClaim(scene.narration, prompt) ||
        inventsUngroundedClaim(scene.onScreenText || "", prompt) ||
        inventsUngroundedClaim(scene.visualPrompt || "", prompt) ||
        (scene.stockSearchTerms || []).some((term) => inventsUngroundedClaim(term, prompt)))
    ) {
      return {
        ...scene,
        narration: resolvedCta.text,
        onScreenText: resolvedCta.text,
        // Not website-specific: this fallback fires for any business
        // vertical's CTA scene (food, real estate, clothing, ...), and a
        // website-themed description here previously pushed the visual
        // classifier straight to WEBSITE_MOCKUP regardless of the actual
        // business, failing the real-footage coverage gate.
        visualPrompt: inventsUngroundedClaim(scene.visualPrompt || "", prompt)
          ? "Happy satisfied customer smiling while enjoying the product in a real everyday setting"
          : scene.visualPrompt,
        stockSearchTerms: safeStockSearchTerms(scene.stockSearchTerms, prompt),
        notes: [
          scene.notes,
          index === 0 ? "raw_prompt_leak_guard_enabled" : undefined,
          "truth_safe_cta_replaced",
        ].filter(Boolean).join("; ") || scene.notes,
      };
    }

    const safeNarration = stripInventedClaims(scene.narration, prompt, isAr);
    // Also strip any residual meta/orchestration instructions from narration
    // (e.g. "Create a 15 second short about..." that survived earlier cleaning)
    const metaStrippedNarration = stripMetaInstructions(safeNarration || scene.narration, isAr, { forNarration: true });
    const safeOnScreen =
      scene.onScreenText && !looksLikeRawInstruction(scene.onScreenText, prompt)
        ? stripInventedClaims(scene.onScreenText, prompt, isAr)
        : undefined;
    return {
      ...scene,
      narration: metaStrippedNarration || scene.narration,
      onScreenText: safeOnScreen || (isCtaScene ? resolvedCta.text : undefined),
      visualPrompt: scene.visualPrompt ? stripInventedClaims(scene.visualPrompt, prompt, isAr) : scene.visualPrompt,
      stockSearchTerms: safeStockSearchTerms(scene.stockSearchTerms, prompt),
      visualProvider: scene.visualProvider === "pexels" ? undefined : scene.visualProvider,
      notes: [
        scene.notes,
        index === 0 ? "raw_prompt_leak_guard_enabled" : undefined,
        isCtaScene ? "truth_safe_cta" : undefined,
      ].filter(Boolean).join("; ") || scene.notes,
    };
  });
}

export function extractDurationFromPrompt(prompt: string): number | null {
  const matchSec = prompt.match(/(\d+)\s*[-_]?\s*(?:ثانية|ثواني|ثوان|ثوانى|seconds|second|secs|sec|s\b)/i);
  if (matchSec) {
    const val = parseInt(matchSec[1], 10);
    if (val >= 5 && val <= 120) return val;
  }
  return null;
}

/**
 * Deterministic "Basic" planner. It is the declared fallback engine - used
 * only when the active creative model (Ollama) is not configured, or when the
 * operator explicitly selects it. It writes honest, topic-anchored generic
 * scenes; it does NOT impersonate model intelligence with hard-coded
 * vertical scripts (the previous TOPIC_REGISTRY / fact-pack / vertical
 * builder bodies were removed - the real planner supersedes them). Every
 * spec it emits is marked contentProvenance BASIC_FALLBACK so degraded
 * output is never silently presented as model-generated.
 */
export class LocalContentAIProvider implements ContentAIProvider {
  public readonly id = "local_ai";
  public readonly displayName = "Basic Deterministic Planner";
  public readonly category = "content_ai" as const;

  public async generateProductionSpec(
    params: GenerateSpecParams,
  ): Promise<ProductionSpec> {
    const prompt = params.prompt.trim();
    const isAr = params.language === "ar" || (params.language === "auto" && isArabic(prompt)) || isArabic(prompt);
    const dialect: ArabicDialect =
      params.dialect && params.dialect !== "none"
        ? params.dialect
        : isAr
          ? detectArabicDialect(prompt)
          : "none";

    // Duration Precedence:
    // 1. Explicit UI/API value (requestedDurationSeconds / durationSeconds / duration)
    // 2. Explicit prompt duration extracted from text
    // 3. Default fallback (30 seconds)
    const explicitDuration =
      params.requestedDurationSeconds ??
      params.durationSeconds ??
      params.duration;
    const extractedDuration = extractDurationFromPrompt(prompt);
    const durationSeconds = explicitDuration || extractedDuration || 30;
    const contentStyle = params.contentStyle || detectContentStyle(prompt) || "advertisement";
    const aspectRatio = params.aspectRatio || "9:16";
    const resolution = params.resolution || "1080p";
    const quality = params.quality || "standard";
    const productionMode = params.productionMode || "auto_hybrid";
    const visualMode = params.visualMode || "auto";
    const voiceProvider = params.voiceProvider || "auto";
    const voiceId = params.voiceId || "";

    const curiosityStyle = contentStyle === "viral_curiosity" || contentStyle === "educational" || contentStyle === "explainer";

    const resolvedCta = resolveCtaProvenance({
      prompt,
      isArabic: isAr,
      dialect,
      brandContactText: params.brandKit?.contactText || undefined,
      isCuriosityStyle: curiosityStyle,
    });

    const scenes = enforcePromptTruthSafety(this.buildBasicScenes({
      prompt,
      isArabic: isAr,
      durationSeconds,
      ctaText: resolvedCta.text,
      brandName: params.brandName || params.brandKit?.brandName,
    }), prompt, isAr, dialect, resolvedCta);

    // Pre-TTS fail-closed feasibility gate: ask whether the resulting
    // narration could plausibly ever land within its own scene's target -
    // using the same calibrated speaking rate and the same bounded natural
    // speed-adjustment ceiling the post-TTS corrector is allowed to use -
    // before spending real TTS calls on content already known to be
    // impossible.
    const planningRate = getSpeakingRate(params.voiceProvider || "", params.voiceId || "", isAr ? "ar" : "en");
    const sceneEstimates = scenes.map((s) => estimateSpeechSeconds(s.narration, planningRate));
    const durationBudget = buildContentDurationBudget({
      requestedVideoSeconds: durationSeconds,
      reservedOutroSeconds: Math.min(2.5, Math.max(1.5, Math.round(durationSeconds * 0.1 * 10) / 10)),
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
        `CONTENT_DURATION_BUDGET_NOT_MET: ${feasibility.reason} (requested ${durationSeconds}s, narration budget ${(durationBudget.narrationBudgetMs / 1000).toFixed(1)}s, estimated narration ${(durationBudget.estimatedNarrationMs / 1000).toFixed(1)}s across ${durationBudget.selectedSceneCount} scene(s)).`,
      );
    }

    const ctaText = resolvedCta.text;

    const rawSpec: ProductionSpec = {
      id: cuid(),
      creationMode: "prompt",
      title: this.generateTitle(prompt, isAr, dialect),
      userPrompt: prompt,
      language: isAr ? "ar" : "en",
      dialect,
      tone: isAr ? "حماسي وجذاب" : "energetic and modern",
      contentStyle,
      durationSeconds,
      aspectRatio,
      resolution,
      quality,
      sceneCount: scenes.length,
      productionMode,
      visualMode,
      voiceProvider,
      voiceId,
      captionStyle: params.brandKit?.captionStyle || "bold",
      brandId: params.brandId,
      cta: {
        text: ctaText,
        action: resolvedCta.action,
        contact: resolvedCta.contact,
      },
      contact: resolvedCta.contact,
      scenes,
      brandKit: params.brandKit,
      metadata: {
        planner: "LocalContentAIProvider",
        plannerVersion: "4.0.0",
        durationBudget,
        promptCompiler: {
          version: "basic_planner.v1",
          rawPromptLeakGuard: true,
          truthGuard: true,
          ctaProvenance: resolvedCta.provenance,
          prohibitedInventedClaims: ["prices", "discounts", "phone_numbers", "whatsapp_cta", "statistics", "testimonials", "urls"],
        },
        contentProvenance: "BASIC_FALLBACK",
        contentConfidence: "low",
        basicMode: true,
      },
    };

    const contract = buildPromptIntentContract(prompt, {
      language: isAr ? "ar" : "en",
      dialect,
      durationSeconds,
      contentStyle: contentStyle as any,
    });

    const specWithContract: ProductionSpec = {
      ...rawSpec,
      metadata: {
        ...(rawSpec.metadata || {}),
        promptIntentContract: contract,
      },
    };

    const { spec: fidelitySpec } = enforceAndRepairPromptFidelity(specWithContract, contract);
    const validated = validateProductionSpec(fidelitySpec);
    const qualityCheck = validateContentQuality(validated);
    return qualityCheck.correctedSpec || validated;
  }

  /**
   * Basic-mode rewrite: a safe structural expansion only. It frames the
   * user's own idea as a brief (subject + structure request) without adding
   * any fact the user did not write - no invented offers, channels, or
   * vertical-specific copy (the previous canned per-vertical rewrites were
   * removed with the fake-complexity cleanup). The model-backed provider
   * performs the real rewrite when Ollama is configured.
   */
  public async rewritePrompt(
    prompt: string,
    context?: { language?: string; dialect?: ArabicDialect; contentStyle?: string },
  ): Promise<PromptRewriteResult> {
    const trimmed = prompt.trim();
    const isAr = context?.language === "ar" || isArabic(trimmed);
    const dialect = context?.dialect || detectArabicDialect(trimmed);
    const styleLabel = context?.contentStyle || "advertisement";

    const enhanced = isAr
      ? `اعمل فيديو ${styleLabel === "advertisement" ? "إعلاني" : "قصير"} رأسي عن: ${trimmed}. البداية Hook يشد الانتباه في أول 3 ثوانٍ، ثم رسالة واضحة واحدة، وإنهاء بدعوة مباشرة للتواصل أو المتابعة إن رغب العميل.`
      : `Create a vertical ${styleLabel} short about: ${trimmed}. Open with a strong 3-second hook, deliver one clear key message, and close with a direct call-to-action only if the brief asks for one.`;

    return {
      originalPrompt: prompt,
      enhancedPrompt: enhanced,
      changesSummary: isAr
        ? `وضع أساسي (بدون نموذج ذكاء اصطناعي): إعادة صياغة بسيطة للفكرة باللهجة ${dialect === "none" ? "العربية" : "المصرية"} مع هيكل Hook/رسالة/CTA - لم تُضاف أي حقائق جديدة.`
        : "Basic mode (no AI model): reframed the idea as a hook/message/CTA brief without adding any facts.",
    };
  }

  public async reviewSpec(spec: ProductionSpec): Promise<SpecReviewResult> {
    const quality = validateContentQuality(spec);
    const score = quality.valid ? Math.max(100 - quality.warnings.length * 10, 70) : 40;
    return {
      approved: quality.valid,
      score,
      warnings: quality.warnings,
      correctedSpec: quality.correctedSpec,
    };
  }

  public async validate(): Promise<ProviderValidationResult> {
    return {
      provider: "Basic Deterministic Planner",
      configured: true,
      healthy: true,
      status: "healthy",
      message: "Basic deterministic planner is operational (explicit fallback mode).",
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
    };
  }

  private generateTitle(prompt: string, isAr: boolean, dialect: ArabicDialect): string {
    const words = prompt.split(/\s+/).slice(0, 5).join(" ");
    if (isAr) {
      return `إنتاج إعلان: ${words}`;
    }
    return `AI Production: ${words}`;
  }

  /**
   * The entire Basic scene source: three topic-anchored beats built from the
   * customer's own extracted topic concepts. Never quotes prompt sentences
   * as narration, never invents a channel or claim - the truth-safety pass
   * above still re-checks every field.
   */
  private buildBasicScenes(context: {
    prompt: string;
    isArabic: boolean;
    durationSeconds: number;
    ctaText: string;
    brandName?: string;
  }): ProductionSceneSpec[] {
    const { prompt, isArabic: isAr, durationSeconds, ctaText } = context;
    const outroTime = Math.min(2.5, Math.max(1.5, Math.round(durationSeconds * 0.1 * 10) / 10));
    const contentBudget = Math.max(durationSeconds - outroTime, 6);
    const dur = Math.round((contentBudget / 3) * 10) / 10;

    // Meta-words describing the REQUEST FORMAT ("curiosity video", "explaining",
    // "vertical") are not topic concepts - filter them before anchoring the
    // generic lines so the basic script is about the subject, not the ask.
    const BASIC_META_WORDS = new Set([
      "vertical", "horizontal", "portrait", "landscape", "curiosity", "explainer",
      "educational", "education", "tutorial", "guide",
      "explain", "explaining", "why", "how", "what", "short", "reel", "tiktok",
      "ad", "commercial", "promo", "highly", "relevant", "natural", "clean",
      "editing", "captions", "real", "footage", "broll", "fast", "engaging",
      "شرح", "ليه", "ازاي", "كيف", "هل", "تعلم",
    ]);
    const topicConcepts = extractTopicConcepts(prompt, isAr ? "ar" : "en")
      .filter((c) => !BASIC_META_WORDS.has(c))
      .slice(0, 3);
    const topicPhrase = topicConcepts.length > 0
      ? topicConcepts.join(isAr ? " و" : " and ")
      : isAr ? "احتياجاتك" : "your needs";

    if (isAr) {
      return [
        {
          sceneIndex: 0,
          purpose: "hook",
          durationSeconds: dur,
          narration: `إليك أسهل طريقة للاهتمام بـ ${topicPhrase} بكل سهولة وسرعة.`,
          onScreenText: topicPhrase,
          stockSearchTerms: [topicPhrase, "real everyday life action", "professional subject close up"],
          visualPrompt: `Dynamic real-world establishing shot about ${topicPhrase}`,
          visualSource: "stock",
          visualProvider: "pexels",
          transition: "cut",
        },
        {
          sceneIndex: 1,
          purpose: "solution",
          durationSeconds: dur,
          narration: `نقدم لك حلولاً حقيقية تساعدك في ${topicPhrase} بأعلى جودة وأفضل تجربة.`,
          onScreenText: "أعلى جودة وأفضل تجربة",
          stockSearchTerms: [topicPhrase, "quality service", "happy customer"],
          visualPrompt: `Focused professional context related to ${topicPhrase}`,
          visualSource: "stock",
          visualProvider: "pexels",
          transition: "fade",
        },
        {
          sceneIndex: 2,
          purpose: "cta",
          durationSeconds: dur,
          narration: ctaText,
          onScreenText: ctaText,
          stockSearchTerms: ["contact us", "smartphone communication", "customer service"],
          visualPrompt: "Customer reaching out via mobile chat with friendly support",
          visualSource: "stock",
          visualProvider: "pexels",
          transition: "cut",
        },
      ];
    }

    return [
      {
        sceneIndex: 0,
        purpose: "hook",
        durationSeconds: dur,
        narration: `Here is the simplest way to handle ${topicPhrase}.`,
        onScreenText: topicPhrase,
        stockSearchTerms: [topicPhrase, `${topicPhrase} close up`, `${topicPhrase} in action`],
        visualPrompt: `High energy establishing shot introducing ${topicPhrase}`,
        visualSource: "stock",
        visualProvider: "pexels",
        transition: "cut",
      },
      {
        sceneIndex: 1,
        purpose: "solution",
        durationSeconds: dur,
        narration: `We help you get the most out of ${topicPhrase} with a simple, reliable approach.`,
        onScreenText: `Better ${topicPhrase}`,
        stockSearchTerms: [topicPhrase, "detailed shot close up", "positive result"],
        visualPrompt: `Close up detail showcasing ${topicPhrase}`,
        visualSource: "stock",
        visualProvider: "pexels",
        transition: "fade",
      },
      {
        sceneIndex: 2,
        purpose: "cta",
        durationSeconds: dur,
        narration: ctaText,
        stockSearchTerms: ["happy person reaction", "satisfied customer", "positive moment"],
        visualPrompt: "Genuine positive reaction shot to close the video",
        visualSource: "stock",
        visualProvider: "pexels",
        transition: "cut",
      },
    ];
  }
}
