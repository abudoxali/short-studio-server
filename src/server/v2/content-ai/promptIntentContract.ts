import { z } from "zod";
import type { ArabicDialect, ContentStyle } from "../../../types/productionSpec";

export const promptIntentContractSchema = z.object({
  rawPrompt: z.string().trim(),
  requestedTopic: z.string().trim().min(1),
  coreEntity: z.string().trim().min(1),
  subjectEntities: z.array(z.string().trim()),
  factualRequirements: z.array(z.string().trim()),
  explicitHook: z.string().trim().optional(),
  explicitMiddleMessage: z.string().trim().optional(),
  explicitCta: z.string().trim().optional(),
  audience: z.string().trim().optional(),
  tone: z.string().trim().optional(),
  contentType: z.string().trim().optional(),
  location: z.string().trim().optional(),
  productOrBusiness: z.string().trim().optional(),
  requestedDuration: z.number().positive().optional(),
  visualRequirements: z.array(z.string().trim()),
  voiceRequirements: z.array(z.string().trim()),
  captionRequirements: z.array(z.string().trim()),
  topicKeywords: z.array(z.string().trim()).min(1),
  intentType: z.enum([
    "educational",
    "explainer",
    "promotional",
    "brand_ad",
    "listicle",
    "storytelling",
    "viral_curiosity",
    "direct_response",
  ]),
  language: z.enum(["en", "ar"]),
  dialect: z.enum(["egyptian", "msa", "saudi", "gulf", "levantine", "none"]).default("none"),
  quotedPhrases: z.array(z.string().trim()),
  negativeConstraints: z.array(z.string().trim()),
  requestedExclusions: z.array(z.string().trim()),
  concreteVisualSubjects: z.array(z.string().trim()).min(1),
  forbiddenStockQueries: z.array(z.string().trim()),
  requestedCta: z.object({
    required: z.boolean(),
    explicitText: z.string().trim().optional(),
    channel: z.string().trim().optional(),
  }),
  groundedFacts: z.array(z.string().trim()),
  targetDurationSeconds: z.number().positive(),
  estimatedSceneCount: z.number().int().min(1).max(12),
});

export type PromptIntentContract = z.infer<typeof promptIntentContractSchema>;

const ABSTRACT_FORBIDDEN_TERMS = [
  "cinematic hero shot",
  "modern lifestyle",
  "high energy cinematic",
  "close up detail",
  "quality craftsmanship",
  "what matters most",
  "dynamic visual scene",
  "dynamic modern visual",
  "focused modern professional",
  "lifestyle",
  "innovation",
  "success",
  "abstract",
  "concept",
  "cinematic",
  "hero shot",
  "technology",
  "business meeting",
];

