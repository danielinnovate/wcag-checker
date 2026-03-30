const puppeteer = require("puppeteer");
const path = require("path");
const { runCustomChecks } = require("./custom-checks");

const AXE_SOURCE = path.resolve(require.resolve("axe-core"), "..", "axe.min.js");

// ── Persistent browser instance ────────────────────
let browserInstance = null;
let browserLaunchPromise = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--js-flags=--max-old-space-size=256",
    ],
  });

  browserInstance = await browserLaunchPromise;
  browserLaunchPromise = null;

  browserInstance.on("disconnected", () => { browserInstance = null; });
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (_) {}
    browserInstance = null;
  }
}

// ── Blocked domains (tracking, analytics, ads) ─────
const BLOCKED_DOMAINS = [
  "google-analytics.com", "googletagmanager.com", "googlesyndication.com",
  "doubleclick.net", "facebook.net", "facebook.com/tr",
  "hotjar.com", "clarity.ms", "segment.io", "segment.com",
  "klaviyo.com", "mailchimp.com", "hubspot.com",
  "tiktok.com", "snapchat.com", "pinterest.com/ct",
  "monorail-edge.shopifysvc.com", "bat.bing.com", "ads.linkedin.com",
  "sentry.io", "newrelic.com", "nr-data.net",
  "intercom.io", "zendesk.com", "drift.com",
  "cdn.judge.me", "loox.io", "stamped.io",
];

// Map axe rule IDs to human-friendly categories
const CATEGORY_MAP = {
  "image-alt": "images",
  "image-redundant-alt": "images",
  "input-image-alt": "images",
  "role-img-alt": "images",
  "svg-img-alt": "images",
  "link-name": "links",
  "link-in-text-block": "links",
  "label": "forms",
  "label-title-only": "forms",
  "input-button-name": "forms",
  "select-name": "forms",
  "autocomplete-valid": "forms",
  "color-contrast": "contrast",
  "color-contrast-enhanced": "contrast",
  "heading-order": "structure",
  "document-title": "structure",
  "html-has-lang": "structure",
  "html-lang-valid": "structure",
  "html-xml-lang-mismatch": "structure",
  "landmark-banner-is-top-level": "structure",
  "landmark-complementary-is-top-level": "structure",
  "landmark-contentinfo-is-top-level": "structure",
  "landmark-main-is-top-level": "structure",
  "landmark-no-duplicate-banner": "structure",
  "landmark-no-duplicate-contentinfo": "structure",
  "landmark-no-duplicate-main": "structure",
  "landmark-one-main": "structure",
  "landmark-unique": "structure",
  "page-has-heading-one": "structure",
  "region": "structure",
  "bypass": "structure",
  "meta-viewport": "structure",
  "meta-viewport-large": "structure",
  "frame-title": "structure",
  "frame-title-unique": "structure",
  "table-duplicate-name": "tables",
  "td-headers-attr": "tables",
  "th-has-data-cells": "tables",
  "scope-attr-valid": "tables",
};

function categorize(ruleId) {
  if (CATEGORY_MAP[ruleId]) return CATEGORY_MAP[ruleId];
  if (ruleId.startsWith("aria")) return "aria";
  if (ruleId.includes("link")) return "links";
  if (ruleId.includes("image") || ruleId.includes("img")) return "images";
  if (ruleId.includes("label") || ruleId.includes("input") || ruleId.includes("form")) return "forms";
  if (ruleId.includes("color") || ruleId.includes("contrast")) return "contrast";
  return "other";
}

const SEVERITY_WEIGHTS = { critical: 10, serious: 5, moderate: 2, minor: 1 };

function calculateScore(violations, passCount) {
  // Base score from pass ratio (worth 70% of total)
  const totalRules = passCount + violations.length;
  const passRatio = totalRules > 0 ? passCount / totalRules : 1;
  const baseScore = passRatio * 70;

  // Penalty from severity (worth up to 30 points)
  let penalty = 0;
  for (const v of violations) {
    const weight = SEVERITY_WEIGHTS[v.severity] || 1;
    penalty += weight;
  }
  // Cap penalty at 30, scale so ~15 weighted points = full 30pt penalty
  const severityScore = Math.max(0, 30 - (penalty / 15) * 30);

  return Math.max(0, Math.min(100, Math.round(baseScore + severityScore)));
}

