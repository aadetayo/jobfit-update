// Analytics engine for tracking JobFit adoption, user funnels, and feature usage.
// Stores ONLY 100% genuine real-time events. No simulated or mock data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const ANALYTICS_FILE = path.join(DATA_DIR, "analytics.json");

let events = [];
let saveTimeout = null;

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load real events on initialization (filtering out any previous seed data)
try {
  if (fs.existsSync(ANALYTICS_FILE)) {
    const raw = fs.readFileSync(ANALYTICS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      events = parsed.filter(e => e && !String(e.id || "").startsWith("ev_seed_"));
    }
  }
} catch (err) {
  console.error("Error reading analytics file:", err);
  events = [];
}
persistNow();

function persistNow() {
  try {
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(events, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing analytics file:", err);
  }
}

function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(persistNow, 1200);
}

// Track a real live event
export function trackEvent({ event, properties = {}, sessionId = null, visitorId = null, ip = "anonymous" }) {
  if (!event || typeof event !== "string") return null;

  const evObj = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    event,
    visitorId: visitorId || sessionId || "anon_user",
    sessionId: sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    properties: {
      ...properties,
      ip: ip !== "unknown" ? ip : undefined
    }
  };

  events.push(evObj);
  scheduleSave();
  return evObj;
}

// Generate comprehensive summary insights from real live data
export function getSummary(period = "30d") {
  const now = Date.now();
  let cutoff = 0;
  if (period === "7d") cutoff = now - (7 * 24 * 60 * 60 * 1000);
  else if (period === "30d") cutoff = now - (30 * 24 * 60 * 60 * 1000);

  const filtered = cutoff > 0 ? events.filter(e => e.timestamp >= cutoff) : [...events];

  // Group by session and by user (distinct real person)
  const sessions = new Map();
  const users = new Map(); // visitorId -> Set of sessionIds

  for (const e of filtered) {
    const sId = e.sessionId || "unknown_session";
    const uId = e.visitorId || sId;

    if (!sessions.has(sId)) {
      sessions.set(sId, []);
    }
    sessions.get(sId).push(e);

    if (!users.has(uId)) {
      users.set(uId, new Set());
    }
    users.get(uId).add(sId);
  }

  const totalPeople = users.size;
  const totalSessions = sessions.size;

  // Returning users: real people who returned across > 1 session
  let returningPeopleCount = 0;
  for (const [_uId, sessSet] of users) {
    if (sessSet.size > 1) returningPeopleCount++;
  }
  const returningRate = totalPeople > 0 ? Math.round((returningPeopleCount / totalPeople) * 100) : 0;

  let inputCount = 0;
  let checkCount = 0;
  let engagedCount = 0;
  let exportCount = 0;

  // Track unique real people at each step
  const peopleInput = new Set();
  const peopleChecked = new Set();
  const peopleEngaged = new Set();
  const peopleExported = new Set();

  let totalFitScore = 0;
  let fitScoreCount = 0;
  const scoreBuckets = { low: 0, mid: 0, high: 0 }; // <60, 60-79, 80+
  const domainsCount = {};
  const exportFormats = { docx: 0, pdf: 0, summary_report: 0 };

  let acceptAllClicks = 0;
  let individualBulletAccepts = 0;
  let voiceContexts = 0;
  let roadmapGenerations = 0;
  let roadmapViews = 0;

  for (const [sessId, evList] of sessions) {
    const uId = evList[0]?.visitorId || sessId;
    const hasInput = evList.some(e => e.event === "resume_and_job_entered");
    const fitCheck = evList.find(e => e.event === "fit_check_completed");
    const hasEngaged = evList.some(e =>
      e.event === "bullet_tab_viewed" ||
      e.event === "bullet_accepted" ||
      e.event === "accept_all_rewrites_clicked" ||
      e.event === "roadmap_viewed"
    );
    const hasExport = evList.some(e => e.event === "export_downloaded");

    if (hasInput) {
      inputCount++;
      peopleInput.add(uId);
    }
    if (fitCheck) {
      checkCount++;
      peopleChecked.add(uId);
      const score = fitCheck.properties?.fitScore || 70;
      totalFitScore += score;
      fitScoreCount++;

      if (score < 60) scoreBuckets.low++;
      else if (score < 80) scoreBuckets.mid++;
      else scoreBuckets.high++;

      const domain = fitCheck.properties?.domain || "General";
      domainsCount[domain] = (domainsCount[domain] || 0) + 1;
    }
    if (hasEngaged) {
      engagedCount++;
      peopleEngaged.add(uId);
    }
    if (hasExport) {
      exportCount++;
      peopleExported.add(uId);
    }

    for (const e of evList) {
      if (e.event === "export_downloaded") {
        const fmt = e.properties?.format || "pdf";
        exportFormats[fmt] = (exportFormats[fmt] || 0) + 1;
      }
      if (e.event === "accept_all_rewrites_clicked") acceptAllClicks++;
      if (e.event === "bullet_accepted") individualBulletAccepts++;
      if (e.event === "bullet_context_added" && e.properties?.isVoice) voiceContexts++;
      if (e.event === "roadmap_ai_plan_generated") roadmapGenerations++;
      if (e.event === "roadmap_viewed") roadmapViews++;
    }
  }

  const avgFitScore = fitScoreCount > 0 ? Math.round(totalFitScore / fitScoreCount) : 0;
  const polishRate = checkCount > 0 ? Math.round(((acceptAllClicks + individualBulletAccepts > 0 ? engagedCount : 0) / checkCount) * 100) : 0;
  const exportRate = checkCount > 0 ? Math.round((exportCount / checkCount) * 100) : 0;

  // Funnel steps (tracked both by unique real people and total visits)
  const funnel = [
    { step: 1, label: "Landed on JobFit", people: totalPeople, count: totalSessions, percent: 100 },
    { step: 2, label: "Loaded Resume & Job", people: peopleInput.size, count: inputCount, percent: totalPeople > 0 ? Math.round((peopleInput.size / totalPeople) * 100) : 0 },
    { step: 3, label: "Calculated Fit Score", people: peopleChecked.size, count: checkCount, percent: totalPeople > 0 ? Math.round((peopleChecked.size / totalPeople) * 100) : 0 },
    { step: 4, label: "Refined Bullets / Plan", people: peopleEngaged.size, count: engagedCount, percent: totalPeople > 0 ? Math.round((peopleEngaged.size / totalPeople) * 100) : 0 },
    { step: 5, label: "Exported Tailored Resume", people: peopleExported.size, count: exportCount, percent: totalPeople > 0 ? Math.round((peopleExported.size / totalPeople) * 100) : 0 }
  ];

  // Sort domains
  const sortedDomains = Object.entries(domainsCount)
    .map(([name, count]) => ({
      name,
      count,
      percent: checkCount > 0 ? Math.round((count / checkCount) * 100) : 0
    }))
    .sort((a, b) => b.count - a.count);

  // Generate actionable insights based strictly on real data
  const insights = [];

  if (totalPeople === 0) {
    insights.push({
      type: "opportunity",
      metric: "Ready For Traffic",
      title: "Real-Time Tracking Active",
      description: "No visitor sessions have been recorded in this time window yet. Share your app link with friends or colleagues to begin collecting real live adoption metrics.",
      action: "Click 'Share JobFit' in the header to distribute your link."
    });
  } else {
    // Real insight 1: Return usage
    if (returningRate > 0) {
      insights.push({
        type: "highlight",
        metric: `${returningRate}% Returning People`,
        title: "Repeat Usage Detected",
        description: `${returningPeopleCount} out of ${totalPeople} real visitors returned to use JobFit multiple times.`,
        action: "Returning visitors indicate strong value perception."
      });
    }

    // Real insight 2: Input drop-off
    const inputDropoff = totalPeople > 0 ? Math.round(((totalPeople - peopleInput.size) / totalPeople) * 100) : 0;
    if (inputDropoff > 0) {
      insights.push({
        type: "opportunity",
        metric: `${inputDropoff}% Bounce Before Input`,
        title: "Landing to Input Conversion",
        description: `${peopleInput.size} out of ${totalPeople} real visitors pasted their resume and target job.`,
        action: "Ensure instructions on the landing page remain clean and prominent."
      });
    }

    // Real insight 3: Fit check conversion
    if (checkCount > 0) {
      insights.push({
        type: "adoption",
        metric: `${peopleChecked.size} Checked Fit`,
        title: "Fit Check Activity",
        description: `${peopleChecked.size} unique users generated an AI Fit Score report.`,
        action: `Average Fit Score across checks is ${avgFitScore}%.`
      });
    }

    // Real insight 4: Exports
    if (exportCount > 0) {
      insights.push({
        type: "feature",
        metric: `${exportCount} Exports Completed`,
        title: "Final Value Delivery",
        description: `${peopleExportedCount} users completed their polish and downloaded a finished resume.`,
        action: "Users are finding value through to final document download."
      });
    }
  }

  // Recent activity log (last 30 events)
  const recentEvents = [...filtered]
    .reverse()
    .slice(0, 30)
    .map(e => ({
      id: e.id,
      event: e.event,
      visitorId: (e.visitorId || "usr_anon").slice(0, 10),
      timestamp: e.timestamp,
      timeAgo: formatTimeAgo(e.timestamp),
      domain: e.properties?.domain || "General",
      fitScore: e.properties?.fitScore,
      format: e.properties?.format,
      details: formatEventDetails(e)
    }));

  return {
    period,
    totalPeople,
    totalSessions,
    returningPeopleCount,
    returningRate,
    avgSessionsPerPerson: totalPeople > 0 ? Number((totalSessions / totalPeople).toFixed(1)) : 1.0,
    peopleCheckedCount: peopleChecked.size,
    peopleExportedCount: peopleExported.size,
    totalChecks: checkCount,
    avgFitScore,
    polishRate,
    exportRate,
    exportCount,
    funnel,
    scoreBuckets: {
      low: { count: scoreBuckets.low, percent: checkCount > 0 ? Math.round((scoreBuckets.low / checkCount) * 100) : 0 },
      mid: { count: scoreBuckets.mid, percent: checkCount > 0 ? Math.round((scoreBuckets.mid / checkCount) * 100) : 0 },
      high: { count: scoreBuckets.high, percent: checkCount > 0 ? Math.round((scoreBuckets.high / checkCount) * 100) : 0 }
    },
    domains: sortedDomains,
    exportFormats: {
      docx: exportFormats.docx,
      pdf: exportFormats.pdf,
      summary_report: exportFormats.summary_report,
      total: exportFormats.docx + exportFormats.pdf + exportFormats.summary_report
    },
    features: {
      acceptAllClicks,
      individualBulletAccepts,
      voiceContexts,
      roadmapViews,
      roadmapGenerations
    },
    insights,
    recentEvents
  };
}

