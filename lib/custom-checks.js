/**
 * Custom accessibility checks that supplement axe-core.
 * Each function runs inside page.evaluate() — no Node APIs available.
 */

function runCustomChecks() {
  const issues = [];

  function add(id, severity, wcag, category, description, help, nodes) {
    issues.push({ id, severity, wcag, category, description, help, nodes });
  }

  // 1. Missing lang attribute
  const lang = document.documentElement.getAttribute("lang");
  if (!lang || !lang.trim()) {
    add(
      "html-lang-missing",
      "serious",
      ["3.1.1"],
      "structure",
      "Page is missing a lang attribute on <html>",
      'Add a lang attribute to <html>, e.g., <html lang="en">.',
      [{ html: "<html>", selector: "html", fix: 'Add lang="en" (or appropriate language code) to the <html> element.' }]
    );
  }

  // 2. Missing page title
  if (!document.title || !document.title.trim()) {
    add(
      "page-title-missing",
      "serious",
      ["2.4.2"],
      "structure",
      "Page is missing a <title>",
      "Add a descriptive <title> element inside <head>.",
      [{ html: "<head>...</head>", selector: "head", fix: "Add a <title> element with descriptive page title." }]
    );
  }

  // 3. Skip navigation link
  const skipSelectors = [
    'a[href="#main"]', 'a[href="#content"]', 'a[href="#maincontent"]',
    'a[href="#main-content"]', 'a[href="#skip"]', '[class*="skip"]'
  ];
  const hasSkipLink = skipSelectors.some((s) => document.querySelector(s));
  const linkCount = document.querySelectorAll("a[href]").length;
  if (!hasSkipLink && linkCount > 5) {
    add(
      "skip-nav-missing",
      "moderate",
      ["2.4.1"],
      "structure",
      "No skip navigation link found",
      'Add a "Skip to main content" link as the first focusable element on the page.',
      [{ html: "<body>", selector: "body", fix: 'Add <a href="#main" class="skip-link">Skip to main content</a> as the first child of <body>.' }]
    );
  }

  // 4. Meta viewport disabling zoom
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) {
    const content = (viewport.getAttribute("content") || "").toLowerCase();
    const disablesZoom =
      content.includes("user-scalable=no") ||
      content.includes("user-scalable=0") ||
      /maximum-scale\s*=\s*(1|1\.0)\b/.test(content);
    if (disablesZoom) {
      add(
        "meta-viewport-zoom",
        "critical",
        ["1.4.4"],
        "structure",
        "Viewport meta tag disables user zoom/scaling",
        "Remove user-scalable=no and ensure maximum-scale is at least 5.",
        [{ html: viewport.outerHTML, selector: 'meta[name="viewport"]', fix: "Remove user-scalable=no and set maximum-scale to 5 or higher." }]
      );
    }
  }

  // 5. Missing main landmark
  const hasMain = document.querySelector("main, [role='main']");
  if (!hasMain) {
    add(
      "main-landmark-missing",
      "moderate",
      ["1.3.1"],
      "structure",
      "Page has no <main> landmark",
      "Wrap the primary page content in a <main> element.",
      [{ html: "<body>", selector: "body", fix: "Add a <main> element around the primary content area." }]
    );
  }

  // 6. Auto-playing media
  document.querySelectorAll("video, audio").forEach((media) => {
    if (media.autoplay) {
      add(
        "media-autoplay",
        "serious",
        ["1.4.2"],
        "other",
        "Media element has autoplay enabled",
        "Remove autoplay or provide controls to pause/stop/mute the media.",
        [{ html: media.outerHTML.slice(0, 200), selector: media.tagName.toLowerCase(), fix: "Remove the autoplay attribute or add controls for the user." }]
      );
    }
  });

  // 7. Links opening in new window without warning
  document.querySelectorAll('a[target="_blank"]').forEach((a) => {
    const text = (a.textContent || "").toLowerCase() + (a.getAttribute("aria-label") || "").toLowerCase();
    const warned = text.includes("new window") || text.includes("new tab") || text.includes("external") ||
      a.querySelector(".sr-only, .visually-hidden");
    if (!warned) {
      add(
        "link-new-window-no-warning",
        "minor",
        ["3.2.5"],
        "links",
        'Link opens in new window (target="_blank") without warning',
        "Add screen-reader text or aria-label indicating the link opens in a new window.",
        [{ html: a.outerHTML.slice(0, 200), selector: a.id ? "#" + a.id : "a[target='_blank']", fix: 'Add "(opens in new tab)" text or an aria-label to inform users.' }]
      );
    }
  });

  // 8. Duplicate IDs
  const idCounts = {};
  document.querySelectorAll("[id]").forEach((el) => {
    const id = el.id;
    if (id) idCounts[id] = (idCounts[id] || 0) + 1;
  });
  const dupes = Object.entries(idCounts).filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    dupes.slice(0, 10).forEach(([id, count]) => {
      add(
        "duplicate-id-custom",
        "moderate",
        ["4.1.1"],
        "structure",
        `Duplicate id="${id}" found ${count} times`,
        "IDs must be unique. Duplicate IDs break label associations and ARIA references.",
        [{ html: `[id="${id}"]`, selector: `#${id}`, fix: `Make the id="${id}" unique across the page.` }]
      );
    });
  }

  return issues;
}

module.exports = { runCustomChecks };
