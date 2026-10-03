/**
 * MIXED-LANGUAGE QUALITY GUARD
 * ----------------------------
 * Egyptian/Arabic scripts legitimately mix in established English technical
 * vocabulary - "الـ API بيعمل cache" is natural spoken Egyptian. What is not
 * natural is a small model drifting into broken code-switching: an English
 * clause glued inside an Arabic sentence, a term said twice in both
 * languages, model meta-commentary, or a whole scene accidentally written in
 * the wrong language.
 *
 * This guard runs on planner output before the ProductionSpec is assembled.
 * It normalizes mechanically (dedupe, punctuation, meta stripping) and
 * DETECTS language damage it cannot safely repair - it never rewrites
 * factual meaning. A scene whose narration is genuinely in the wrong
 * language is reported so the caller can substitute a safe deterministic
 * line rather than narrate broken output.
 */

export type LanguageIssue =
  /** Model commentary leaked into the copy ("نص التعليق:", "Scene 1:"). */
  | "meta_commentary"
  /** The same term said twice, in either or both languages ("cache كاش"). */
  | "duplicated_term"
  /** An English clause embedded inside Arabic-dominant narration. */
  | "broken_code_switching"
  /** Most of the line is in a different language than the production spec. */
  | "accidental_language_switch"
  /** Doubled punctuation, spacing around punctuation, stray markdown. */
  | "malformed_punctuation"
  /** A garbled transliteration was normalized to the established loan form. */
  | "loanword_normalized"
  /** Non-Arabic/non-Latin script leaked (e.g. CJK meta-commentary from the model). */
  | "foreign_script_leak"
  /** Arabic and Latin glued into one token ("وشining") where the Latin part is not a tech term. */
  | "mixed_script_token";

export type LanguageQualityResult = {
  /** Mechanically normalized text; meaning is never rewritten. */
  text: string;
  issues: LanguageIssue[];
  /** True when the line should be replaced by a safe deterministic fallback. */
  unusable: boolean;
};

/** Established technical/loan vocabulary that belongs in Egyptian speech. */
const TECH_TERMS = new Set([
  "api", "apis", "http", "https", "json", "xml", "sdk", "docker", "github",
  "gitlab", "python", "javascript", "typescript", "node", "nodejs", "react",
  "angular", "vue", "css", "html", "sql", "nosql", "redis", "kafka",
  "kubernetes", "k8s", "backend", "frontend", "server", "servers", "database",
  "cache", "caching", "cached", "cloud", "aws", "gcp", "azure", "ui", "ux",
  "ai", "ml", "llm", "seo", "crm", "erp", "qr", "url", "uri", "ram", "cpu",
  "gpu", "ssd", "ios", "android", "windows", "linux", "mac", "macos", "pdf",
  "csv", "mp4", "mp3", "usb", "wifi", "vpn", "dns", "tcp", "udp", "ip",
  "ssl", "tls", "oauth", "jwt", "rest", "graphql", "npm", "git", "devops",
  "ci", "cd", "ide", "saas", "b2b", "b2c", "faq", "dm", "app", "apps",
  "email", "online", "offline", "video", "audio", "logo", "digital", "tech",
  "software", "hardware", "code", "coding", "data", "bug", "debug", "deploy",
  "build", "link", "file", "folder", "screen", "mobile", "web", "website",
  "site", "blog", "shop", "store", "token", "crypto", "blockchain", "vr",
  "hd", "fps", "gps", "sim", "sms", "os", "pc", "laptop", "computer",
  "internet", "bluetooth", "camera", "charger", "battery", "keyboard",
  "tablet", "smart", "pro", "max", "lite", "version", "update", "download",
  "upload", "install", "login", "password", "username", "account", "profile",
  "settings", "backup", "restore", "sync", "search", "play", "pause",
  "stream", "streaming", "podcast", "hashtag", "viral", "reels", "tiktok",
  "youtube", "instagram", "facebook", "whatsapp", "telegram", "twitter",
  "linkedin", "google", "apple", "samsung", "iphone", "ipad", "excel",
  "zoom", "teams", "slack", "figma", "photoshop", "wordpress", "woocommerce",
  "shopify", "stripe", "paypal", "visa", "mastercard", "uber", "google maps",
  "gateway", "load", "balancer", "traffic", "latency", "request", "response",
  "endpoint", "route", "routing", "proxy", "middleware", "microservice",
  "microservices", "cluster", "container", "containers", "instance",
  "deployment", "pipeline", "workflow", "queue", "message", "broker",
  "socket", "websocket", "protocol", "framework", "library", "package",
  "module", "component", "widget", "plugin", "extension", "template",
  "theme", "layout", "responsive", "dynamic", "static", "runtime", "client",
  "user", "users", "admin", "dashboard", "analytics", "monitor", "logs",
  "notification", "push", "pull", "fetch", "post", "patch", "query",
  "mutation", "schema", "model", "models", "index", "shard", "replica",
  "snapshot", "backup", "failover", "uptime", "downtime", "firewall",
  "security", "encryption", "decryption", "signature", "certificate",
  "domain", "subdomain", "host", "hosting", "cdn", "edge", "origin",
  "bandwidth", "throughput", "scalability", "scaling", "horizontal",
  "vertical", "session", "cookie", "header", "payload", "webhook",
  "callback", "timeout", "retry", "rate", "limit", "throttle", "quota",
  "memory", "storage", "disk", "network", "adapter", "driver", "kernel",
  "process", "thread", "async", "sync", "await", "promise", "callback",
]);