const ARABIC_TO_ENGLISH_CONCRETE_MAP: Record<string, string[]> = {
  "أهرامات": ["giza pyramids", "egypt desert pyramids", "ancient cairo pyramids"],
  "اهرامات": ["giza pyramids", "egypt desert pyramids", "ancient cairo pyramids"],
  "هرم": ["great pyramid giza", "egypt pyramid"],
  "قطط": ["domestic cat playing", "cat close up whiskers", "sleeping cute cat"],
  "قطة": ["cat face close up", "domestic kitten", "cat purring"],
  "برمجة": ["programmer typing code", "python code on screen", "software developer desk"],
  "كود": ["code editor monitor", "typing computer code", "laptop developer"],
  "عطر": ["luxury perfume bottle", "perfume mist spray", "perfume glass bottle"],
  "عطور": ["perfume bottles luxury", "perfume counter display", "fragrance bottle gold"],
  "قهوة": ["espresso extraction", "steaming coffee cup", "coffee beans roasting"],
  "كافيه": ["cozy cafe interior", "barista making coffee", "latte art pouring"],
  "استثمار": ["stock market chart", "counting money cash", "gold bullion bars"],
  "فلوس": ["money cash banknotes", "stack of coins", "wallet cash"],
  "توفير": ["piggy bank coins", "saving money jar", "calculating budget"],
  "طيران": ["airplane flying sky", "airplane window view", "aircraft wings clouds"],
  "طيارة": ["airplane flying in clouds", "airplane cabin window", "commercial airplane"],
  "رياضة": ["dumbbell workout gym", "fitness training athlete", "running treadmill gym"],
  "جيم": ["modern fitness gym", "gym weights workout", "athlete training gym"],
  "تسويق": ["analytics dashboard screen", "digital marketing graph", "social media strategy"],
  "شغل": ["busy office workspace", "typing on laptop modern office", "business professional desk"],
  "سياحة": ["travel vacation beach", "scenic landmark tourism", "tourist exploring city"],
  "موبايل": ["smartphone screen scrolling", "holding mobile phone hand", "smartphone close up"],
  "مطعم": ["chef cooking kitchen", "delicious plated food dish", "restaurant dining table"],
  "عقارات": ["modern luxury villa architecture", "luxury apartment living room", "real estate property exterior"],
  "شقة": ["modern apartment interior", "spacious living room sunshine", "renovated home interior"],
  "شقتك": ["modern apartment interior", "real estate property viewing", "apartment keys close up"],
  "ملابس": ["youth clothing store", "fashion fabric close up", "streetwear outfit rack"],
  "خامات": ["fabric texture close up", "tailor checking clothing material", "clothing rack boutique"],
  "احتياطي": ["external hard drive backup", "cloud backup sync laptop", "small business files laptop"],
  "النسخ": ["external hard drive backup", "cloud storage sync laptop", "office files laptop"],
  "مشاريع": ["small business office files", "project documents on desk", "laptop file folders"],
  "سيارات": ["luxury sports car driving", "modern electric car road", "car steering wheel interior"],
  "سيارة": ["modern car highway", "sleek car exterior detail", "driving car cockpit"],
};

function extractQuotedPhrases(text: string): string[] {
  const matches: string[] = [];
  const regexes = [
    /"([^"]+)"/g,
    /'([^']+)'/g,
    /“([^”]+)”/g,
    /«([^»]+)»/g,
    /「([^」]+)」/g,
  ];

  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const phrase = match[1].trim();
      if (phrase.length > 0 && !matches.includes(phrase)) {
        matches.push(phrase);
      }
    }
  }

  return matches;
}

function extractNegativeConstraints(text: string): string[] {
  const negatives: string[] = [];
  const enPatterns = [
    /\b(?:no|without|do not include|don't include|exclude|never mention)\s+([^,.;\n]+)/gi,
  ];
  const arPatterns = [
    /(?:بدون|لا تذكر|ممنوع|لا تحط|بلا|من غير)\s+([^,.;\n]+)/gi,
  ];

  for (const pat of enPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pat.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length > 0) negatives.push(item);
    }
  }

  for (const pat of arPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pat.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length > 0) negatives.push(item);
    }
  }

  return negatives;
}

function cleanPromptDirectives(prompt: string, isAr: boolean): string {
  let cleaned = prompt;
  if (isAr) {
    cleaned = cleaned
      .replace(/^(اعمل|أنشئ|اصنع|صمم|سوي|سويلي|اكتب|عايز|عاوز|عايزين|عاوزين|عايزة|عاوزة|بدنا|نبي)\s+(فيديو|شورت|مقطع|سكريبت|إعلان|إعلاني|اعلاني|محتوى)?\s*(عن|حول|بخصوص)?/i, "")
      .replace(/فيديو\s+(مدته|طوله|بمدة)?\s*\d+\s*(ثانية|ثواني|ثوان|دقيقة)?/i, "")
      .replace(/(بدقة|بجودة)\s*(عالية|1080p|4k)?/i, "")
      .replace(/(باللهجة|لهجة)\s*(المصرية|السعودية|الخليجية|العامية)?/i, "");
  } else {
    cleaned = cleaned
      .replace(/^(create|make|generate|produce|write)\s+(a\s+)?(video|short|tiktok|reel|script|ad|commercial)?\s*(about|for|on)?/i, "")
      .replace(/(video|short)\s+(duration|length)?\s*\d+\s*(seconds|secs|sec|s)?/i, "")
      .replace(/\b(in|with)\b\s*(1080p|4k|high quality|vertical format)/i, "")
      .replace(/(style|tone)\s*:\s*\w+/i, "");
  }
  return cleaned.trim();
}