async function scanUrl(url) {
  const startTime = Date.now();
  let page;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set realistic browser fingerprint
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1024, height: 576 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    // Block heavy resources not needed for accessibility checks
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const reqUrl = req.url();

      // Block resource types not needed for a11y
      if (['image', 'media', 'video', 'audio', 'font', 'texttrack'].includes(type)) {
        return req.abort();
      }

      // Block known tracking/analytics domains
      if (BLOCKED_DOMAINS.some(domain => reqUrl.includes(domain))) {
        return req.abort();
      }

      req.continue();
    });

    // Navigate with hard timeout
    await page.goto(url, { timeout: 20000, waitUntil: "domcontentloaded" });

    // Wait for network to mostly settle — short and aggressive
    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
    } catch (_) {
      // Proceed regardless
    }

    // Inject and run axe-core
    await page.addScriptTag({ path: AXE_SOURCE });

    const axeResults = await Promise.race([
      page.evaluate(async () => {
        if (typeof axe === "undefined") return { violations: [], passes: [] };
        const results = await axe.run(document, {
          resultTypes: ["violations", "passes"],
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
          },
        });
        return {
          violations: results.violations,
          passes: results.passes,
        };
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("axe-core timeout")), 20000)),
    ]);

    // Run custom checks
    const customResults = await page.evaluate(runCustomChecks);

    // Get page screenshot (small, low quality)
    const screenshot = await page.screenshot({
      encoding: "base64",
      type: "jpeg",
      quality: 35,
      clip: { x: 0, y: 0, width: 1024, height: 576 },
    });

    await page.close();
    page = null;

    // Normalize axe results
    const axeIssues = axeResults.violations.map((v) => ({
      id: v.id,
      severity: v.impact || "moderate",
      wcag: (v.tags || [])
        .filter((t) => t.startsWith("wcag"))
        .map((t) => {
          const m = t.match(/wcag(\d)(\d)(\d+)/);
          return m ? `${m[1]}.${m[2]}.${m[3]}` : t;
        }),
      category: categorize(v.id),
      description: v.description || v.help,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 10).map((n) => ({
        html: (n.html || "").slice(0, 300),
        selector: Array.isArray(n.target) ? n.target.join(" > ") : String(n.target || ""),
        fix: n.failureSummary || "",
      })),
    }));

    // Merge custom issues (skip if axe already covers them)
    const axeIds = new Set(axeIssues.map((i) => i.id));
    const customIssues = customResults
      .filter((i) => !axeIds.has(i.id))
      .map((i) => ({
        ...i,
        helpUrl: null,
      }));

    const allIssues = [...axeIssues, ...customIssues];

    // Sort by severity
    const sevOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    allIssues.sort((a, b) => (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4));

    // Summary counts
    const summary = { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0, passes: axeResults.passes.length };
    allIssues.forEach((i) => {
      summary[i.severity] = (summary[i.severity] || 0) + 1;
      summary.total++;
    });

    // Category counts
    const categories = {};
    allIssues.forEach((i) => {
      categories[i.category] = (categories[i.category] || 0) + 1;
    });

    const score = calculateScore(allIssues, axeResults.passes.length);
    const scanDuration = Date.now() - startTime;

    return {
      success: true,
      url,
      scannedAt: new Date().toISOString(),
      scanDuration,
      score,
      screenshot: `data:image/jpeg;base64,${screenshot}`,
      summary,
      issues: allIssues,
      categories,
    };
  } catch (err) {
    if (page) {
      try { await page.close(); } catch (_) {}
    }

    const message = err.message || String(err);
    let errorCode = "SCAN_FAILED";
    let userMessage = "An error occurred while scanning the page.";

    if (message.includes("ERR_NAME_NOT_RESOLVED")) {
      errorCode = "DNS_FAILED";
      userMessage = "Could not resolve the domain. Please check the URL and try again.";
    } else if (message.includes("ERR_CONNECTION_REFUSED")) {
      errorCode = "CONNECTION_REFUSED";
      userMessage = "Connection was refused by the server.";
    } else if (message.includes("ERR_CONNECTION_TIMED_OUT") || message.includes("timeout")) {
      errorCode = "TIMEOUT";
      userMessage = "The page took too long to load. It may be down or very slow.";
    } else if (message.includes("ERR_CERT") || message.includes("SSL")) {
      errorCode = "SSL_ERROR";
      userMessage = "The site has an SSL/certificate error.";
    } else if (message.includes("net::")) {
      errorCode = "NETWORK_ERROR";
      userMessage = "A network error occurred. The site may be unreachable.";
    }

    return {
      success: false,
      url,
      error: userMessage,
      errorCode,
      detail: message,
    };
  }
}

module.exports = { scanUrl, closeBrowser };