/** English function words; a run of these is a clause, not a loanword. */
const FUNCTION_WORDS = new Set([
  "the", "a", "an", "and", "or", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "for", "with", "that", "this", "it", "its",
  "you", "your", "we", "our", "they", "their", "he", "she", "i", "can",
  "could", "will", "would", "should", "must", "not", "no", "do", "does",
  "did", "have", "has", "had", "but", "so", "if", "then", "than", "when",
  "how", "what", "why", "who", "which", "because", "very", "really", "just",
  "also", "only", "more", "most", "much", "many", "all", "every", "some",
  "get", "gets", "make", "makes", "take", "takes", "keep", "keeps", "let",
  "see", "look", "know", "think", "want", "need", "like", "love", "use",
  "way", "time", "now", "always", "never", "fast", "faster", "slow",
  "quickly", "helps", "help", "means", "saves", "save", "makes", "works",
]);

/**
 * Adjacent duplicated terms. The Arabic loan form and its established
 * English technical term both appear -> keep ONE (the English term, which
 * is the form Egyptian speech actually uses for technology). Plain
 * duplicated words ("cache cache") collapse to a single occurrence.
 */
// \b is ASCII-only and does not boundary-match Arabic, so pair boundaries
// use whitespace/punctuation lookarounds instead.
const W_START = "(^|[\\s(\\[«\"“'‘])";
const W_END = "(?=\\s|$|[,.،؛!؟?:：)\\]»\"”'’])";
const PAIR = (alts: string) =>
  new RegExp(`${W_START}(?:${alts})\\s+(?:${alts})${W_END}`, "gi");

const LOANWORD_PAIRS: Array<[RegExp, string]> = [
  [PAIR("cache|كاش|كاشنج"), "$1cache"],
  [PAIR("server|سيرفر|سيرفير|سيرفرات"), "$1server"],
  [PAIR("backend|باك ?إند|باكند"), "$1backend"],
  [PAIR("frontend|فرونت ?إند|فرونتند"), "$1frontend"],
  [PAIR("cloud|كلاود|الكلاود"), "$1cloud"],
  [PAIR("data|داتا|الداتا"), "$1data"],
  [PAIR("app|application|أبليكيشن|ابليكيشن|تطبيق"), "$1app"],
  [PAIR("api|إيه بي آي|ايه بي اي"), "$1API"],
  [PAIR("video|فيديو"), "$1video"],
];

/**
 * Garbled standalone transliterations the model produces when it cannot
 * decide between Arabic script and the English term. These normalize to the
 * loan form Egyptians actually use (or the English term itself). Established
 * loan forms like "كاش" and "سيرفر" are deliberately left alone.
 */