/**
 * Strips meta/orchestration instructions from a piece of text that is intended
 * to become spoken narration or on-screen text. Unlike cleanPromptDirectives
 * (which only strips from the start of the whole prompt), this function strips
 * meta wording from ANY position in the text, so individual factual-requirement
 * lines like "Create a 15 second short about green tea" become "green tea".
 *
 * This is the canonical Prompt Intent Normalization layer: it separates the
 * SUBJECT the customer wants content about from the orchestration/meta wording
 * they used to request it ("make a video", "15 seconds", "for TikTok", etc.).
 * Meta wording must NEVER appear in narration or captions.
 */
export function stripMetaInstructions(
  text: string,
  isAr: boolean,
  options: { forNarration?: boolean } = {},
): string {
  let cleaned = text.trim();
  if (!cleaned) return cleaned;

  if (isAr) {
    // Arabic meta-instruction patterns - strip from any position
    cleaned = cleaned
      .replace(/(?:اعمل|أنشئ|اصنع|صمم|سوي|سويلي|اكتب|اعملي|سوي لي|اشرح|اشرحلي|اشرح لي|اعرض)\s+(?:لي\s+)?(?:فيديو|شورت|مقطع|سكريبت|إعلان)?\s*(?:عن|حول|بخصوص|يناقش|فكرة|معنى|مفهوم)?\s*/gi, "")
      .replace(/عايز(ين|ة|ي|ى)?\s+(فيديو|شورت|مقطع|إعلان|إعلاني|اعلاني|محتوى)?\s*(عن|حول|بخصوص)?\s*/gi, "")
      .replace(/عاوز(ين|ة|ي|ى)?\s+(فيديو|شورت|مقطع|إعلان|إعلاني|اعلاني|محتوى)?\s*(عن|حول|بخصوص)?\s*/gi, "")
      .replace(/فيديو\s+(?:مدته|طوله|بمدة)?\s*\d+\s*(?:ثانية|ثواني|ثوان|ثوانى|دقيقة|دقائق)?\s*(?:عن|حول|بخصوص)?\s*/gi, "")
      .replace(/مدته?\s+\d+\s*(?:ثانية|ثواني|ثوان|ثوانى|دقيقة|دقائق)?\s*/gi, "")
      .replace(/(?:^|\s)\d+\s*(?:ثانية|ثواني|ثوان|ثوانى|دقيقة|دقائق)(?=\s|$|[,.،])/gi, " ")
      .replace(/(?:باللهجة|لهجة)\s*(?:المصرية|السعودية|الخليجية|العامية|الشامية|المغربية)?\s*/gi, "")
      .replace(/(?:بدقة|بجودة)\s*(?:عالية|1080p|4k)?\s*/gi, "")
      .replace(/(?:رأسي|عمودي|9:16|16:9)\s*/gi, "")
      .replace(/(?:ابدأ|افتح|اختم)\s+(?:بـ|ب|بجملة|بـ)?\s*/gi, "")
      .replace(/(?:الجمهور|الهدف|المستهدفين)\s*[:：]?\s*/gi, "")
      .replace(/(?:الهوك|المقدمة|الرسالة|النص|الدعوة|CTA|الكابشن|الترجمة|التعليق|المشاهد|المرئيات|الصوت)\s*[:：]\s*/gi, "");
    if (!options.forNarration) {
      // Negative-constraint instructions are stripped when cleaning PROMPT
      // text - but inside generated narration a negation is real content and
      // deleting it inverts meaning ("بدون تربة" -> "تربة").
      cleaned = cleaned.replace(/(?:ممنوع|لا تذكر|بلا)\s+/gi, "");
    }
  } else {
    // English meta-instruction patterns - strip from any position
    cleaned = cleaned
      .replace(/(?:create|make|generate|produce|write|build)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:video|short|tiktok|reel|script|ad|commercial|content|post)?\s*(?:about|for|on|of|that|which|to)?\s*/gi, "")
      .replace(/(?:video|short|tiktok|reel|content|post)\s+(?:duration|length|that's|that is|of)?\s*\d+\s*(?:seconds|secs|sec|s|minutes|mins)?\s*(?:long|duration|about|for|on|of)?\s*/gi, "")
      .replace(/\d+\s*(?:seconds|secs|sec|s)\s*(?:long|video|short|about|for|on|of)?\s*/gi, "")
      .replace(/(?:in|with)\s*(?:1080p|4k|high quality|vertical format|9:16|16:9|portrait|landscape)\s*/gi, "")
      .replace(/(?:style|tone|mood|audience|hook|CTA|voice|captions?|visuals?)\s*[:：]\s*\S+/gi, "")
      .replace(/(?:focus on|explain|mention|describe|show|cover|include|emphasize|highlight|talk about|discuss)\s+/gi, "")
      .replace(/(?:the audience is|your job is|the goal is|the purpose is|the video should|the short should)\s+/gi, "");
    if (!options.forNarration) {
      // See the Arabic branch above: negations are instructions in prompt
      // text, but real meaning inside generated narration.
      cleaned = cleaned.replace(/(?:no|without|do not include|don't include|exclude|never mention|avoid)\s+/gi, "");
    }
  }

  // Clean up extra whitespace and leading punctuation left behind
  cleaned = cleaned.replace(/^[\s,.;:،؛]+/, "").replace(/\s{2,}/g, " ").trim();

  // If stripping removed everything, return the original text rather than empty
  if (!cleaned) return text.trim();
  return cleaned;
}

function detectIntentType(prompt: string, isAr: boolean): PromptIntentContract["intentType"] {
  const lower = prompt.toLowerCase();
  if (/\b(top\s*\d+|\d+\s*tips|\d+\s*ways|\d+\s*reasons|أفضل\s*\d+|\d+\s*نصائح|\d+\s*طرق|\d+\s*أسباب)\b/i.test(prompt)) {
    return "listicle";
  }
  if (
    /\b(why|how does|how do|did you know|curious|secret behind|surprising reason)\b/i.test(lower) ||
    /(ليه|إزاي|ازاي|كيف|هل تعلم|سر|يا ترى|عارف ليه)/.test(prompt)
  ) {
    return "viral_curiosity";
  }
  if (
    /\b(explain|understand|history of|science of|guide to|tutorial|what is|how to)\b/i.test(lower) ||
    /(شرح|تعلم|دليل|تاريخ|علم|ما هو|كيفية)/.test(prompt)
  ) {
    return "explainer";
  }
  if (
    /\b(brand|tagline|product|limited offer|discount|shop now|buy|order|perfume|boutique|store|agency)\b/i.test(lower) ||
    /(ماركة|براند|منتج|متجر|شراء|اطلب|عطر|كافيه|شركة|خدماتنا)/.test(prompt)
  ) {
    return "brand_ad";
  }
  if (/\b(follow for more|subscribe|join|share)\b/i.test(lower) || /(تابعنا|اشترك|شارك)/.test(prompt)) {
    return "direct_response";
  }
  return isAr ? "brand_ad" : "educational";
}

/** Orchestration/stopword tokens that can never be part of a speakable
 *  entity ("want a video", "15 seconds ad"). A bare number is never an
 *  entity word either - "إعلاني 15" is a truncated duration, not a topic. */
const ENTITY_STOPWORD_RE =
  /^(?:اعمل|أنشئ|اصنع|صمم|سوي|سويلي|اكتب|اعرض|اشرح|عايز|عاوز|عايزين|عاوزين|عايزة|عاوزة|بدنا|نبي|فيديو|شورت|مقطع|سكريبت|إعلان|إعلاني|اعلان|اعلاني|محتوى|ثانية|ثواني|ثوان|ثوانى|دقيقة|دقائق|ث|عن|حول|بخصوص|بيناقش|ليناقش|معنى|مفهوم|قصير|قصيرة|create|make|generate|produce|write|build|video|short|tiktok|reel|script|ad|commercial|content|post|clip|about|for|on|of|a|an|the|that|which|seconds|secs|sec|minutes|mins|\d+)$/i;

function extractCoreEntity(cleanedPrompt: string, isAr: boolean): string {
  const fallback = isAr ? "الموضوع الرئيسي" : "the main subject";
  if (!cleanedPrompt) return fallback;
  const firstLine = cleanedPrompt.split(/[.\n]/)[0].trim();
  const words = firstLine
    .split(/\s+/)
    .map((w) => w.replace(/^[«»"'"'"']+|[«»"'"'"',،؛;:]+$/g, ""))
    .filter((w) => w.length > 1 && !ENTITY_STOPWORD_RE.test(w));
  if (words.length === 0) return fallback;
  return words.slice(0, 4).join(" ");
}

function deriveConcreteVisualSubjects(
  prompt: string,
  coreEntity: string,
  isAr: boolean,
): string[] {
  const subjects: string[] = [];
  const lowerPrompt = prompt.toLowerCase();

  if (isAr) {
    for (const [arKey, enTerms] of Object.entries(ARABIC_TO_ENGLISH_CONCRETE_MAP)) {
      if (prompt.includes(arKey)) {
        subjects.push(...enTerms);
      }
    }
  }

  const enKeywords: Record<string, string[]> = {
    airplane: ["airplane cabin window", "commercial aircraft flying", "airplane wings clouds sunset"],
    plane: ["airplane window view", "airplane flying", "aircraft fuselage"],
    window: ["airplane oval window", "window seat view clouds"],
    cat: ["domestic cat purring", "cat close up face whiskers", "sleeping kitten cute"],
    cats: ["cute cats playing", "cat purring close up", "domestic cat fur"],
    perfume: ["luxury perfume bottle gold", "perfume mist spray glass", "fragrance bottle elegant"],
    fragrance: ["perfume bottle glass luxury", "scent spray mist", "luxury cosmetic bottle"],
    coding: ["programmer typing code laptop", "python code on screen", "software developer desk"],
    programming: ["computer programming code screen", "developer typing keyboard", "software coding monitor"],
    python: ["python programming code monitor", "developer writing python code", "laptop code display"],
    pyramid: ["giza pyramids egypt", "ancient pyramids cairo desert", "great pyramid sunset"],
    pyramids: ["giza pyramids cairo egypt", "ancient desert pyramids", "pyramids aerial view"],
    cairo: ["cairo egypt skyline sunset", "nile river cairo", "historic cairo architecture"],
    coffee: ["espresso extraction cafe", "steaming hot coffee cup", "fresh roasted coffee beans"],
    cafe: ["modern cozy coffee shop", "barista making latte art", "coffee bar counter"],
    gym: ["athlete lifting weights gym", "modern fitness center", "fitness workout dumbbells"],
    fitness: ["athletic training gym workout", "running on treadmill", "fitness exercise close up"],
    money: ["counting dollar banknotes", "stacks of cash money", "wallet holding cash"],
    backup: ["external hard drive backup", "cloud backup sync laptop", "small business files laptop"],
    backups: ["external hard drive backup", "cloud backup sync laptop", "office file backup"],
    files: ["business documents on desk", "laptop file folders", "cloud file sync screen"],
    "small business": ["small business owner laptop", "office documents desk", "entrepreneur working laptop"],
    saving: ["piggy bank coins savings", "saving money jar", "financial budget planning"],
    invest: ["stock market graph chart", "gold bullion bars", "financial trading charts screen"],
    sky: ["bright blue sky white clouds", "sun shining clear blue sky", "time lapse blue sky fluffy clouds"],
    sun: ["bright golden sun sky", "sunlight rays atmosphere", "warm sunny daylight"],
  };

  for (const [k, terms] of Object.entries(enKeywords)) {
    if (lowerPrompt.includes(k)) {
      for (const t of terms) {
        if (!subjects.includes(t)) subjects.push(t);
      }
    }
  }

  if (subjects.length === 0) {
    const cleaned = coreEntity.replace(/["'«»]/g, "").trim();
    if (isAr) {
      subjects.push(`${cleaned} real footage`, "real everyday life action", "professional subject close up");
    } else {
      subjects.push(`${cleaned} close up`, `${cleaned} in action`, `detailed shot of ${cleaned}`);
    }
  }

  return Array.from(new Set(subjects)).slice(0, 6);
}

function extractClauseAfter(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value.replace(/[.،,;؛]+$/g, "").trim();
  }
  return undefined;
}

function extractSubjectEntities(cleanedPrompt: string, coreEntity: string): string[] {
  const entities = new Set<string>();
  entities.add(coreEntity);
  for (const quoted of extractQuotedPhrases(cleanedPrompt)) entities.add(quoted);
  const capitalized = cleanedPrompt.match(/\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3}\b/g) || [];
  for (const item of capitalized) entities.add(item.trim());
  return [...entities].filter(Boolean).slice(0, 8);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFactualRequirements(prompt: string, negatives: string[]): string[] {
  const isAr = /[\u0600-\u06FF]/.test(prompt);
  const lines = prompt
    .split(/[\n.;؟?]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let cleaned = line;
      for (const neg of negatives) {
        cleaned = cleaned
          .replace(new RegExp(`\\b(?:no|without|do not include|don't include|exclude|never mention)\\s+${escapeRegex(neg)}\\b`, "gi"), "")
          .replace(new RegExp(`(?:بدون|لا تذكر|ممنوع|لا تحط|بلا|من غير)\\s+${escapeRegex(neg)}`, "gi"), "");
      }
      return cleaned.replace(/[،,;؛\s]+$/g, "").trim();
    })
    .filter(Boolean)
    // Strip meta instructions from each factual line so narration never
    // contains "Create a 15 second short about..." or its Arabic equivalents
    .map((line) => stripMetaInstructions(line, isAr))
    .filter((line) => line.length > 0);
  return Array.from(new Set(lines)).slice(0, 8);
}

function inferLocation(prompt: string): string | undefined {
  return extractClauseAfter(prompt, [
    /\bin\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/,
    /(?:في|بال|بـ)\s*([\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{2,}){0,3})/,
  ]);
}

function inferTone(prompt: string): string | undefined {
  return extractClauseAfter(prompt, [
    /\b(?:tone|mood|style)\s*[:\-]\s*([^.;\n]+)/i,
    /\b(premium cinematic|dark luxury|simple|modern|calm|energetic)\b/i,
    /(سينمائي|فاخر|هادئ|بسيط|شبابي|عصري|عامي|مصري)/,
  ]);
}

export function buildPromptIntentContract(
  rawPrompt: string,
  options: {
    language?: "en" | "ar" | "auto";
    dialect?: ArabicDialect;
    durationSeconds?: number;
    contentStyle?: ContentStyle;
  } = {},
): PromptIntentContract {
  const prompt = rawPrompt.trim();
  const isAr =
    options.language === "ar" ||
    (options.language !== "en" && /[\u0600-\u06FF]/.test(prompt));
  const dialect = options.dialect || (isAr ? "egyptian" : "none");
  const targetDuration = options.durationSeconds || 30;

  const quoted = extractQuotedPhrases(prompt);
  const negatives = extractNegativeConstraints(prompt);
  const cleaned = cleanPromptDirectives(prompt, isAr);
  // A short quoted phrase («لمعة», "Ember & Wick") is the customer's own
  // naming of the subject - the most reliable entity signal available.
  const quotedEntity = quoted.find((q) => {
    const w = q.trim().split(/\s+/).filter(Boolean);
    return w.length >= 1 && w.length <= 4 && !ENTITY_STOPWORD_RE.test(w[0]);
  });
  const coreEntity = quotedEntity ?? extractCoreEntity(cleaned, isAr);
  const intentType = detectIntentType(prompt, isAr);
  const requestedTopic = cleaned || coreEntity;

  const hasCtaExplicit =
    /\b(call us|message us|visit|subscribe|follow|link in bio|whatsapp)\b/i.test(prompt) ||
    /(تواصل|اتصل|راسلنا|واتساب|تابعنا|زورونا|سجل)/.test(prompt);

  const ctaChannelMatch = prompt.match(/\b(whatsapp|instagram|website|phone|telegram|واتساب|انستجرام|موقعنا)\b/i);

  const concreteVisualSubjects = deriveConcreteVisualSubjects(prompt, coreEntity, isAr);

  const topicKeywords = [
    coreEntity,
    ...quoted,
    ...cleaned.split(/\s+/).filter((w) => w.length > 3).slice(0, 5),
  ].filter(Boolean);

  const estimatedSceneCount = Math.max(2, Math.min(6, Math.round(targetDuration / 6)));

  return {
    rawPrompt: prompt,
    requestedTopic,
    coreEntity,
    subjectEntities: extractSubjectEntities(cleaned, coreEntity),
    factualRequirements: extractFactualRequirements(prompt, negatives),
    explicitHook: extractClauseAfter(prompt, [/\bhook\s*[:\-]\s*([^.;\n]+)/i, /(?:الهوك|المقدمة)\s*[:\-]\s*([^.;\n]+)/i]),
    explicitMiddleMessage: extractClauseAfter(prompt, [/\b(?:middle|message)\s*[:\-]\s*([^.;\n]+)/i, /(?:الرسالة|النص)\s*[:\-]\s*([^.;\n]+)/i]),
    explicitCta: extractClauseAfter(prompt, [/\bCTA\s*[:\-]\s*([^.;\n]+)/i, /(?:الدعوة|اطلب|تابع)\s*[:\-]\s*([^.;\n]+)/i]),
    audience: extractClauseAfter(prompt, [/\bfor\s+([^.;\n]+?)\s+(?:who|that|with)\b/i, /(?:لل|لـ)\s*([\u0600-\u06FF\s]{3,})(?:\.|،|$)/]),
    tone: inferTone(prompt),
    contentType: options.contentStyle || intentType,
    location: inferLocation(prompt),
    productOrBusiness: intentType === "brand_ad" || intentType === "promotional" ? coreEntity : undefined,
    requestedDuration: targetDuration,
    visualRequirements: extractClauseAfter(prompt, [/\bvisuals?\s*[:\-]\s*([^.;\n]+)/i, /(?:مشاهد|المرئيات)\s*[:\-]\s*([^.;\n]+)/i])
      ? [extractClauseAfter(prompt, [/\bvisuals?\s*[:\-]\s*([^.;\n]+)/i, /(?:مشاهد|المرئيات)\s*[:\-]\s*([^.;\n]+)/i]) as string]
      : concreteVisualSubjects,
    voiceRequirements: extractClauseAfter(prompt, [/\bvoice\s*[:\-]\s*([^.;\n]+)/i, /(?:الصوت|التعليق)\s*[:\-]\s*([^.;\n]+)/i])
      ? [extractClauseAfter(prompt, [/\bvoice\s*[:\-]\s*([^.;\n]+)/i, /(?:الصوت|التعليق)\s*[:\-]\s*([^.;\n]+)/i]) as string]
      : [],
    captionRequirements: extractClauseAfter(prompt, [/\bcaptions?\s*[:\-]\s*([^.;\n]+)/i, /(?:الكابشن|الترجمة)\s*[:\-]\s*([^.;\n]+)/i])
      ? [extractClauseAfter(prompt, [/\bcaptions?\s*[:\-]\s*([^.;\n]+)/i, /(?:الكابشن|الترجمة)\s*[:\-]\s*([^.;\n]+)/i]) as string]
      : [],
    topicKeywords,
    intentType,
    language: isAr ? "ar" : "en",
    dialect,
    quotedPhrases: quoted,
    negativeConstraints: negatives,
    requestedExclusions: negatives,
    concreteVisualSubjects,
    forbiddenStockQueries: ABSTRACT_FORBIDDEN_TERMS,
    requestedCta: {
      required: hasCtaExplicit,
      explicitText: quoted.find((q) => q.length < 50),
      channel: ctaChannelMatch ? ctaChannelMatch[1] : undefined,
    },
    groundedFacts: quoted,
    targetDurationSeconds: targetDuration,
    estimatedSceneCount,
  };
}
