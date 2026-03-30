(function () {
  "use strict";

  // ── Constants ─────────────────────────────────────
  const SEV_COLORS = { critical: "#dc2626", serious: "#ea580c", moderate: "#ca8a04", minor: "#2563eb" };
  const SEV_LABELS = { critical: "Critical", serious: "Serious", moderate: "Moderate", minor: "Minor" };
  const CAT_LABELS = {
    images: "Images", links: "Links", forms: "Forms", contrast: "Contrast",
    structure: "Structure", aria: "ARIA", tables: "Tables", other: "Other",
  };
  const CIRCUMFERENCE = 339.292;
  const HISTORY_KEY = "wcag-checker-history";
  const MAX_HISTORY = 10;

  // ── DOM refs ──────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const heroEl = $("#hero");
  const loadingEl = $("#loading");
  const resultsEl = $("#results");
  const scanForm = $("#scan-form");
  const urlInput = $("#url-input");
  const formError = $("#form-error");
  const loadingText = $("#loading-text");
  const loadingUrl = $("#loading-url");
  const cancelBtn = $("#cancel-btn");
  const backBtn = $("#back-btn");
  const topbarScanForm = $("#topbar-scan-form");
  const topbarUrlInput = $("#topbar-url-input");
  const downloadBtn = $("#download-btn");
  const viewToggle = $("#view-toggle");
  const expandAllBtn = $("#expand-all-btn");
  const progressArc = $("#progress-arc");
  const progressPercent = $("#progress-percent");
  const historySection = $("#history-section");
  const historyList = $("#history-list");

  // ── State ─────────────────────────────────────────
  let abortController = null;
  let currentData = null;
  let activeFilters = { severity: "all", category: "all" };
  let groupedView = false;
  let allExpanded = false;
  let loadingInterval = null;
  let progressValue = 0;
  let progressTarget = 0;
  let progressRAF = null;
  let reportUnlocked = false;
  const FREE_ISSUES_SHOWN = 3;

  // ── View switching ────────────────────────────────
  function showView(view) {
    heroEl.classList.toggle("active", view === "hero");
    loadingEl.classList.toggle("active", view === "loading");
    resultsEl.classList.toggle("active", view === "results");
    window.scrollTo(0, 0);
  }

  // ── History ───────────────────────────────────────
  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch { return []; }
  }

  function saveToHistory(data) {
    const history = getHistory();
    // Remove existing entry for same URL
    const filtered = history.filter((h) => h.url !== data.url);
    filtered.unshift({
      url: data.url,
      score: data.score,
      total: data.summary.total,
      date: data.scannedAt,
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(filtered.slice(0, MAX_HISTORY)));
  }

  function renderHistory() {
    const history = getHistory();
    if (history.length === 0) {
      historySection.hidden = true;
      return;
    }
    historySection.hidden = false;
    historyList.innerHTML = history.map((h) => {
      const scoreColor = h.score >= 80 ? "#16a34a" : h.score >= 50 ? "#ca8a04" : "#dc2626";
      const date = new Date(h.date).toLocaleDateString();
      return `
        <div class="history-item" data-url="${escapeAttr(h.url)}">
          <span class="history-item-url">${escapeHtml(h.url.replace(/^https?:\/\//, ""))}</span>
          <div class="history-item-meta">
            <span class="history-score" style="background:${scoreColor}20;color:${scoreColor}">${h.score}/100</span>
            <span class="history-date">${date}</span>
          </div>
        </div>`;
    }).join("") + `<button class="history-clear" id="history-clear-btn">Clear history</button>`;

    historyList.querySelectorAll(".history-item").forEach((el) => {
      el.addEventListener("click", () => {
        urlInput.value = el.dataset.url;
        scanForm.dispatchEvent(new Event("submit"));
      });
    });

    const clearBtn = $("#history-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        localStorage.removeItem(HISTORY_KEY);
        renderHistory();
      });
    }
  }

  // ── Progress bar ──────────────────────────────────
  const LOADING_TEXTS = [
    { at: 10, text: "Loading page..." },
    { at: 30, text: "Waiting for resources..." },
    { at: 50, text: "Running accessibility checks..." },
    { at: 70, text: "Analyzing WCAG compliance..." },
    { at: 85, text: "Generating report..." },
  ];

  function startProgress() {
    progressValue = 0;
    updateProgressUI(0);
    loadingText.textContent = LOADING_TEXTS[0].text;
    let lastTextIdx = 0;

    function tick() {
      // Continuously creep toward 95% — fast at first, slowing down
      const remaining = 95 - progressValue;
      progressValue += remaining * 0.003;
      updateProgressUI(progressValue);

      // Update text at thresholds
      for (let i = lastTextIdx + 1; i < LOADING_TEXTS.length; i++) {
        if (progressValue >= LOADING_TEXTS[i].at) {
          loadingText.textContent = LOADING_TEXTS[i].text;
          lastTextIdx = i;
        }
      }

      progressRAF = requestAnimationFrame(tick);
    }
    progressRAF = requestAnimationFrame(tick);
  }

  function stopProgress() {
    cancelAnimationFrame(progressRAF);
    updateProgressUI(100);
  }

  function updateProgressUI(pct) {
    const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;
    progressArc.setAttribute("stroke-dashoffset", offset);
    progressPercent.textContent = Math.round(pct) + "%";
  }

  // ── URL hash / sharing ────────────────────────────
  function setUrlHash(url) {
    history.replaceState(null, "", "#url=" + encodeURIComponent(url));
  }

  function clearUrlHash() {
    history.replaceState(null, "", window.location.pathname);
  }

  function getUrlFromHash() {
    const hash = window.location.hash;
    if (hash.startsWith("#url=")) {
      return decodeURIComponent(hash.slice(5));
    }
    return null;
  }

  // ── Scan function ─────────────────────────────────
  async function doScan(url) {
    formError.hidden = true;

    // Normalize
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }
    try { new URL(url); } catch {
      formError.textContent = "Please enter a valid URL.";
      formError.hidden = false;
      showView("hero");
      return;
    }

    showView("loading");
    loadingUrl.textContent = url;
    startProgress();

    abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 65000);

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: abortController.signal,
      });
      clearTimeout(timeout);
      const data = await res.json();
      stopProgress();

      if (!data.success) {
        showError(data.error || "Scan failed.", url);
        return;
      }

      currentData = data;
      saveToHistory(data);
      setUrlHash(data.url);
      renderResults(data);
      showView("results");
    } catch (err) {
      clearTimeout(timeout);
      stopProgress();
      if (err.name === "AbortError") {
        showView("hero");
        return;
      }
      showError("Could not connect to the server. Please try again.", url);
    }
  }

  // ── Form handlers ─────────────────────────────────
  scanForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (url) doScan(url);
  });

  topbarScanForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = topbarUrlInput.value.trim();
    if (url) doScan(url);
  });

  cancelBtn.addEventListener("click", () => {
    if (abortController) abortController.abort();
    stopProgress();
    showView("hero");
  });

  backBtn.addEventListener("click", () => {
    clearUrlHash();
    renderHistory();
    showView("hero");
    urlInput.focus();
  });

  // ── Download report as colored Excel ─────────────
  const SEV_BG = { critical: "#fecaca", serious: "#fed7aa", moderate: "#fef08a", minor: "#bfdbfe" };
  const SEV_FG = { critical: "#991b1b", serious: "#9a3412", moderate: "#854d0e", minor: "#1e40af" };

  downloadBtn.addEventListener("click", () => {
    if (!currentData) return;
    const headers = ["Severity", "Category", "WCAG Criteria", "Description", "Help", "Element HTML", "Selector", "Fix Suggestion"];

    let tableHTML = `<table>
      <tr>${headers.map((h) => `<th style="background:#0d9488;color:#fff;font-weight:bold;padding:6px 10px;border:1px solid #ccc;">${esc(h)}</th>`).join("")}</tr>`;

    (currentData.issues || []).forEach((issue) => {
      const wcag = (issue.wcag || []).join("; ");
      const bg = SEV_BG[issue.severity] || "#fff";
      const fg = SEV_FG[issue.severity] || "#000";
      const sevStyle = `background:${bg};color:${fg};font-weight:bold;`;
      const rowStyle = `border:1px solid #ddd;padding:4px 8px;vertical-align:top;`;

      const makeRow = (node) => {
        return `<tr>
          <td style="${sevStyle}${rowStyle}">${esc(issue.severity)}</td>
          <td style="${rowStyle}">${esc(issue.category)}</td>
          <td style="${rowStyle}">${esc(wcag)}</td>
          <td style="${rowStyle}">${esc(issue.description)}</td>
          <td style="${rowStyle}">${esc(issue.help || "")}</td>
          <td style="${rowStyle}font-family:monospace;font-size:11px;">${esc(node ? node.html || "" : "")}</td>
          <td style="${rowStyle}font-family:monospace;font-size:11px;">${esc(node ? node.selector || "" : "")}</td>
          <td style="${rowStyle}">${esc(node ? node.fix || "" : "")}</td>
        </tr>`;
      };

      if (issue.nodes && issue.nodes.length > 0) {
        issue.nodes.forEach((node) => { tableHTML += makeRow(node); });
      } else {
        tableHTML += makeRow(null);
      }
    });

    // Summary row
    const s = currentData.summary;
    tableHTML += `<tr><td colspan="8" style="padding:10px;border:1px solid #ddd;font-weight:bold;background:#f0fdfa;">
      Score: ${currentData.score}/100 &mdash; Critical: ${s.critical} | Serious: ${s.serious} | Moderate: ${s.moderate} | Minor: ${s.minor} | Passed: ${s.passes}
    </td></tr>`;
    tableHTML += "</table>";

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
      <head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
      <x:Name>WCAG Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
      </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
      <body>${tableHTML}</body></html>`;

    const blob = new Blob([html], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const host = new URL(currentData.url).hostname.replace(/\./g, "_");
    a.href = url;
    a.download = `wcag-report-${host}-${new Date().toISOString().slice(0, 10)}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  });

  function esc(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── View toggle (flat vs grouped) ─────────────────
  viewToggle.addEventListener("click", () => {
    groupedView = !groupedView;
    viewToggle.classList.toggle("active", groupedView);
    viewToggle.querySelector("span").textContent = groupedView ? "Ungroup" : "Group";
    if (currentData) renderIssues(currentData);
  });

  // ── Expand / Collapse all ─────────────────────────
  expandAllBtn.addEventListener("click", () => {
    allExpanded = !allExpanded;
    expandAllBtn.querySelector("span").textContent = allExpanded ? "Collapse All" : "Expand All";
    expandAllBtn.querySelector("svg").style.transform = allExpanded ? "rotate(180deg)" : "";
    const cards = resultsEl.querySelectorAll(".issue-card");
    cards.forEach((c) => c.classList.toggle("expanded", allExpanded));
  });

  // ── Error display ─────────────────────────────────
  function showError(message, url) {
    showView("results");
    const header = $("#results-header");
    header.innerHTML = "";
    const toolbar = $("#toolbar");
    toolbar.style.display = "none";
    const issuesList = $("#issues-list");
    issuesList.innerHTML = `
      <div class="error-result">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <h3>Scan Failed</h3>
        <p>${escapeHtml(message)}</p>
      </div>`;
    topbarUrlInput.value = url;
  }

  // ── Render results ────────────────────────────────
  function renderResults(data) {
    const toolbar = $("#toolbar");
    toolbar.style.display = "";

    // Reset state
    activeFilters = { severity: "all", category: "all" };
    allExpanded = false;
    groupedView = false;
    expandAllBtn.querySelector("span").textContent = "Expand All";
    expandAllBtn.querySelector("svg").style.transform = "";
    viewToggle.classList.remove("active");
    viewToggle.querySelector("span").textContent = "Group";
    topbarUrlInput.value = data.url;

    // Rebuild header
    const header = $("#results-header");
    header.innerHTML = `
      <div class="print-header"><h1>WCAG Accessibility Report</h1><p>${escapeHtml(data.url)} &middot; ${new Date(data.scannedAt).toLocaleString()}</p></div>
      <div class="score-section">
        <div class="screenshot-wrap" id="screenshot-wrap"></div>
        <div class="score-wrap">
          <div class="score-circle">
            <svg viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="54" fill="none" stroke="#e0e0e0" stroke-width="10"/>
              <circle id="score-ring" cx="60" cy="60" r="54" fill="none" stroke="#4caf50" stroke-width="10"
                stroke-dasharray="339.292" stroke-dashoffset="339.292" stroke-linecap="round"
                transform="rotate(-90 60 60)"/>
            </svg>
            <div class="score-value" id="score-value">0</div>
            <div class="score-label">/ 100</div>
          </div>
          <div class="score-grade" id="score-grade"></div>
        </div>
        <div class="scanned-info">
          <div class="scanned-url">${escapeHtml(data.url)}</div>
          <div class="scanned-date">Scanned ${new Date(data.scannedAt).toLocaleString()} &middot; ${(data.scanDuration / 1000).toFixed(1)}s</div>
        </div>
      </div>
      <div class="summary-chips" id="summary-chips"></div>`;

    // Scan time in topbar
    const scanTimeEl = $("#scan-time");
    scanTimeEl.textContent = `${(data.scanDuration / 1000).toFixed(1)}s`;

    // Screenshot
    const ssWrap = header.querySelector("#screenshot-wrap");
    if (data.screenshot) {
      ssWrap.innerHTML = `<img src="${data.screenshot}" alt="Screenshot of ${escapeAttr(data.url)}">`;
    }

    // Score animation
    const ring = header.querySelector("#score-ring");
    const valEl = header.querySelector("#score-value");
    const gradeEl = header.querySelector("#score-grade");
    const scoreColor = data.score >= 80 ? "#16a34a" : data.score >= 50 ? "#ca8a04" : "#dc2626";
    const grade = data.score >= 90 ? "Excellent" : data.score >= 80 ? "Good" : data.score >= 60 ? "Fair" : data.score >= 40 ? "Poor" : "Very Poor";

    ring.style.stroke = scoreColor;
    gradeEl.style.color = scoreColor;
    gradeEl.textContent = grade;

    let current = 0;
    const step = Math.max(1, Math.round(data.score / 40));
    const anim = setInterval(() => {
      current = Math.min(current + step, data.score);
      valEl.textContent = current;
      const offset = CIRCUMFERENCE - (current / 100) * CIRCUMFERENCE;
      ring.setAttribute("stroke-dashoffset", offset);
      if (current >= data.score) clearInterval(anim);
    }, 20);

    // Summary chips
    const chipsEl = header.querySelector("#summary-chips");
    const { summary } = data;
    chipsEl.innerHTML = ["critical", "serious", "moderate", "minor"]
      .map((sev) =>
        `<div class="summary-chip" style="background:${SEV_COLORS[sev]}">
          <span class="chip-count">${summary[sev] || 0}</span> ${SEV_LABELS[sev]}
        </div>`)
      .join("") +
      `<div class="summary-chip" style="background:#16a34a">
        <span class="chip-count">${summary.passes || 0}</span> Passed
      </div>`;

    reportUnlocked = false;
    renderFilters(data);
    renderIssues(data);
  }

  // ── Filters ───────────────────────────────────────
  function renderFilters(data) {
    const sevGroup = $("#severity-filters");
    const catGroup = $("#category-filters");

    // Severity
    const sevs = ["all", "critical", "serious", "moderate", "minor"];
    sevGroup.innerHTML = sevs
      .map((s) => `<button class="filter-btn ${s === activeFilters.severity ? "active" : ""}" data-sev="${s}">${s === "all" ? "All" : SEV_LABELS[s]}</button>`)
      .join("");

    sevGroup.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeFilters.severity = btn.dataset.sev;
        renderFilters(data);
        renderIssues(data);
      });
    });

    // Categories
    const cats = ["all", ...Object.keys(data.categories || {}).sort()];
    catGroup.innerHTML = cats
      .map((c) => {
        const count = c === "all" ? "" : ` (${data.categories[c]})`;
        return `<button class="filter-btn ${c === activeFilters.category ? "active" : ""}" data-cat="${c}">${c === "all" ? "All" : (CAT_LABELS[c] || c)}${count}</button>`;
      })
      .join("");

    catGroup.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeFilters.category = btn.dataset.cat;
        renderFilters(data);
        renderIssues(data);
      });
    });
  }

  // ── Issues ────────────────────────────────────────
  function renderIssues(data) {
    const issuesList = $("#issues-list");
    let issues = data.issues || [];

    if (activeFilters.severity !== "all") {
      issues = issues.filter((i) => i.severity === activeFilters.severity);
    }
    if (activeFilters.category !== "all") {
      issues = issues.filter((i) => i.category === activeFilters.category);
    }

    if (issues.length === 0) {
      issuesList.innerHTML = `
        <div class="no-issues">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l2.5 2.5L16 9"/></svg>
          <h3>${activeFilters.severity === "all" && activeFilters.category === "all" ? "No issues found!" : "No matching issues"}</h3>
          <p>Automated checks passed. Manual review is still recommended for full compliance.</p>
        </div>`;
      return;
    }

    let html = "";

    if (reportUnlocked) {
      // Full report — all issues visible
      html = issues.map((issue, idx) => issueCardHTML(issue, idx)).join("");
    } else {
      // Gated — show first N issues, then gate + CTA
      const freeIssues = issues.slice(0, FREE_ISSUES_SHOWN);
      const lockedCount = issues.length - FREE_ISSUES_SHOWN;

      html = freeIssues.map((issue, idx) => issueCardHTML(issue, idx)).join("");

      if (lockedCount > 0) {
        html += getGateHTML(data, lockedCount);
      }

      // Always show the pricing/risk CTA
      html += getRiskCTAHTML(data);
    }

    issuesList.innerHTML = html;

    // Re-apply expand state
    if (allExpanded) {
      issuesList.querySelectorAll(".issue-card").forEach((c) => c.classList.add("expanded"));
    }

    // Toggle expand on click
    issuesList.querySelectorAll(".issue-header").forEach((header) => {
      header.addEventListener("click", () => {
        header.closest(".issue-card").classList.toggle("expanded");
      });
    });

    // Wire up email gate form
    const gateForm = issuesList.querySelector("#gate-form");
    if (gateForm) {
      gateForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = gateForm.querySelector("button");
        const emailVal = gateForm.querySelector("#gate-email").value.trim();
        btn.disabled = true;
        btn.textContent = "Unlocking...";
        try {
          await fetch("/api/lead", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "",
              email: emailVal,
              phone: "",
              website: data.url,
              score: data.score,
              issueCount: data.summary.total,
              critical: data.summary.critical,
              serious: data.summary.serious,
              type: "report_unlock",
            }),
          });
          reportUnlocked = true;
          renderIssues(data);
        } catch (_) {
          btn.disabled = false;
          btn.textContent = "Unlock full report";
        }
      });
    }

    // Wire up fix quote form
    const fixForm = issuesList.querySelector("#fix-form");
    if (fixForm) {
      fixForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = fixForm.querySelector("button");
        const btnText = btn.textContent;
        const nameVal = fixForm.querySelector("#fix-name").value.trim();
        const emailVal = fixForm.querySelector("#fix-email").value.trim();
        const phoneVal = fixForm.querySelector("#fix-phone")?.value.trim() || "";
        btn.disabled = true;
        btn.textContent = "Sending...";
        try {
          await fetch("/api/lead", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: nameVal,
              email: emailVal,
              phone: phoneVal,
              website: data.url,
              score: data.score,
              issueCount: data.summary.total,
              critical: data.summary.critical,
              serious: data.summary.serious,
              type: "fix_quote",
            }),
          });
          fixForm.parentElement.innerHTML = `
            <div class="cta-success-box">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l2.5 2.5L16 9"/></svg>
              <div>
                <p class="cta-success-title">Quote request received!</p>
                <p class="cta-success-text">We'll review your scan results and send a detailed fixed-price quote within 24 hours.</p>
              </div>
            </div>`;
        } catch (_) {
          btn.disabled = false;
          btn.textContent = btnText;
        }
      });
    }
  }

  // ── Email gate (between free issues and locked issues) ──
  function getGateHTML(data, lockedCount) {
    return `
      <div class="gate-section">
        <div class="gate-blur">
          <div class="gate-fake-card"></div>
          <div class="gate-fake-card"></div>
          <div class="gate-fake-card"></div>
        </div>
        <div class="gate-overlay">
          <div class="gate-lock">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          </div>
          <h3 class="gate-title">Your site has ${data.summary.total} accessibility violations</h3>
          <p class="gate-subtitle">${lockedCount} more issue${lockedCount !== 1 ? "s" : ""} not shown. Enter your email to unlock the full report with every violation and exactly how to fix each one.</p>
          <form class="gate-form" id="gate-form">
            <input type="email" id="gate-email" placeholder="Enter your email address" class="gate-input" required>
            <button type="submit" class="gate-btn">Unlock full report</button>
          </form>
          <p class="gate-fine">No spam. Just your report.</p>
        </div>
      </div>`;
  }

  // ── Risk context + pricing CTA ──────────────────────
  function getRiskCTAHTML(data) {
    const s = data.summary;
    const total = s.total;

    // Pricing tier based on violation count
    let tier, price, tierDesc;
    if (total <= 15) {
      tier = "Starter";
      price = "$1,500 USD";
      tierDesc = "Up to 15 violations";
    } else if (total <= 50) {
      tier = "Standard";
      price = "$2,500 USD";
      tierDesc = "Up to 50 violations";
    } else {
      tier = "Comprehensive";
      price = "Custom quote";
      tierDesc = "50+ violations";
    }

    let urgencyClass;
    if (data.score < 50) urgencyClass = "cta-urgent";
    else if (data.score < 80) urgencyClass = "cta-warning";
    else urgencyClass = "cta-good";

    return `
      <div class="risk-cta ${urgencyClass}">
        <div class="risk-cta-left">
          <h3 class="risk-headline">Don't let accessibility issues become a legal problem</h3>
          <div class="risk-stats">
            <div class="risk-stat">
              <span class="risk-stat-value">4,600+</span>
              <span class="risk-stat-label">ADA lawsuits filed in 2024</span>
            </div>
            <div class="risk-stat">
              <span class="risk-stat-value">$25,000+</span>
              <span class="risk-stat-label">Average settlement cost</span>
            </div>
            <div class="risk-stat">
              <span class="risk-stat-value">${total}</span>
              <span class="risk-stat-label">Violations on your site</span>
            </div>
          </div>
          <ul class="risk-bullets">
            <li>We fix <strong>every issue</strong> found in your scan — no partial fixes</li>
            <li><strong>Fixed price</strong> — no hourly rates, no scope creep</li>
            <li>Done within <strong>5 business days</strong></li>
            <li>Includes a <strong>re-scan</strong> to verify everything passes</li>
          </ul>
        </div>
        <div class="risk-cta-right">
          <div class="pricing-card">
            <div class="pricing-tier">${tier}</div>
            <div class="pricing-price">${price}</div>
            <div class="pricing-desc">${tierDesc}</div>
            <div class="pricing-includes">
              <div>All ${total} violations fixed</div>
              <div>Compliance report included</div>
              <div>30-day support</div>
            </div>
          </div>
          <form class="fix-form" id="fix-form">
            <input type="text" id="fix-name" placeholder="Your name" class="fix-input" required>
            <input type="email" id="fix-email" placeholder="Email address" class="fix-input" required>
            <input type="tel" id="fix-phone" placeholder="Phone (optional)" class="fix-input fix-input-optional">
            <button type="submit" class="fix-btn">Get your free quote</button>
          </form>
          <p class="fix-disclaimer">Free, no-obligation quote within 24 hours</p>
        </div>
      </div>`;
  }

  function issueCardHTML(issue, idx) {
    const wcagTags = (issue.wcag || [])
      .map((w) => `<span class="tag tag-wcag">WCAG ${w}</span>`)
      .join("");

    const nodeCards = (issue.nodes || [])
      .map((n) => `
        <div class="node-item">
          ${n.html ? `<div class="node-html">${escapeHtml(n.html)}</div>` : ""}
          ${n.selector ? `<div class="node-selector">${escapeHtml(n.selector)}</div>` : ""}
          ${n.fix ? `<div class="node-fix">${escapeHtml(n.fix)}</div>` : ""}
        </div>`)
      .join("");

    return `
      <div class="issue-card" data-idx="${idx}">
        <div class="issue-header">
          <span class="sev-dot" style="background:${SEV_COLORS[issue.severity]}"></span>
          <div class="issue-meta">
            <div class="issue-tags">
              <span class="tag tag-sev" style="background:${SEV_COLORS[issue.severity]}">${SEV_LABELS[issue.severity]}</span>
              ${wcagTags}
              <span class="tag tag-cat">${CAT_LABELS[issue.category] || issue.category}</span>
            </div>
            <div class="issue-desc">${escapeHtml(issue.description)}</div>
          </div>
          <svg class="issue-toggle" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="issue-details">
          <div class="issue-help">
            ${escapeHtml(issue.help || "")}
            ${issue.helpUrl ? ` <a href="${escapeHtml(issue.helpUrl)}" target="_blank" rel="noopener">Learn more</a>` : ""}
          </div>
          <div class="node-count">${(issue.nodes || []).length} element${(issue.nodes || []).length !== 1 ? "s" : ""} affected:</div>
          ${nodeCards}
        </div>
      </div>`;
  }

  // ── Helpers ───────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Init ──────────────────────────────────────────
  function init() {
    renderHistory();

    // Check for URL in hash
    const hashUrl = getUrlFromHash();
    if (hashUrl) {
      urlInput.value = hashUrl;
      doScan(hashUrl);
    } else {
      showView("hero");
    }
  }

  init();
})();
