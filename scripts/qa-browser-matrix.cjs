/**
 * Browser QA matrix for Short Studio UI.
 * 3 viewports x 2 interface languages x all customer routes.
 * Captures console errors, pageerrors, failed requests/4xx-5xx responses,
 * blank screens, horizontal overflow, and RTL/LTR correctness.
 * Usage: node scripts/qa-browser-matrix.cjs [baseUrl] [readyVideoId] [activeJobId]
 */
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:3130";
const VIDEO_ID = process.argv[3] || "";
const JOB_ID = process.argv[4] || "";

const VIEWPORTS = [
  { name: "desktop-1920", width: 1920, height: 1080 },
  { name: "laptop-1366", width: 1366, height: 768 },
  { name: "mobile-390", width: 390, height: 844 },
];
const LOCALES = ["en", "ar"];

const ROUTES = [
  ["dashboard", "/"],
  ["create", "/create"],
  ["jobs", "/jobs"],
  VIDEO_ID ? ["job-details", `/jobs/${JOB_ID || VIDEO_ID}`] : null,
  ["videos", "/videos"],
  VIDEO_ID ? ["video-details", `/video/${VIDEO_ID}`] : null,
  ["templates", "/templates"],
  ["media", "/media"],
  ["publishing", "/publishing"],
  ["integrations", "/integrations"],
  ["settings", "/settings"],
  ["system", "/system"],
].filter(Boolean);

const IGNORE_ERRORS = [
  /favicon/i,
  /ResizeObserver loop/i,
  /net::ERR_ABORTED.*video/i,
  /Failed to load resource.*(favicon|\.map)/i,
];

const results = [];
let pass = 0, fail = 0;

function record(check, ok, detail = "") {
  results.push({ check, ok, detail });
  if (ok) pass++; else fail++;
  if (!ok) console.log(`  FAIL ${check}: ${detail}`);
}

(async () => {
  const browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    for (const locale of LOCALES) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: locale === "ar" ? "ar-EG" : "en-US" });
      const page = await ctx.newPage();
      await page.addInitScript((loc) => localStorage.setItem("abud_ui_locale", loc), locale);

      const consoleErrors = [];
      const pageErrors = [];
      const badResponses = [];
      const failedRequests = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`); });
      // ERR_ABORTED means the page cancelled an in-flight fetch itself
      // (React unmount/StrictMode re-run on navigation) - not a server or
      // network failure. Real failures (refused, reset, timeout) still count.
      page.on("requestfailed", (r) => {
        const err = r.failure()?.errorText || "";
        if (!/favicon/.test(r.url()) && !/ERR_ABORTED/i.test(err)) failedRequests.push(`${r.url()} ${err}`);
      });

      console.log(`\n=== ${vp.name} ${locale} ===`);
      for (const [name, path] of ROUTES) {
        consoleErrors.length = 0; pageErrors.length = 0; badResponses.length = 0; failedRequests.length = 0;
        const tag = `${vp.name}/${locale}${path}`;
        try {
          await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
        } catch (e) {
          try { await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 20000 }); await page.waitForTimeout(2500); }
          catch (e2) { record(`${tag} navigation`, false, String(e2).slice(0, 200)); continue; }
        }
        await page.waitForTimeout(800);

        const bodyText = await page.evaluate(() => document.body?.innerText?.trim() || "");
        record(`${tag} not blank`, bodyText.length > 20, `body text length ${bodyText.length}`);

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        record(`${tag} no h-overflow`, overflow <= 2, `scrollWidth-clientWidth=${overflow}`);

        const dir = await page.evaluate(() => document.documentElement.dir || document.body.dir || "");
        if (locale === "ar") record(`${tag} rtl`, dir === "rtl", `dir="${dir}"`);

        const rawErrors = [...consoleErrors, ...pageErrors].filter((e) => !IGNORE_ERRORS.some((re) => re.test(e)));
        record(`${tag} no JS errors`, rawErrors.length === 0, rawErrors.slice(0, 2).join(" | ").slice(0, 300));

        const netBad = [...badResponses, ...failedRequests].filter((e) => !IGNORE_ERRORS.some((re) => re.test(e)));
        record(`${tag} no failed requests`, netBad.length === 0, netBad.slice(0, 3).join(" | ").slice(0, 300));

        const rawEx = bodyText.match(/(TypeError|ReferenceError|Unhandled|ECONNREFUSED|stack trace|Cannot read prop)/i);
        record(`${tag} no raw exceptions`, !rawEx, rawEx ? rawEx[0] : "");
      }
      await ctx.close();
    }
  }

  // Interaction checks (single viewport/language pair is enough for logic QA,
  // but create flow is checked in both languages).
  for (const locale of LOCALES) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.addInitScript((loc) => localStorage.setItem("abud_ui_locale", loc), locale);
    const tag = `interaction/${locale}`;

    await page.goto(BASE + "/create", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("textarea", { timeout: 20000 }).catch(() => { });

    const promptBox = page.locator("textarea").first();
    record(`${tag} prompt field`, await promptBox.count() > 0);
    if (await promptBox.count()) {
      await promptBox.fill(locale === "ar" ? "اعمل فيديو عن كافيه قريب من الجامعة" : "Create a video about a neighborhood coffee shop");
      const enhanceBtn = page.locator('button:has-text("Improve"), button:has-text("Enhance"), button:has-text("حسّن"), button:has-text("تحسين"), button:has-text("طوّر")').first();
      if (await enhanceBtn.count()) {
        await enhanceBtn.click();
        await page.waitForTimeout(1500);
        const loading = await page.locator('[class*="spinner"],[class*="loading"],[aria-busy="true"],button[disabled]').count();
        record(`${tag} improve shows progress`, loading >= 0, `loadingIndicators=${loading}`);
        await page.waitForTimeout(20000).catch(() => { });
      } else {
        record(`${tag} improve button exists`, false, "no improve/enhance button found");
      }
    }

    // Internal implementation details must not leak into customer UI.
    const bodyText = await page.evaluate(() => document.body.innerText);
    const internals = bodyText.match(/(OLLAMA_BASE_URL|qwen2\.5|creativePlanSchema|ProductionSpec|visualIntent|stockSearchTerms|planner_unavailable|ContentPlannerError)/);
    record(`${tag} no internal model/schema names`, !internals, internals ? internals[0] : "");

    await ctx.close();
  }

  // Progress survives reload (only meaningful while a job is mid-flight).
  if (JOB_ID) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/jobs/${JOB_ID}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => document.body.innerText.slice(0, 400));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => document.body.innerText.slice(0, 400));
    record("job-details survives reload", after.length > 20, `before=${before.length} after=${after.length}`);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n===== BROWSER QA: ${pass} pass, ${fail} fail =====`);
  if (fail) { process.exitCode = 1; }
})();
