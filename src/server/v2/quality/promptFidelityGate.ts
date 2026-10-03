import type { ProductionSceneSpec, ProductionSpec } from "../../../types/productionSpec";
import {
  type PromptIntentContract,
  buildPromptIntentContract,
  stripMetaInstructions,
} from "../content-ai/promptIntentContract";
import { inventsUngroundedClaim } from "../creative/ctaPolicy";

export interface PromptFidelityIssue {
  rule:
  | "quoted_text_missing"
  | "negative_constraint_violated"
  | "topic_drift"
  | "unrequested_claim_invented"
  | "abstract_stock_query"
  | "raw_prompt_leak";
  message: string;
  severity: "error" | "warning";
  sceneIndex?: number;
  field?: string;
  details?: Record<string, unknown>;
}

export interface PromptFidelityResult {
  passed: boolean;
  score: number; // 0 to 100
  issues: PromptFidelityIssue[];
  quotedPhrasesFound: string[];
  quotedPhrasesMissing: string[];
  negativeViolations: string[];
  inventedClaims: string[];
  topicGroundingScore: number;
}

export function verifyPromptFidelity(
  spec: ProductionSpec,
  explicitContract?: PromptIntentContract,
): PromptFidelityResult {
  const contract =
    explicitContract ||
    buildPromptIntentContract(spec.userPrompt || spec.title, {
      language: spec.language === "ar" ? "ar" : "en",
      dialect: spec.dialect,
      durationSeconds: spec.durationSeconds,
      contentStyle: spec.contentStyle,
    });

  const issues: PromptFidelityIssue[] = [];
  const fullNarration = spec.scenes.map((s) => s.narration).join(" ");
  const fullOnScreen = spec.scenes.map((s) => s.onScreenText || "").join(" ");
  const fullText = `${fullNarration} ${fullOnScreen}`.toLowerCase();

  // 1. Quoted text check
  const quotedPhrasesFound: string[] = [];
  const quotedPhrasesMissing: string[] = [];

  for (const quote of contract.quotedPhrases) {
    const qLower = quote.toLowerCase();
    if (fullText.includes(qLower)) {
      quotedPhrasesFound.push(quote);
    } else {
      quotedPhrasesMissing.push(quote);
      issues.push({
        rule: "quoted_text_missing",
        message: `Quoted phrase "${quote}" from user prompt was not found in video script or on-screen text.`,
        severity: "error",
        details: { quote },
      });
    }
  }

  // 2. Negative constraints check
  const negativeViolations: string[] = [];
  for (const neg of contract.negativeConstraints) {
    const negLower = neg.toLowerCase();
    if (fullText.includes(negLower)) {
      negativeViolations.push(neg);
      issues.push({
        rule: "negative_constraint_violated",
        message: `Video script includes negative constraint "${neg}" which was forbidden by prompt.`,
        severity: "error",
        details: { constraint: neg },
      });
    }
  }

  // 3. Topic grounding check
  let topicMatches = 0;
  const topicKeywords = contract.topicKeywords.map((k) => k.toLowerCase());
  for (const kw of topicKeywords) {
    if (fullText.includes(kw)) {
      topicMatches++;
    }
  }
  const topicGroundingScore =
    topicKeywords.length > 0
      ? Math.round((topicMatches / topicKeywords.length) * 100)
      : 100;

  if (topicGroundingScore < 20 && topicKeywords.length > 0) {
    issues.push({
      rule: "topic_drift",
      message: `Topic grounding is critically low (${topicGroundingScore}%). Video script diverges from core entity: "${contract.coreEntity}".`,
      severity: "error",
      details: { coreEntity: contract.coreEntity, topicGroundingScore },
    });
  }

  // 4. Invented unrequested claims
  const inventedClaims: string[] = [];
  for (const scene of spec.scenes) {
    if (inventsUngroundedClaim(scene.narration, contract.rawPrompt)) {
      inventedClaims.push(scene.narration);
      issues.push({
        rule: "unrequested_claim_invented",
        message: `Scene ${scene.sceneIndex} narration contains ungrounded claim or unrequested offer channel.`,
        severity: "error",
        sceneIndex: scene.sceneIndex,
        field: "narration",
      });
    }
    if (scene.onScreenText && inventsUngroundedClaim(scene.onScreenText, contract.rawPrompt)) {
      inventedClaims.push(scene.onScreenText);
      issues.push({
        rule: "unrequested_claim_invented",
        message: `Scene ${scene.sceneIndex} on-screen text contains ungrounded claim.`,
        severity: "error",
        sceneIndex: scene.sceneIndex,
        field: "onScreenText",
      });
    }

    // 5. Check stock terms for forbidden abstract phrases
    for (const term of scene.stockSearchTerms || []) {
      const tLower = term.toLowerCase();
      if (contract.forbiddenStockQueries.some((f) => tLower === f.toLowerCase())) {
        issues.push({
          rule: "abstract_stock_query",
          message: `Scene ${scene.sceneIndex} uses forbidden abstract query "${term}" instead of concrete subject.`,
          severity: "warning",
          sceneIndex: scene.sceneIndex,
          field: "stockSearchTerms",
        });
      }
    }

    // 6. Check for raw prompt/meta-instruction leakage in narration
    const isAr = contract.language === "ar";
    const stripped = stripMetaInstructions(scene.narration, isAr, { forNarration: true });
    if (stripped !== scene.narration && stripped.length < scene.narration.length) {
      issues.push({
        rule: "raw_prompt_leak",
        message: `Scene ${scene.sceneIndex} narration contains meta/orchestration instructions that should not be spoken.`,
        severity: "error",
        sceneIndex: scene.sceneIndex,
        field: "narration",
        details: { original: scene.narration, stripped },
      });
    }
  }

  // Score calculation
  let deduction = 0;
  deduction += quotedPhrasesMissing.length * 25;
  deduction += negativeViolations.length * 30;
  deduction += inventedClaims.length * 15;
  deduction += issues.filter((i) => i.rule === "raw_prompt_leak").length * 20;
  if (topicGroundingScore < 50) deduction += 20;

  const score = Math.max(0, Math.min(100, 100 - deduction));
  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    passed: !hasErrors && score >= 70,
    score,
    issues,
    quotedPhrasesFound,
    quotedPhrasesMissing,
    negativeViolations,
    inventedClaims,
    topicGroundingScore,
  };
}