const LOANWORD_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/(^|\s)البيكيند(?=\s|$|[,.،؛!؟?])/g, "$1الباك إند"],
  [/(^|\s)بيكيند(?=\s|$|[,.،؛!؟?])/g, "$1باك إند"],
  [/(^|\s)الفر?وند(?=\s|$|[,.،؛!؟?])/g, "$1الفرونت إند"],
  [/(^|\s)فر?وند(?=\s|$|[,.،؛!؟?])/g, "$1فرونت إند"],
  [/(^|\s)ال[إا]يه بي [إا]ي(?=\s|$|[,.،؛!؟?])/g, "$1API"],
];

/** Clear model/meta prefixes that must never be spoken. */
const META_PREFIX = /^(?:(?:here(?:'s| is)(?: the)?|the|this is the)\s+)?(?:narration|scene copy|voice ?over|script|on[- ]screen text|scene\s*\d+|shot\s*\d+|caption|التعليق(?: الصوتي)?|نص التعليق|المشهد(?: الأول| الثاني| الثالث)?|السيناريو|ملاحظة|تعليق|بالطبع)\s*[:：؛\-–—]\s*/i;

const ARABIC_RE = /[\u0600-\u06FF]/;
const LATIN_RE = /[a-zA-Z]/;

/**
 * Letters outside Arabic/Latin are never legitimate narration for this
 * product: a small model occasionally leaks CJK/Cyrillic/kana meta-commentary
 * ("我将稍作调整") mid-field. Digits and punctuation are untouched; this only
 * matches letter ranges.
 */
const FOREIGN_SCRIPT_RE =
  /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\u30A0-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0900-\u097F\u0E00-\u0E7F\u0590-\u05FF\u10A0-\u10FF]/;

function stripMetaCommentary(text: string): { text: string; stripped: boolean } {
  let out = text;
  let stripped = false;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(META_PREFIX, "");
    if (next === out) break;
    out = next;
    stripped = true;
  }
  // Trailing parenthetical meta notes are commentary, not narration.
  const beforeTail = out;
  out = out.replace(/\s*\((?:note|ملاحظة|تعليق)[^)]*\)\s*$/i, "");
  return { text: out.trim(), stripped: stripped || out !== beforeTail };
}

