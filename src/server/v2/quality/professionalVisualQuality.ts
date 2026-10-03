import type { ProductionSpec } from "../../../types/productionSpec";
import type { VisualShot } from "../editing/editDecisionList";
import { hasExplicitOffer, hasExplicitStatistic, hasExplicitWhatsApp } from "../creative/ctaPolicy";

export type ProfessionalVisualQualityReport = {
  realVisualCoveragePercent: number;
  providerMix: Record<string, number>;
  uniqueShotCount: number;
  uniqueAssetCount: number;
  repeatedAssetCount: number;
  averageSemanticScore?: number;
  minimumSemanticScore?: number;
  /**
   * Honest label for what averageSemanticScore actually measures:
   * "visual_semantic" only when real frame-level analysis (OpenCLIP) ran for
   * every scored asset; "metadata_relevance" when scoring fell back to the
   * lexical/keyword pre-score because the semantic runtime was unavailable
   * (e.g. opencv/OpenCLIP not installed in this environment) - that lexical
   * score is a real signal (query-to-title/tag match), just not a visual
   * check of the actual frames, and must never be reported as if it were
   * one. See ABUD_SHORTS_ENGINE_STATUS.md section 15: a real-content proof
   * once recorded `visualRelevanceScore: 100` while every asset's
   * `semanticAnalysis.runtime` was `"unavailable"` - this field exists so
   * that can never happen silently again.
   */
  visualRelevanceMethod: "visual_semantic" | "metadata_relevance" | "unscored";
  blackFramePercent?: number;
  textOnlyTimelinePercent: number;
  generatedTimelinePercent: number;
  stockTimelinePercent: number;
  uploadedTimelinePercent: number;
  motionOverlayPercent: number;
  /**
   * Motion seconds with a real creative reason attached (a planned graphic
   * treatment or a recorded stock-rejection fallback). Professional quality
   * means relevant visuals, not a mandatory percentage of stock footage -
   * a designed explainer card honestly beats a random laptop clip.
   */
  purposefulMotionTimelinePercent: number;
  /** Motion seconds with no recorded creative reason (suspicious). */
  unexplainedMotionTimelinePercent: number;
  /** realSeconds + purposeful motion: the share of the timeline carrying a deliberate visual. */
  intentionalVisualCoveragePercent: number;
  rawPromptLeakCount: number;
  inventedClaimRiskCount: number;
  readyForProfessionalAuto: boolean;
  issues: string[];
  /** Non-blocking advisories - recorded facts, not gate failures. */
  notes: string[];
};