export function enforceAndRepairPromptFidelity(
  spec: ProductionSpec,
  explicitContract?: PromptIntentContract,
): { spec: ProductionSpec; result: PromptFidelityResult; repaired: boolean } {
  const contract =
    explicitContract ||
    buildPromptIntentContract(spec.userPrompt || spec.title, {
      language: spec.language === "ar" ? "ar" : "en",
      dialect: spec.dialect,
      durationSeconds: spec.durationSeconds,
      contentStyle: spec.contentStyle,
    });

  let repaired = false;
  const repairedScenes = spec.scenes.map((scene, idx) => {
    let narration = scene.narration;
    let onScreenText = scene.onScreenText;
    let stockTerms = [...(scene.stockSearchTerms || [])];
    const isAr = contract.language === "ar";

    // Strip raw prompt/meta-instruction leakage from narration
    const metaStripped = stripMetaInstructions(narration, isAr, { forNarration: true });
    if (metaStripped !== narration && metaStripped.length > 0) {
      narration = metaStripped;
      repaired = true;
    }

    // Filter abstract stock queries and replace with concrete subjects
    const concretePool = contract.concreteVisualSubjects;
    const filteredTerms = stockTerms.filter(
      (term) => !contract.forbiddenStockQueries.some((f) => term.toLowerCase() === f.toLowerCase()),
    );

    if (filteredTerms.length < stockTerms.length || filteredTerms.length === 0) {
      // Pick concrete visual subjects appropriate for this scene index
      const replacementTerm = concretePool[idx % concretePool.length] || `${contract.coreEntity} footage`;
      if (!filteredTerms.includes(replacementTerm)) {
        filteredTerms.unshift(replacementTerm);
      }
      stockTerms = filteredTerms;
      repaired = true;
    }

    // Strip ungrounded claims (e.g. WhatsApp CTA if prompt didn't ask for it)
    if (inventsUngroundedClaim(narration, contract.rawPrompt)) {
      if (scene.purpose === "cta") {
        narration =
          contract.language === "ar"
            ? (contract.requestedCta.explicitText || "تابعنا للمزيد من التفاصيل المفيدة.")
            : (contract.requestedCta.explicitText || "Follow for more insights.");
      } else {
        narration = narration
          .replace(/تواصل معنا عبر واتساب/g, "تابعنا لمعرفة المزيد")
          .replace(/contact us on whatsapp/gi, "follow for more")
          .replace(/خصم خاص/g, "جودة مميزة")
          .replace(/special discount/gi, "top quality");
      }
      repaired = true;
    }

    if (onScreenText && inventsUngroundedClaim(onScreenText, contract.rawPrompt)) {
      onScreenText =
        scene.purpose === "cta"
          ? (contract.language === "ar" ? "تابعنا للمزيد" : "Follow For More")
          : (contract.language === "ar" ? "جودة عالية" : "High Quality");
      repaired = true;
    }

    return {
      ...scene,
      narration,
      onScreenText,
      stockSearchTerms: stockTerms,
    };
  });

  // If a quoted phrase is missing, inject it into onScreenText of hook or CTA scene
  const initialResult = verifyPromptFidelity(
    { ...spec, scenes: repairedScenes },
    contract,
  );

  if (initialResult.quotedPhrasesMissing.length > 0) {
    for (const missingQuote of initialResult.quotedPhrasesMissing) {
      if (repairedScenes.length > 0) {
        // Place missing quote in onScreenText of scene 0 or CTA
        if (!repairedScenes[0].onScreenText?.includes(missingQuote)) {
          repairedScenes[0].onScreenText = missingQuote;
          repaired = true;
        }
      }
    }
  }

  const finalSpec: ProductionSpec = {
    ...spec,
    scenes: repairedScenes,
    metadata: {
      ...(spec.metadata || {}),
      promptIntentContract: contract,
    },
  };

  const finalResult = verifyPromptFidelity(finalSpec, contract);

  return {
    spec: finalSpec,
    result: finalResult,
    repaired,
  };
}
