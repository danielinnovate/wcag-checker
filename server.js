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

// POST /api/lead — capture contact details + email notification
const fs = require("fs");
const nodemailer = require("nodemailer");
const LEADS_FILE = path.join(__dirname, "leads.json");

// Email transporter — uses environment variables
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
});

app.post("/api/lead", async (req, res) => {
  const { name, email, phone, website, score, issueCount, critical, serious } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ success: false, error: "Valid email is required." });
  }

  const lead = {
    name: name || "",
    email,
    phone: phone || "",
    website: website || "",
    score: score ?? null,
    issueCount: issueCount ?? null,
    critical: critical ?? 0,
    serious: serious ?? 0,
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

  console.log(`[LEAD] ${lead.name} <${lead.email}> — ${lead.website} — Score: ${lead.score} — Type: ${req.body.type || "unknown"}`);

  // Add to Brevo (Sendinblue) if API key is configured
  if (process.env.BREVO_API_KEY) {
    try {
      const brevoRes = await fetch("https://api.brevo.com/v3/contacts", {
        method: "POST",
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: lead.email,
          attributes: {
            FIRSTNAME: lead.name.split(" ")[0] || "",
            LASTNAME: lead.name.split(" ").slice(1).join(" ") || "",
            WEBSITE: lead.website,
            WCAG_SCORE: lead.score,
            ISSUE_COUNT: lead.issueCount,
            CRITICAL_COUNT: lead.critical,
            SERIOUS_COUNT: lead.serious,
            LEAD_TYPE: req.body.type || "general",
            PHONE: lead.phone,
          },
          listIds: process.env.BREVO_LIST_ID ? [parseInt(process.env.BREVO_LIST_ID)] : [],
          updateEnabled: true,
        }),
      });
      if (!brevoRes.ok) {
        console.error("[BREVO] Error:", await brevoRes.text());
      }
    } catch (err) {
      console.error("[BREVO] Failed:", err.message);
    }
  }

  // Send email notification
  if (process.env.SMTP_USER) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: "daniel@innovateagency.co.nz",
        subject: `New WCAG Lead: ${lead.website} (Score: ${lead.score}/100)`,
        html: `
          <h2>New Accessibility Lead</h2>
          <table style="border-collapse:collapse;font-family:sans-serif;">
            <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">${lead.name}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;"><a href="mailto:${lead.email}">${lead.email}</a></td></tr>
            ${lead.phone ? `<tr><td style="padding:8px;font-weight:bold;">Phone:</td><td style="padding:8px;">${lead.phone}</td></tr>` : ""}
            <tr><td style="padding:8px;font-weight:bold;">Website:</td><td style="padding:8px;"><a href="${lead.website}">${lead.website}</a></td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Score:</td><td style="padding:8px;">${lead.score}/100</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Issues:</td><td style="padding:8px;">${lead.issueCount} total (${lead.critical} critical, ${lead.serious} serious)</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Date:</td><td style="padding:8px;">${new Date(lead.date).toLocaleString()}</td></tr>
          </table>
          <p style="margin-top:16px;"><a href="https://wcag.innovateagency.co.nz/#url=${encodeURIComponent(lead.website)}">View their scan results</a></p>
        `,
      });
    } catch (err) {
      console.error("[EMAIL] Failed to send notification:", err.message);
    }
  }

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