function norm(text: unknown): string {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function containsRawPromptLeak(prompt: string | undefined, text: string | undefined): boolean {
  const p = norm(prompt);
  const t = norm(text);
  if (!p || !t) return false;
  return p.startsWith(t) || t.startsWith(p.slice(0, Math.min(80, p.length))) || /^create a |^make a video|^اعمل فيديو/.test(t);
}

export function detectInventedClaimRisk(spec: ProductionSpec): number {
  const prompt = spec.userPrompt || "";
  // Negation-aware: a prompt that says "do not invent... WhatsApp numbers" must
  // not be read as authorizing WhatsApp. See ctaPolicy.ts for why a bare
  // substring test on the raw prompt is unsafe (incident cmtehsptj000108ledzk3f3ji).
  const allowsWhatsapp = hasExplicitWhatsApp(prompt);
  const allowsOffer = hasExplicitOffer(prompt);
  const allowsStats = hasExplicitStatistic(prompt);
  let risk = 0;
  const text = norm([
    spec.cta?.text,
    spec.cta?.action,
    spec.cta?.contact,
    spec.contact,
    ...spec.scenes.flatMap((scene) => [scene.narration, scene.onScreenText, scene.displayText]),
  ].filter(Boolean).join(" "));
  if (!allowsWhatsapp && /whats\s*app|واتساب|واتس/.test(text)) risk += 1;
  if (!allowsOffer && /discount|offer|sale|coupon|promo|خصم|عرض|تخفيض|كوبون/.test(text)) risk += 1;
  if (!allowsStats && /\d+\s*%|\d+\s*(percent|في المية|بالمية|٪)/.test(text)) risk += 1;
  return risk;
}

export function calculateProfessionalVisualQualityReport(input: {
  spec: ProductionSpec;
  shots: VisualShot[];
  selectedVisuals: Array<Record<string, any>>;
  totalDurationSeconds: number;
  blackFramePercent?: number;
}): ProfessionalVisualQualityReport {
  const total = Math.max(0.001, input.totalDurationSeconds);
  const shots = input.shots || [];
  const selected = input.selectedVisuals || [];
  const secondsByType: Record<string, number> = {};
  shots.forEach((shot) => {
    secondsByType[shot.sourceType] = (secondsByType[shot.sourceType] || 0) + Math.max(0, shot.duration || 0);
  });

  const stockSeconds = secondsByType.stock || 0;
  const generatedSeconds = (secondsByType.image || 0);
  const uploadedSeconds = secondsByType.upload || 0;
  const motionSeconds = secondsByType.motion || 0;
  const realSeconds = stockSeconds + generatedSeconds + uploadedSeconds;

  // Motion shots with a recorded creative reason (creative_plan treatment or
  // a stock-rejection fallback) are deliberate design; motion shots with no
  // routing reason are unexplained fill. This is what separates "purposeful
  // motion graphics" from "text over a colour because footage was missing".
  const purposefulMotionSeconds = shots
    .filter((shot) => shot.sourceType === "motion")
    .filter((shot) => /creative_plan:|stock_rejected|motion_graphics|graphic/.test(String(shot.routingReason || "")))
    .reduce((acc, shot) => acc + Math.max(0, shot.duration || 0), 0);
  const unexplainedMotionSeconds = Math.max(0, motionSeconds - purposefulMotionSeconds);

  const providerMix: Record<string, number> = {};
  selected.forEach((asset) => {
    const provider = String(asset.provider || "unknown");
    providerMix[provider] = (providerMix[provider] || 0) + 1;
  });

  const assetKeys = selected.map((asset) =>
    String(asset.metadata?.providerAssetId || asset.metadata?.pexelsVideoId || asset.metadata?.pixabayVideoId || asset.metadata?.stockAssetId || asset.url || asset.artifactId || ""),
  ).filter(Boolean);
  const uniqueAssetCount = new Set(assetKeys).size;
  // `semanticAvailable: true` means real frame-level OpenCLIP analysis
  // produced this asset's score (see router.ts's rebuildCandidateScore).
  // Anything else - including a perfectly valid lexical/keyword pre-score -
  // is NOT a visual check of the actual frames and must be tracked
  // separately, never blended into a number labelled "semantic".
  const visuallyScored = selected.filter((asset) => asset.metadata?.semanticAvailable === true);
  const metadataScored = selected.filter((asset) => asset.metadata?.semanticAvailable !== true);
  const semanticScores = visuallyScored
    .map((asset) => Number(asset.metadata?.semanticScore ?? asset.metadata?.selectedScore))
    .filter((value) => Number.isFinite(value));
  const metadataRelevanceScores = metadataScored
    .map((asset) => Number(asset.metadata?.semanticScore ?? asset.metadata?.selectedScore))
    .filter((value) => Number.isFinite(value));
  // Prefer real visual scores when any exist; otherwise honestly fall back
  // to the lexical/metadata score under its own truthful label rather than
  // reporting nothing (a metadata-relevance signal is still real evidence,
  // just not what "semantic" implies).
  const reportedScores = semanticScores.length ? semanticScores : metadataRelevanceScores;
  const visualRelevanceMethod: ProfessionalVisualQualityReport["visualRelevanceMethod"] = semanticScores.length
    ? "visual_semantic"
    : metadataRelevanceScores.length
      ? "metadata_relevance"
      : "unscored";
  const rawPromptLeakCount = input.spec.scenes.filter((scene) =>
    containsRawPromptLeak(input.spec.userPrompt, scene.onScreenText || scene.displayText),
  ).length;
  const inventedClaimRiskCount = detectInventedClaimRisk(input.spec);

  const report: ProfessionalVisualQualityReport = {
    realVisualCoveragePercent: Math.round((realSeconds / total) * 1000) / 10,
    providerMix,
    uniqueShotCount: new Set(shots.map((shot) => shot.shotId)).size,
    uniqueAssetCount,
    repeatedAssetCount: Math.max(0, assetKeys.length - uniqueAssetCount),
    averageSemanticScore: reportedScores.length
      ? Math.round((reportedScores.reduce((a, b) => a + b, 0) / reportedScores.length) * 10) / 10
      : undefined,
    minimumSemanticScore: reportedScores.length ? Math.min(...reportedScores) : undefined,
    visualRelevanceMethod,
    blackFramePercent: input.blackFramePercent,
    textOnlyTimelinePercent: Math.round((unexplainedMotionSeconds / total) * 1000) / 10,
    generatedTimelinePercent: Math.round((generatedSeconds / total) * 1000) / 10,
    stockTimelinePercent: Math.round((stockSeconds / total) * 1000) / 10,
    uploadedTimelinePercent: Math.round((uploadedSeconds / total) * 1000) / 10,
    motionOverlayPercent: Math.round((motionSeconds / total) * 1000) / 10,
    purposefulMotionTimelinePercent: Math.round((purposefulMotionSeconds / total) * 1000) / 10,
    unexplainedMotionTimelinePercent: Math.round((unexplainedMotionSeconds / total) * 1000) / 10,
    intentionalVisualCoveragePercent:
      Math.round(((realSeconds + purposefulMotionSeconds) / total) * 1000) / 10,
    rawPromptLeakCount,
    inventedClaimRiskCount,
    readyForProfessionalAuto: false,
    issues: [],
    notes: [],
  };

  const graphicsLed =
    input.spec.visualMode === "motion_graphics" ||
    input.spec.visualMode === "animated_explainer" ||
    input.spec.productionMode === "motion_graphics" ||
    input.spec.productionMode === "animated_explainer";

  // Coverage is judged on intentional visuals: real footage plus graphics the
  // pipeline chose on purpose. A production that resolved weak-stock scenes
  // to designed motion is honest; one that left unexplained gaps is not.
  if (report.intentionalVisualCoveragePercent < 90 && !graphicsLed) {
    report.issues.push("real_visual_coverage_below_90_percent");
  }
  if (report.purposefulMotionTimelinePercent > 0 && report.stockTimelinePercent < 90 && !graphicsLed) {
    report.notes.push("some_scenes_resolved_to_purposeful_motion_graphics");
  }
  if (report.textOnlyTimelinePercent > 10 && !graphicsLed) {
    report.issues.push("text_only_timeline_above_10_percent");
  }
  if (report.repeatedAssetCount > 0) report.issues.push("repeated_visual_assets_detected");
  if (report.rawPromptLeakCount > 0) report.issues.push("raw_prompt_leak_detected");
  if (report.inventedClaimRiskCount > 0) report.issues.push("invented_claim_risk_detected");
  if ((report.blackFramePercent || 0) > 1) report.issues.push("black_frame_percentage_high");
  report.readyForProfessionalAuto = report.issues.length === 0;
  return report;
}