function formatTimeAgo(ts) {
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function formatEventDetails(e) {
  switch (e.event) {
    case "page_view":
      return "Visited JobFit optimizer";
    case "resume_and_job_entered":
      return `Loaded resume & job description (${e.properties?.domain || "General"})`;
    case "fit_check_completed":
      return `Calculated Fit Score: ${e.properties?.fitScore}/100 (${e.properties?.verdict || "Report ready"})`;
    case "bullet_tab_viewed":
      return "Inspected bullet rewrite recommendations";
    case "bullet_context_added":
      return e.properties?.isVoice ? "Added context via speech dictation" : "Added custom bullet context";
    case "bullet_accepted":
      return `Accepted rewrite for bullet #${(e.properties?.bulletIndex || 0) + 1}`;
    case "accept_all_rewrites_clicked":
      return `One-click accepted ${e.properties?.bulletsAccepted || "all"} verified rewrites`;
    case "roadmap_viewed":
      return `Reviewed qualification roadmap for ${e.properties?.domain || "job"}`;
    case "roadmap_ai_plan_generated":
      return `Generated AI 30-Day Qualification Plan (${e.properties?.domain || "job"})`;
    case "export_downloaded":
      return `Exported tailored resume (${(e.properties?.format || "pdf").toUpperCase()})`;
    default:
      return e.event.replace(/_/g, " ");
  }
}

// Export raw CSV
export function exportCsv() {
  const headers = ["ID", "Timestamp", "ISO_Date", "Event", "Person_ID", "Session_ID", "Domain", "Fit_Score", "Format", "Details"];
  const rows = events.map(e => {
    return [
      e.id,
      e.timestamp,
      new Date(e.timestamp).toISOString(),
      e.event,
      e.visitorId || "",
      e.sessionId,
      `"${(e.properties?.domain || "").replace(/"/g, '""')}"`,
      e.properties?.fitScore !== undefined ? e.properties.fitScore : "",
      e.properties?.format || "",
      `"${(formatEventDetails(e) || "").replace(/"/g, '""')}"`
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

export function resetAnalytics() {
  events = [];
  persistNow();
  return { ok: true, count: 0 };
}
