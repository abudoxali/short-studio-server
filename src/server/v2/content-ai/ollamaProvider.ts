import axios from "axios";
import { LocalContentAIProvider } from "./localProvider";
import type {
  ContentAIProvider,
  GenerateSpecParams,
  PromptRewriteResult,
  ProviderValidationResult,
  SpecReviewResult,
} from "./types";
import type { ProductionSpec } from "../../../types/productionSpec";
import { inventsUngroundedClaim } from "../creative/ctaPolicy";
import { logger } from "../../../logger";
import { buildPromptIntentContract } from "./promptIntentContract";
import { assembleProductionSpec, coercePlanShape, creativePlanSchema } from "./creativePlanner";

export class ContentPlannerError extends Error {
  constructor(
    public readonly plannerCode: "planner_unavailable" | "planner_invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "ContentPlannerError";
  }
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Local LLM response did not include a JSON object.");
  return JSON.parse(text.slice(start, end + 1));
}

// Read at call time so a settings/env change applies without a process restart.
const plannerTimeoutMs = () => Number(process.env.OLLAMA_TIMEOUT_MS || 45000);
const PLANNER_MAX_ATTEMPTS = 2;

/**
 * Ollama-backed creative planner. The model receives only the compact intent
 * contract and returns a compact creative plan (script + storyboard); the
 * deterministic assembler in creativePlanner.ts owns structure, timing,
 * provenance and every safety gate. Previous versions asked the model to
 * round-trip an entire ProductionSpec, which produced multi-KB responses that
 * outran the API request timeout and were silently replaced by the
 * deterministic baseline on any failure. A failure now surfaces as a
 * ContentPlannerError so callers can return an honest, actionable error.
 */
export class OllamaContentAIProvider implements ContentAIProvider {
  public readonly id = "ollama";
  public readonly displayName = "Ollama Local LLM Creative Director";
  public readonly category = "content_ai" as const;
  private fallback = new LocalContentAIProvider();

  constructor(
    private baseUrl = process.env.OLLAMA_BASE_URL || "",
    private model = process.env.OLLAMA_MODEL || "qwen2.5:7b-instruct",
  ) { }

  public get isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  private async callPlanner(system: string, prompt: string): Promise<unknown> {
    const response = await axios.post(
      `${this.baseUrl.replace(/\/$/, "")}/api/generate`,
      { model: this.model, stream: false, system, prompt, format: "json", options: { temperature: 0.3 } },
      { timeout: plannerTimeoutMs() },
    );
    const raw =
      typeof response.data?.response === "string" ? response.data.response : JSON.stringify(response.data);
    return extractJsonObject(raw);
  }

