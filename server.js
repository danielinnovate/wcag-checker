const express = require("express");
const path = require("path");
const { scanUrl, closeBrowser } = require("./lib/scanner");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Rate limiting (in-memory, per IP) ───────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 5; // max scans per minute per IP

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const timestamps = rateLimitMap.get(ip).filter((t) => now - t < RATE_LIMIT_WINDOW);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW - now) / 1000);
    return res.status(429).json({
      success: false,
      error: `Too many requests. Please wait ${retryAfter} seconds before scanning again.`,
      errorCode: "RATE_LIMITED",
    });
  }

  timestamps.push(now);
  next();
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    const active = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
    if (active.length === 0) {
      rateLimitMap.delete(ip);
    } else {
      rateLimitMap.set(ip, active);
    }
  }
}, 5 * 60 * 1000);

// Concurrency limiter
let activeScans = 0;
const MAX_CONCURRENT = 2;

// POST /api/scan
app.post("/api/scan", rateLimit, async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ success: false, error: "URL is required.", errorCode: "INVALID_URL" });
  }

  // Normalize URL
  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = "https://" + normalizedUrl;
  }

  // Validate URL
  try {
    new URL(normalizedUrl);
  } catch {
    return res.status(400).json({ success: false, error: "Invalid URL format.", errorCode: "INVALID_URL" });
  }

  // Block localhost / private IPs
  const hostname = new URL(normalizedUrl).hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.16.") ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  ) {
    return res.status(400).json({ success: false, error: "Cannot scan local or private addresses.", errorCode: "BLOCKED_URL" });
  }

  // Concurrency check
  if (activeScans >= MAX_CONCURRENT) {
    return res.status(503).json({ success: false, error: "Server is busy. Please try again in a moment.", errorCode: "BUSY" });
  }

  activeScans++;

  // Overall timeout
  const timeout = setTimeout(() => {
    activeScans = Math.max(0, activeScans - 1);
    if (!res.headersSent) {
      res.status(504).json({ success: false, error: "Scan timed out. The page may be too slow or complex.", errorCode: "TIMEOUT" });
    }
  }, 60000);

  try {
    const result = await scanUrl(normalizedUrl);
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.json(result);
    }
  } catch (err) {
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: "An unexpected error occurred.", errorCode: "SERVER_ERROR" });
    }
  } finally {
    activeScans = Math.max(0, activeScans - 1);
  }
});

// POST /api/lead — capture contact details
const fs = require("fs");
const LEADS_FILE = path.join(__dirname, "leads.json");

app.post("/api/lead", (req, res) => {
  const { name, email, website, score, issueCount } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ success: false, error: "Valid email is required." });
  }

  const lead = {
    name: name || "",
    email,
    website: website || "",
    score: score ?? null,
    issueCount: issueCount ?? null,
    date: new Date().toISOString(),
  };

  // Append to leads file
  let leads = [];
  try {
    if (fs.existsSync(LEADS_FILE)) {
      leads = JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
    }
  } catch (_) {}
  leads.push(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));

  console.log(`[LEAD] ${lead.name} <${lead.email}> — ${lead.website} — Score: ${lead.score}`);

  res.json({ success: true });
});

// GET /api/leads — view all leads (basic auth)
app.get("/api/leads", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== "Bearer wcag-admin-2024") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const leads = JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
    res.json(leads);
  } catch (_) {
    res.json([]);
  }
});

app.listen(PORT, () => {
  console.log(`WCAG Checker running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});