function normalizePunctuation(text: string): { text: string; changed: boolean } {
  let out = text;
  // CJK/ideographic punctuation occasionally leaks from model output.
  out = out.replace(/。/g, ".").replace(/、/g, ", ").replace(/，/g, ", ");
  // Stray markdown/code-fence tokens are never spoken narration.
  out = out.replace(/`{1,3}[\w-]*/g, "").replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\.{2,}/g, "…");
  out = out.replace(/([!؟?،,؛;:：])\s*\1+/g, "$1");
  out = out.replace(/\s+([.!؟?،,؛;:：%])/g, "$1");
  out = out.replace(/([("“«])\s+/g, "$1").replace(/\s+([)"”»])/g, "$1");
  out = out.replace(/\s{2,}/g, " ");
  return { text: out.trim(), changed: out !== text };
}

function dedupeTerms(text: string): { text: string; changed: boolean } {
  let out = text;
  for (const [pattern, replacement] of LOANWORD_PAIRS) {
    out = out.replace(pattern, replacement);
  }
  // Identical adjacent words in either script ("cache cache", "جدا جدا").
  out = out.replace(
    /(^|\s)([^\s\u0600-\u06FF]{2,}|[\u0600-\u06FF]{2,})\s+\2(?=\s|$|[,.،؛!؟?])/g,
    "$1$2",
  );
  return { text: out, changed: out !== text };
}

type LatinRun = { tokens: string[] };

function latinRuns(text: string): LatinRun[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const runs: LatinRun[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (bare && LATIN_RE.test(bare) && !ARABIC_RE.test(bare)) {
      current.push(bare.toLowerCase());
    } else {
      if (current.length) runs.push({ tokens: current });
      current = [];
    }
  }
  if (current.length) runs.push({ tokens: current });
  return runs;
}

/**
 * A Latin run is natural when it is one or two loanwords, or a cluster of
 * established technical terms ("API gateway"). It is broken code-switching
 * when it reads as an English clause: three or more tokens where function
 * words appear, or where most tokens are not established terms.
 */
function isBrokenRun(run: LatinRun): boolean {
  if (run.tokens.length < 3) return false;
  const hasFunction = run.tokens.some((token) => FUNCTION_WORDS.has(token));
  const known = run.tokens.filter(
    (token) => TECH_TERMS.has(token) || FUNCTION_WORDS.has(token) || /^\d/.test(token),
  ).length;
  return hasFunction || known / run.tokens.length < 0.6;
}

export function analyzeNarrationLanguage(
  text: string,
  expectedLanguage: "ar" | "en",
): LanguageQualityResult {
  const issues = new Set<LanguageIssue>();

  const meta = stripMetaCommentary(text);
  if (meta.stripped) issues.add("meta_commentary");

  const punct = normalizePunctuation(meta.text);
  if (punct.changed) issues.add("malformed_punctuation");

  const deduped = dedupeTerms(punct.text);
  if (deduped.changed) issues.add("duplicated_term");

  let loaned = deduped.text;
  for (const [pattern, replacement] of LOANWORD_NORMALIZATIONS) {
    loaned = loaned.replace(pattern, replacement);
  }
  if (loaned !== deduped.text) issues.add("loanword_normalized");

  const normalized = loaned;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const latinCount = tokens.filter((t) => LATIN_RE.test(t) && !ARABIC_RE.test(t)).length;
  const arabicCount = tokens.filter((t) => ARABIC_RE.test(t)).length;
  const total = Math.max(1, tokens.length);

  let unusable = false;
  if (FOREIGN_SCRIPT_RE.test(normalized)) {
    issues.add("foreign_script_leak");
    unusable = true;
  }
  // Mixed-script single tokens: "وAPI" or "بالdocker" is natural Egyptian;
  // "وشining" is model corruption because "shining" is not an established
  // loanword. Such lines cannot be safely repaired - the glued token carries
  // the sentence's content word - so the whole line is unusable.
  for (const token of normalized.split(/\s+/)) {
    const latinParts = token.match(/[a-zA-Z]{2,}/g) || [];
    if (latinParts.length === 0 || !ARABIC_RE.test(token)) continue;
    if (!latinParts.every((part) => TECH_TERMS.has(part.toLowerCase()))) {
      issues.add("mixed_script_token");
      unusable = true;
      break;
    }
  }
  if (expectedLanguage === "ar") {
    if (latinCount / total > 0.55 && tokens.length >= 4) {
      issues.add("accidental_language_switch");
      unusable = true;
    }
    if (latinRuns(normalized).some(isBrokenRun)) {
      issues.add("broken_code_switching");
    }
  } else {
    if (arabicCount / total > 0.3 && tokens.length >= 4) {
      issues.add("accidental_language_switch");
      unusable = true;
    }
  }

  return {
    text: normalized,
    issues: Array.from(issues),
    unusable,
  };
}

/** Per-production summary persisted on spec metadata. */
export type LanguageQualityReport = {
  scenesChecked: number;
  normalizedCount: number;
  replacedCount: number;
  issues: Array<{ sceneIndex: number; flags: LanguageIssue[] }>;
};

export function buildLanguageQualityReport(
  results: Array<{ sceneIndex: number; result: LanguageQualityResult }>,
): LanguageQualityReport {
  return {
    scenesChecked: results.length,
    normalizedCount: results.filter(
      (entry) => entry.result.text && entry.result.issues.length > 0 && !entry.result.unusable,
    ).length,
    replacedCount: results.filter((entry) => entry.result.unusable).length,
    issues: results
      .filter((entry) => entry.result.issues.length > 0)
      .map((entry) => ({ sceneIndex: entry.sceneIndex, flags: entry.result.issues })),
  };
}