  public async generateProductionSpec(params: GenerateSpecParams): Promise<ProductionSpec> {
    // Ollama not configured at all is an explicit, declared degraded state:
    // the Basic planner is the selected engine, and the spec metadata says so.
    if (!this.isConfigured) {
      const spec = await this.fallback.generateProductionSpec(params);
      spec.metadata = {
        ...(spec.metadata || {}),
        planner: "LocalContentAIProvider",
        fallbackUsed: true,
        fallbackReason: "OLLAMA_BASE_URL not configured",
        contentProvenance: "BASIC_FALLBACK",
      };
      return spec;
    }

    const isAr =
      params.language === "ar" ||
      (params.language !== "en" && /[\u0600-\u06FF]/.test(params.prompt));
    const dialect = params.dialect && params.dialect !== "none" ? params.dialect : isAr ? "egyptian" : "none";
    const languageLabel =
      isAr && dialect === "egyptian"
        ? "spoken Egyptian Arabic (عامية مصرية), never formal MSA"
        : isAr
          ? "Modern Standard Arabic"
          : "English";
    const durationSeconds =
      params.requestedDurationSeconds ?? params.durationSeconds ?? params.duration ?? 30;
    const contract = buildPromptIntentContract(params.prompt, {
      language: isAr ? "ar" : "en",
      dialect,
      durationSeconds,
      contentStyle: params.contentStyle,
    });
    const targetScenes = contract.estimatedSceneCount;

    const system = [
      "You are a short-form vertical video creative director and scriptwriter.",
      "The customer brief below describes the video they want. Turn it into a complete creative plan and return ONLY JSON:",
      '{"title": "...", "tone": "...", "scenes": [{"purpose": "hook|problem|solution|benefit|proof|cta", "narration": "...", "onScreenText": "...", "visualIntent": "...", "searchQueries": ["...", "..."]}], "cta": "optional", "expansionLines": ["optional extra supporting sentences"]}',
      `Write all narration in ${languageLabel}, as fresh natural spoken lines - never copy sentences from the brief itself.`,
      `When writing Arabic narration: keep established English technical terms in English exactly as people say them (API, cache, backend, frontend, server, database, HTTP, app, code, deploy) - never invent Arabic transliterations of English words and never write fake Arabic-sounding tech words. Plain everyday spoken Arabic is better than ornate phrasing.`,
      `Total spoken narration must fit about ${durationSeconds}s of video across roughly ${targetScenes} scenes.`,
      "Rules: 1) The brief is INPUT, not narration - never read its sentences back; 2) Never invent prices, discounts, discounts codes, phone numbers, WhatsApp, websites, testimonials, statistics or guarantees not present in the brief; 3) Honour every negative constraint; 4) onScreenText is a short punchy overlay line, not a duplicate of narration; 5) visualIntent describes the concrete shot this scene needs; 6) searchQueries MUST be written in English words only, even for Arabic briefs - they query an English stock-footage API. 3-5 SHORT concrete visual search phrases, each a different angle (subject / action / environment / detail / result) - never mood words like 'cinematic' or 'professional' and never Arabic; 7) each scene gets a DIFFERENT purpose (only the first may be 'hook', only the last may be 'cta'); 8) the final scene should deliver the takeaway or call-to-action.",
    ].join("\n");

    const requestPayload = {
      brief: params.prompt,
      intent: {
        requestedTopic: contract.requestedTopic,
        coreEntity: contract.coreEntity,
        intentType: contract.intentType,
        factualRequirements: contract.factualRequirements,
        subjectEntities: contract.subjectEntities,
        quotedPhrases: contract.quotedPhrases,
        negativeConstraints: contract.negativeConstraints,
        requestedExclusions: contract.requestedExclusions,
        explicitHook: contract.explicitHook,
        explicitMiddleMessage: contract.explicitMiddleMessage,
        explicitCta: contract.explicitCta || contract.requestedCta.explicitText,
        audience: contract.audience,
        tone: contract.tone,
        location: contract.location,
        productOrBusiness: contract.productOrBusiness,
        durationSeconds,
        targetSceneCount: targetScenes,
        language: contract.language,
        dialect: contract.dialect,
        contentStyle: params.contentStyle,
      },
    };

    const started = Date.now();
    let lastError: unknown = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      try {
        const parsed = await this.callPlanner(system, JSON.stringify(requestPayload));
        const plan = creativePlanSchema.parse(coercePlanShape(parsed));
        const spec = assembleProductionSpec({
          plan,
          specParams: params,
          contract,
          meta: {
            planner: "OllamaContentAIProvider",
            plannerModel: this.model,
            plannerLatencyMs: Date.now() - started,
            plannerRetries: attempt - 1,
            fallbackUsed: false,
            contentProvenance: "MODEL_GENERATED",
            contentConfidence: "high",
          },
        });
        return spec;
      } catch (error) {
        lastError = error;
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), model: this.model, attempt },
          "Ollama creative plan attempt failed",
        );
      }
    }

    // A configured-but-failed planner is an honest error, never a silent
    // drop into canned content the UI would label "AI Creative Director".
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    const isNet = /timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|refused|aborted/i.test(reason);
    throw new ContentPlannerError(
      isNet ? "planner_unavailable" : "planner_invalid_response",
      `Local AI planner (${this.model}) failed after ${attempts} attempts: ${reason}`,
    );
  }

  /**
   * "Improve description" asks the real model for a concise creative brief -
   * not a meta-prompt full of production instructions. The rewrite is
   * rejected if it introduces facts the user's original did not contain.
   */
  public async rewritePrompt(
    prompt: string,
    context?: { language?: any; dialect?: any; contentStyle?: any },
  ): Promise<PromptRewriteResult> {
    if (!this.isConfigured) {
      return this.fallback.rewritePrompt(prompt, context);
    }
    const isAr =
      context?.language === "ar" ||
      (context?.language !== "en" && /[\u0600-\u06FF]/.test(prompt));
    const system = [
      "You rewrite rough video ideas into a clear, concise creative brief a director could shoot from.",
      "Return ONLY JSON: {\"improvedPrompt\": \"...\", \"keyPoints\": [\"...\"]}",
      `Write in ${isAr ? "the same Arabic dialect as the input" : "English"}.`,
      "Preserve: every explicit fact, quoted phrase, negative constraint, language/dialect, duration, CTA and product name.",
      "Never add prices, discounts, contact details, WhatsApp, websites, testimonials, statistics, guarantees or promotions the user did not write.",
      "Keep it human-editable: 2-6 short lines covering subject, audience, tone, key message and CTA if requested.",
    ].join("\n");
    try {
      const parsed = (await this.callPlanner(system, JSON.stringify({ brief: prompt }))) as Record<
        string,
        unknown
      >;
      const improved = typeof parsed?.improvedPrompt === "string" ? parsed.improvedPrompt.trim() : "";
      const keyPoints = Array.isArray(parsed?.keyPoints)
        ? (parsed.keyPoints as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0)
        : [];
      if (!improved || improved.length < 10) {
        throw new Error("Local LLM returned an empty rewrite.");
      }
      // Models sometimes put the actual brief improvements in keyPoints and
      // echo the original back in improvedPrompt - merge them rather than
      // return a rewrite identical to the input.
      const effective = improved === prompt.trim() && keyPoints.length > 0
        ? `${improved} ${keyPoints.join(". ")}`
        : improved;
      if (inventsUngroundedClaim(effective, prompt)) {
        // The rewrite added facts the user never stated - refuse it rather
        // than ship invented claims back into the brief.
        return {
          originalPrompt: prompt,
          enhancedPrompt: prompt,
          changesSummary: "AI rewrite declined: it introduced facts not present in the original prompt.",
        };
      }
      return {
        originalPrompt: prompt,
        enhancedPrompt: effective,
        changesSummary:
          keyPoints.length > 0
            ? `AI-improved brief: ${keyPoints.slice(0, 4).join(" • ")}`
            : "AI-improved creative brief.",
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ err: reason, model: this.model }, "Ollama prompt rewrite failed");
      throw new ContentPlannerError("planner_unavailable", `Local AI prompt rewrite failed: ${reason}`);
    }
  }

  /** Spec review is a validation task - the deterministic checker is the
   *  correct engine for it; no model call needed. */
  public async reviewSpec(spec: ProductionSpec): Promise<SpecReviewResult> {
    return this.fallback.reviewSpec(spec);
  }

  public async validate(): Promise<ProviderValidationResult> {
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured) {
      return {
        provider: "Ollama Local LLM",
        configured: false,
        healthy: false,
        status: "not_configured",
        message: "OLLAMA_BASE_URL is not configured. Deterministic Local AI remains active.",
        checkedAt,
      };
    }
    const started = Date.now();
    try {
      await axios.get(`${this.baseUrl.replace(/\/$/, "")}/api/tags`, { timeout: 5000 });
      return {
        provider: "Ollama Local LLM",
        configured: true,
        healthy: true,
        status: "healthy",
        message: `Ollama endpoint is reachable. Requested model: ${this.model}.`,
        checkedAt,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        provider: "Ollama Local LLM",
        configured: true,
        healthy: false,
        status: "provider_unavailable",
        message: error instanceof Error ? error.message : "Ollama validation failed.",
        checkedAt,
        latencyMs: Date.now() - started,
      };
    }
  }
}
