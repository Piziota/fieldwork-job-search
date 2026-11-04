"use strict";

const LEGACY_KEY = "fieldwork.portal.v1";
const MIGRATED_KEY = "fieldwork.portal.migrated.v1";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const state = { profile: {}, jobs: [], applications: [], sources: [], config: {} };
let toastTimer;
let currentApplication = null;

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("toast-error", error);
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 3600);
}

async function api(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const payload = await response.json();
      if (payload.error) message = payload.error;
    } catch (error) {
      console.error("Could not read the error response:", error);
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "Date not recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Date not recorded" : date.toLocaleDateString();
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function setSelected(select, values) {
  const selected = new Set(Array.isArray(values) ? values : []);
  for (const option of select.options) option.selected = selected.has(option.value);
}

async function migrateLegacyData() {
  let raw;
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    raw = localStorage.getItem(LEGACY_KEY);
  } catch (error) {
    console.error("Could not access legacy browser storage:", error);
    toast("Browser storage is unavailable; your server-side data remains unaffected.", true);
    return;
  }
  if (!raw) {
    localStorage.setItem(MIGRATED_KEY, "true");
    return;
  }
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch (error) {
    console.error("Could not parse old browser data:", error);
    toast("Previous browser data could not be read; it was left unchanged.", true);
    return;
  }
  if (!backup || !Array.isArray(backup.jobs)) {
    toast("Previous browser data has an unexpected format; it was left unchanged.", true);
    return;
  }
  try {
    const dashboard = await api("/api/dashboard");
    if (dashboard.total === 0) {
      await api("/api/import", { method: "POST", body: JSON.stringify({ backup }) });
      toast("Previous browser data was moved into your local Fieldwork database.");
    }
    localStorage.setItem(MIGRATED_KEY, "true");
  } catch (error) {
    console.error("Could not migrate previous browser data:", error);
    toast("Could not migrate previous browser data. It is still in this browser.", true);
  }
}

function getProfileFormData() {
  const form = $("#profile-form");
  const data = new FormData(form);
  const values = {};
  for (const key of ["name", "email", "role", "seniority", "language", "workAuthorization", "remotePreference", "salaryMin", "salaryMax", "mustHave", "avoid", "experience", "education", "skills", "links", "industries", "evidence"]) {
    values[key] = String(data.get(key) || "").trim();
  }
  values.countries = Array.from(form.elements.countries.selectedOptions, (option) => option.value);
  values.languages = Array.from(form.elements.languages.selectedOptions, (option) => option.value);
  values.employmentTypes = splitList(String(data.get("employmentTypes") || ""));
  return values;
}

function fillProfile() {
  const form = $("#profile-form");
  const profile = state.profile;
  for (const key of ["name", "email", "role", "seniority", "language", "workAuthorization", "remotePreference", "salaryMin", "salaryMax", "mustHave", "avoid", "experience", "education", "skills", "links", "industries", "evidence"]) {
    if (profile[key] !== undefined) form.elements.namedItem(key).value = profile[key];
  }
  form.elements.namedItem("employmentTypes").value = (profile.employmentTypes || []).join(", ");
  setSelected(form.elements.namedItem("countries"), profile.countries);
  setSelected(form.elements.namedItem("languages"), profile.languages);
  $("#profile-saved").textContent = profile.updatedAt ? `Saved ${new Date(profile.updatedAt).toLocaleString()}` : "Not saved yet";
}

function renderDashboard(dashboard) {
  const pipeline = dashboard.pipeline || {};
  $("#stat-total").textContent = String(pipeline.Saved || 0);
  $("#stat-applied").textContent = String(dashboard.applications || 0);
  $("#stat-interviews").textContent = String(dashboard.interviews || 0);
  $("#stat-matches").textContent = String(dashboard.strong_matches || 0);
  const largest = Math.max(0, ...Object.values(pipeline));
  for (const [status, suffix] of [["Saved", "saved"], ["Applied", "applied"], ["Interviewing", "interview"]]) {
    const count = pipeline[status] || 0;
    $(`#pipeline-${suffix}-count`).textContent = String(count);
    $(`#pipeline-${suffix}-bar`).style.width = largest ? `${Math.max(8, count / largest * 100)}%` : "0%";
  }

  const profile = state.profile;
  const countries = profile.countries || [];
  const hasProfile = Boolean(profile.role || countries.length || profile.mustHave || profile.experience || profile.evidence);
  $("#sidebar-search-status").textContent = hasProfile ? "Search profile ready" : "Profile not set up";
  $("#sidebar-search-status").previousElementSibling.classList.toggle("profile-ready", hasProfile);
  $("#profile-summary-link").textContent = hasProfile ? "Edit your profile →" : "Set up your profile →";
  $("#profile-summary-intro").textContent = profile.role
    ? `Looking for ${profile.role}`
    : hasProfile ? "Your search preferences" : "Set your preferences to make job matches more relevant.";
  const chips = [
    profile.language && `Applications in ${profile.language}`,
    ...countries.slice(0, 3),
    countries.length > 3 && `+${countries.length - 3} more`,
    profile.remotePreference,
  ].filter(Boolean);
  $("#profile-summary-content").innerHTML = chips.length
    ? chips.map((value) => `<span class="profile-chip">${escapeHtml(value)}</span>`).join("")
    : '<div class="profile-summary-empty"><span aria-hidden="true">◎</span><span>Add your target role, countries, and must-haves.</span></div>';
}

function renderJobs() {
  const filter = $("#status-filter").value;
  const jobs = state.jobs.filter(({ job }) => filter === "all" || job.status === filter);
  if (!jobs.length) {
    $("#jobs-list").innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">↗</div>
        <h3>${state.jobs.length ? "No roles in this view" : "Your shortlist starts here"}</h3>
        <p>${state.jobs.length ? "Try another status filter." : "Discover roles from configured public boards or add a posting you found."}</p>
        ${state.jobs.length ? "" : '<button class="button button-outline" type="button" data-action="add">Add your first job</button>'}
      </div>`;
    return;
  }
  $("#jobs-list").innerHTML = jobs.map(({ job, match }) => {
    const score = Number.isFinite(match?.score) ? match.score : 50;
    const reasons = [
      ...(match?.matched_must_have || []).slice(0, 3).map((term) => `Matches ${term}`),
      ...(match?.missing_must_have || []).slice(0, 2).map((term) => `Missing ${term}`),
      ...(match?.conflicts || []).slice(0, 2).map((term) => `Conflict: ${term}`),
      ...(match?.dimensions?.location === 0 ? ["Outside selected countries"] : []),
    ];
    const safeLink = /^https?:\/\//i.test(job.url || "");
    const statuses = ["Saved", "Applied", "Screening", "Interviewing", "Offer", "Hired", "Rejected", "Withdrawn", "Archived", "Expired"];
    return `
      <article class="job-card" data-job-id="${escapeHtml(job.id)}">
        <div class="job-main">
          <p class="job-company">${escapeHtml(job.company)} <span class="separator">•</span> ${escapeHtml(job.source === "manual" ? "ADDED " + formatDate(job.created_at) : "FOUND " + formatDate(job.created_at))}</p>
          <h3 class="job-title">${escapeHtml(job.title)}</h3>
          <div class="job-meta">
            ${job.location || job.country ? `<span class="meta-tag">${escapeHtml([job.location, job.country].filter(Boolean).join(" · "))}</span>` : ""}
            ${job.employment_type ? `<span class="meta-tag">${escapeHtml(job.employment_type)}</span>` : ""}
            ${job.salary ? `<span class="meta-tag">${escapeHtml(job.salary)}</span>` : ""}
            ${job.language ? `<span class="meta-tag">Language: ${escapeHtml(job.language)}</span>` : ""}
          </div>
          <div class="match-reasons">${reasons.length
            ? reasons.map((reason) => `<span class="reason-tag${reason.startsWith("Missing") || reason.startsWith("Conflict") || reason.startsWith("Outside") ? " negative" : ""}">${escapeHtml(reason)}</span>`).join("")
            : '<span class="reason-tag">Set your profile to personalize this match.</span>'}
          </div>
          ${job.description ? `<details class="job-description"><summary>Read job description</summary><p>${escapeHtml(job.description)}</p></details>` : ""}
        </div>
        <div class="job-actions">
          <div class="score${score < 50 ? " low" : ""}">${score}<span>/ 100 MATCH</span></div>
          <label class="visually-hidden" for="status-${escapeHtml(job.id)}">Status for ${escapeHtml(job.title)}</label>
          <select class="status-select" id="status-${escapeHtml(job.id)}" data-action="status">${statuses.map((status) => `<option${job.status === status ? " selected" : ""}>${status}</option>`).join("")}</select>
          <div class="job-buttons">
            ${safeLink ? `<a class="small-button" href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ""}
            <button class="small-button primary" type="button" data-action="draft">Prepare application</button>
            <button class="small-button danger" type="button" data-action="delete">Remove</button>
          </div>
        </div>
      </article>`;
  }).join("");
}

function renderSources() {
  $("#source-count").textContent = `${state.sources.length} ${state.sources.length === 1 ? "board" : "boards"}`;
  if (!state.sources.length) {
    $("#sources-list").innerHTML = '<div class="empty-inline">No job boards yet. Add a public company careers board to start discovery.</div>';
    return;
  }
  $("#sources-list").innerHTML = state.sources.map((source) => `
    <article class="source-row" data-source-id="${escapeHtml(source.id)}">
      <div><strong>${escapeHtml(source.company)}</strong><span>${escapeHtml(source.platform)} · ${escapeHtml(source.slug)}</span>
      ${source.countries.length ? `<small>${source.countries.map(escapeHtml).join(", ")}</small>` : ""}</div>
      <button class="small-button danger" type="button" data-action="remove-source">Remove</button>
    </article>`).join("");
}

function renderApplications() {
  if (!state.applications.length) {
    $("#applications-list").innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true">↗</div><h3>No application packs yet</h3><p>Choose “Prepare application” on a role to create a reviewable CV summary, letter, and answer draft.</p></div>';
    return;
  }
  $("#applications-list").innerHTML = state.applications.map((application) => `
    <article class="application-card" data-application-id="${escapeHtml(application.id)}">
      <div class="application-card-main">
        <p class="job-company">${escapeHtml(application.company)} <span class="separator">•</span> UPDATED ${escapeHtml(formatDate(application.updated_at))}</p>
        <h3>${escapeHtml(application.title)}</h3>
        <div class="job-meta"><span class="meta-tag">${escapeHtml(application.status)}</span><span class="meta-tag">${escapeHtml(application.language)}</span></div>
        <details class="application-history"><summary>History · ${application.events?.length || 0}</summary>
          ${(application.events || []).length ? `<ul>${application.events.map((event) => `<li><time>${escapeHtml(formatDate(event.created_at))}</time> <strong>${escapeHtml(event.kind.replace(/_/g, " "))}</strong>${event.note ? ` — ${escapeHtml(event.note)}` : ""}</li>`).join("")}</ul>` : "<p>No history recorded yet.</p>"}
        </details>
      </div>
      <div class="job-buttons">
        <button class="small-button primary" type="button" data-action="edit-application">Review drafts</button>
        <button class="small-button" type="button" data-action="outcome">Record outcome</button>
        <button class="small-button" type="button" data-action="interview-prep">Interview prep</button>
        ${["Applied", "Screening", "Interviewing"].includes(application.status) ? '<button class="small-button" type="button" data-action="followup">Draft follow-up</button>' : ""}
      </div>
    </article>`).join("");
}

function renderInterviews() {
  const applications = state.applications.filter((application) => ["Applied", "Screening", "Interviewing", "Offer"].includes(application.status));
  if (!applications.length) {
    $("#interview-list").innerHTML = '<div class="empty-inline">Move a role to screening or interviewing to find its prep tools here.</div>';
    return;
  }
  $("#interview-list").innerHTML = applications.map((application) => `
    <article class="interview-card" data-application-id="${escapeHtml(application.id)}">
      <div><p class="job-company">${escapeHtml(application.company)}</p><h3>${escapeHtml(application.title)}</h3><span class="meta-tag">${escapeHtml(application.status)}</span>${application.interview_at ? `<p class="interview-date">Interview · ${escapeHtml(formatDate(application.interview_at))} · ${escapeHtml(new Date(application.interview_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</p>` : ""}</div>
      <button class="button button-outline" type="button" data-action="interview-prep">Prepare / review pack <span aria-hidden="true">↗</span></button>
    </article>`).join("");
}

function renderAIStatus() {
  const ai = state.config.ai || {};
  $("#ai-status-title").textContent = ai.ready ? `AI drafts ready · ${ai.provider}` : "AI not configured";
  $("#ai-status-text").textContent = ai.ready
    ? "AI drafting, review, interview prep, skills planning, translation, and follow-up are available when you choose an AI action."
    : "Editable templates, interview prompts, matching, and exports work locally. Add a provider key on the server to enable AI.";
  $("#run-ai-skills-plan").disabled = !ai.ready;
  $("#notion-status-title").textContent = state.config.notion_configured ? "Notion connection configured" : "Notion sync is not configured";
  $("#notion-status-text").textContent = state.config.notion_configured
    ? "Sync is one-way. Only job titles, company, status, location, language, employment type, salary, and posting URL are sent."
    : "Set NOTION_API_KEY and NOTION_DATABASE_ID in your private local .env file. Profile and application documents are not sent.";
  $("#sync-notion").disabled = !state.config.notion_configured;
  $("#research-status-title").textContent = state.config.research_configured ? "Company search configured" : "Company search is not configured";
  $("#research-status-text").textContent = state.config.research_configured
    ? "Search runs only when requested. Verify sources before relying on them."
    : "Set BRAVE_SEARCH_API_KEY in your private local .env file to enable source-linked employer search.";
}

async function refresh() {
  const [dashboard, profile, jobs, applications, sources, config] = await Promise.all([
    api("/api/dashboard"),
    api("/api/profile"),
    api("/api/jobs"),
    api("/api/applications"),
    api("/api/sources"),
    api("/api/config"),
  ]);
  state.profile = profile;
  state.jobs = jobs;
  state.applications = applications;
  state.sources = sources;
  state.config = config;
  fillProfile();
  renderDashboard(dashboard);
  renderJobs();
  renderSources();
  renderApplications();
  renderInterviews();
  renderAIStatus();
}

async function saveProfile(event) {
  event.preventDefault();
  try {
    state.profile = await api("/api/profile", { method: "PUT", body: JSON.stringify(getProfileFormData()) });
    await refresh();
    toast("Your search profile is saved locally.");
  } catch (error) {
    console.error("Could not save search profile:", error);
    toast(error.message, true);
  }
}

async function addJob(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData($("#job-form")).entries());
  try {
    await api("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    $("#job-form").reset();
    $("#job-dialog").close();
    await refresh();
    toast("Opportunity added to your shortlist.");
  } catch (error) {
    console.error("Could not add job:", error);
    toast(error.message, true);
  }
}

async function addSource(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData($("#source-form")).entries());
  data.countries = splitList(data.countries || "");
  try {
    await api("/api/sources", { method: "POST", body: JSON.stringify(data) });
    $("#source-form").reset();
    await refresh();
    toast("Company job board added.");
  } catch (error) {
    console.error("Could not add source:", error);
    toast(error.message, true);
  }
}

async function syncSources() {
  const button = $("#sync-sources");
  button.disabled = true;
  button.textContent = "Refreshing boards…";
  $("#sync-result").textContent = "";
  try {
    const result = await api("/api/sources/sync", { method: "POST", body: "{}" });
    await refresh();
    const problems = result.errors.map((item) => `${item.company}: ${item.error}`).join(" · ");
    $("#sync-result").textContent = `${result.created} new posting(s); ${result.updated} refreshed.${problems ? " Some boards need attention: " + problems : ""}`;
    toast(`${result.created} new posting(s) discovered.`);
  } catch (error) {
    console.error("Could not refresh job boards:", error);
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Refresh configured boards <span aria-hidden="true">↻</span>';
  }
}

async function openApplication(jobId) {
  try {
    let application = state.applications.find((item) => item.job_id === jobId);
    if (!application) {
      application = await api(`/api/jobs/${encodeURIComponent(jobId)}/draft`, { method: "POST", body: "{}" });
      await refresh();
    }
    await showApplication(application.id);
  } catch (error) {
    console.error("Could not prepare application draft:", error);
    toast(error.message, true);
  }
}

async function showApplication(applicationId) {
  try {
    const application = await api(`/api/applications/${encodeURIComponent(applicationId)}`);
    const job = state.jobs.find((item) => item.job.id === application.job_id)?.job;
    currentApplication = application;
    const form = $("#application-form");
    form.elements.jobId.value = application.job_id;
    form.elements.applicationId.value = application.id;
    form.elements.language.value = application.language || state.profile.language || "English";
    form.elements.interview_at.value = application.interview_at || "";
    form.elements.cv.value = application.cv || "";
    form.elements.cover_letter.value = application.cover_letter || "";
    form.elements.answers.value = JSON.stringify(application.answers || [], null, 2);
    form.elements.review.value = application.review || "";
    $("#ats-result").innerHTML = "";
    $("#application-title").textContent = job ? `${job.title} · ${job.company}` : "Application pack";
    $("#company-research-result").innerHTML = "";
    $("#application-dialog").showModal();
  } catch (error) {
    console.error("Could not open application drafts:", error);
    toast(error.message, true);
  }
}

function parseAnswers(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) throw new Error("not a list");
    return parsed;
  } catch (error) {
    throw new Error("Application answers must be valid JSON (an array of question and answer objects).");
  }
}

async function saveApplication(event) {
  event.preventDefault();
  const form = $("#application-form");
  try {
    await api(`/api/applications/${encodeURIComponent(form.elements.applicationId.value)}`, {
      method: "PATCH",
      body: JSON.stringify({
        language: form.elements.language.value,
        interview_at: form.elements.interview_at.value,
        cv: form.elements.cv.value,
        cover_letter: form.elements.cover_letter.value,
        answers: parseAnswers(form.elements.answers.value),
        review: form.elements.review.value,
      }),
    });
    $("#application-dialog").close();
    await refresh();
    toast("Application drafts saved locally.");
  } catch (error) {
    console.error("Could not save application drafts:", error);
    toast(error.message, true);
  }
}

function parseModelJSON(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function displayInterviewPack(pack, application, aiGenerated = false) {
  const questions = Array.isArray(pack.likely_questions) ? pack.likely_questions : [];
  const evidence = Array.isArray(pack.evidence_to_prepare) ? pack.evidence_to_prepare : [];
  const questionsToAsk = Array.isArray(pack.questions_to_ask) ? pack.questions_to_ask : [];
  $("#interview-result").innerHTML = `<article class="panel interview-pack">
    <div class="panel-heading"><h2>${escapeHtml(application?.title || "Interview pack")} · ${escapeHtml(application?.company || "")}</h2><button class="icon-button" type="button" data-action="close-interview">×</button></div>
    <p class="application-disclaimer">${aiGenerated ? "AI-generated preparation can be inaccurate. Verify company facts and never use invented candidate experiences." : escapeHtml(pack.company_context || "No external company research has been performed.")}</p>
    <h3>Company context</h3><pre>${escapeHtml(JSON.stringify(pack.company_context || "No company context supplied.", null, 2))}</pre>
    <h3>Likely questions</h3><ul>${questions.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>
    <h3>Evidence to prepare</h3><ul>${evidence.length ? evidence.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("") : "<li>Add evidence to your profile.</li>"}</ul>
    <h3>Questions to ask</h3><ul>${questionsToAsk.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>
    ${pack.mock_interview_opening ? `<p><strong>Mock interview:</strong> ${escapeHtml(pack.mock_interview_opening)}</p>` : ""}
  </article>`;
}

async function runAITask(task, applicationId) {
  const application = state.applications.find((item) => item.id === applicationId);
  if (!application) return;
  const form = $("#application-form");
  const request = JSON.stringify({
    cv: form.elements.cv.value,
    cover_letter: form.elements.cover_letter.value,
    answers: form.elements.answers.value,
  });
  try {
    const result = await api(`/api/applications/${encodeURIComponent(applicationId)}/ai`, {
      method: "POST",
      body: JSON.stringify({ task, request }),
    });
    const generated = parseModelJSON(result.text);
    if (task === "application" || task === "translate") {
      if (typeof generated.cv === "string") form.elements.cv.value = generated.cv;
      if (typeof generated.cover_letter === "string") form.elements.cover_letter.value = generated.cover_letter;
      if (Array.isArray(generated.answers)) form.elements.answers.value = JSON.stringify(generated.answers, null, 2);
      toast("AI suggestions are ready. Verify every claim before saving.");
    } else if (task === "interview") {
      displayInterviewPack(generated, application, true);
      $("#interview-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("AI interview pack prepared. Verify company details before use.");
    } else if (task === "followup") {
      $("#followup-result").innerHTML = `<article class="panel followup-draft">
        <div class="panel-heading"><h3>${escapeHtml(generated.subject || "Follow-up draft")}</h3><span class="draft-tag">NOT SENT</span></div>
        <p>${escapeHtml(generated.body || result.text).replace(/\n/g, "<br>")}</p>
        <button class="small-button" type="button" data-action="copy-followup">Copy draft</button>
      </article>`;
      $("#followup-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("AI follow-up draft is ready; nothing was sent.");
    } else if (task === "followup") {
      $("#followup-result").innerHTML = `<article class="panel followup-draft">
        <div class="panel-heading"><h3>${escapeHtml(generated.subject || "Follow-up draft")}</h3><span class="draft-tag">NOT SENT</span></div>
        <p>${escapeHtml(generated.body || result.text).replace(/\n/g, "<br>")}</p>
        <button class="small-button" type="button" data-action="copy-followup">Copy draft</button>
      </article>`;
      $("#followup-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("AI follow-up draft is ready; nothing was sent.");
    } else {
      form.elements.review.value = JSON.stringify(generated, null, 2);
      toast("Review is ready. Check all flagged claims and suggestions.");
    }
  } catch (error) {
    console.error("AI task failed:", error);
    toast(error.message, true);
  }
}

async function researchCompany(applicationId) {
  try {
    const result = await api(`/api/applications/${encodeURIComponent(applicationId)}/company-research`, {
      method: "POST",
      body: "{}",
    });
    const summary = result.summary ? `<h3>AI summary <small>Verify before relying on it</small></h3><pre>${escapeHtml(result.summary)}</pre>` : "";
    const links = result.results.map((item) => `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || item.url)}</a><p>${escapeHtml(item.description)}</p></li>`).join("");
    $("#company-research-result").innerHTML = `<article class="research-card"><h3>Research leads · not independently verified</h3>${summary}<ol>${links || "<li>No results found.</li>"}</ol><p>Search snippets can be incomplete or misleading. Open and verify sources directly.</p></article>`;
  } catch (error) {
    console.error("Company research failed:", error);
    toast(error.message, true);
  }
}

async function runATSCheck(applicationId) {
  try {
    const result = await api(`/api/applications/${encodeURIComponent(applicationId)}/ats-check`, {
      method: "POST",
      body: "{}",
    });
    $("#ats-result").innerHTML = `<article class="ats-result-card">
      <div class="ats-result-score">${result.coverage}% <span>keyword coverage</span></div>
      <p>${escapeHtml(result.note)}</p>
      <h3>Found in your CV</h3><div class="skills-tags">${result.matched_keywords.length
        ? result.matched_keywords.map((term) => `<span class="profile-chip">${escapeHtml(term)}</span>`).join("")
        : "<span>None of the tracked terms</span>"}</div>
      <h3>Not found in your CV</h3><div class="skills-tags">${result.missing_keywords.length
        ? result.missing_keywords.map((term) => `<span class="reason-tag negative">${escapeHtml(term)}</span>`).join("")
        : "<span>No missing tracked terms</span>"}</div>
      <p class="settings-help">Only add a missing term if you can support it with truthful experience or evidence.</p>
    </article>`;
  } catch (error) {
    console.error("Local keyword check failed:", error);
    toast(error.message, true);
  }
}

function openOutcome(applicationId) {
  $("#outcome-form").elements.applicationId.value = applicationId;
  $("#outcome-dialog").showModal();
}

async function submitOutcome(event) {
  event.preventDefault();
  const form = $("#outcome-form");
  try {
    await api(`/api/applications/${encodeURIComponent(form.elements.applicationId.value)}/outcomes`, {
      method: "POST",
      body: JSON.stringify({ outcome: form.elements.outcome.value, note: form.elements.note.value }),
    });
    $("#outcome-dialog").close();
    form.reset();
    await refresh();
    toast("Outcome added to your application history.");
  } catch (error) {
    console.error("Could not record outcome:", error);
    toast(error.message, true);
  }
}

async function prepareInterview(applicationId) {
  try {
    const pack = await api(`/api/applications/${encodeURIComponent(applicationId)}/interview-prep`, {
      method: "POST",
      body: JSON.stringify({ stage: "Interview preparation" }),
    });
    const application = state.applications.find((item) => item.id === applicationId);
    displayInterviewPack(pack, application);
    $("#interview-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Interview preparation pack created.");
  } catch (error) {
    console.error("Could not prepare interview:", error);
    toast(error.message, true);
  }
}

async function draftFollowup(applicationId) {
  try {
    const result = await api(`/api/applications/${encodeURIComponent(applicationId)}/followup`, {
      method: "POST",
      body: JSON.stringify({ after_days: 10 }),
    });
    $("#followup-result").innerHTML = `<article class="panel followup-draft">
      <div class="panel-heading"><h3>${escapeHtml(result.subject)}</h3><span class="draft-tag">NOT SENT</span></div>
      <p>${escapeHtml(result.body).replace(/\n/g, "<br>")}</p>
      <button class="small-button" type="button" data-action="copy-followup">Copy draft</button>
    </article>`;
    $("#followup-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast("Follow-up draft is ready; nothing was sent.");
  } catch (error) {
    console.error("Could not prepare follow-up:", error);
    toast(error.message, true);
  }
}

async function runSkillsPlan() {
  try {
    const result = await api("/api/skills/plan", { method: "POST", body: "{}" });
    $("#skills-results").innerHTML = `<p class="eyebrow">BASED ON ${result.based_on} TRACKED JOB(S)</p>
      ${result.skill_gaps.length ? `<h3>Recurring terms not in your profile</h3><div class="skills-tags">${result.skill_gaps.map((item) => `<span class="profile-chip">${escapeHtml(item.term)} <small>× ${item.job_mentions}</small></span>`).join("")}</div>
      <h3>Suggested priorities</h3><ol>${result.learning_plan.map((item) => `<li><strong>${escapeHtml(item.skill)}</strong> — ${escapeHtml(item.reason)}</li>`).join("")}</ol>` : "<p>No obvious keyword gaps. That does not mean every role is a match.</p>"}
      <p class="panel-subtitle">${escapeHtml(result.note)}</p>`;
  } catch (error) {
    console.error("Could not compare skill gaps:", error);
    toast(error.message, true);
  }
}

async function runAISkillsPlan() {
  try {
    const result = await api("/api/skills/plan/ai", { method: "POST", body: "{}" });
    const plan = parseModelJSON(result.text);
    const gaps = Array.isArray(plan.skill_gaps) ? plan.skill_gaps : [];
    const priorities = Array.isArray(plan.prioritized_learning_plan) ? plan.prioritized_learning_plan : [];
    const supported = Array.isArray(plan.supported_skills) ? plan.supported_skills : [];
    $("#skills-results").innerHTML = `<p class="eyebrow">AI SUGGESTIONS · BASED ON ${result.based_on} TRACKED JOB(S)</p>
      <p class="application-disclaimer">Verify this plan independently. AI suggestions are not an assessment or course endorsement.</p>
      ${supported.length ? `<h3>Evidence-backed skills to emphasize</h3><ul>${supported.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>` : ""}
      ${gaps.length ? `<h3>Potential gaps to verify</h3><ul>${gaps.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ul>` : ""}
      ${priorities.length ? `<h3>Suggested priorities</h3><ol>${priorities.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("")}</ol>` : ""}
      <p class="panel-subtitle">AI output can be inaccurate. Review and personalize it before acting.</p>`;
  } catch (error) {
    console.error("AI skills plan failed:", error);
    toast(error.message, true);
  }
}

function encodeFile(file) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
}

async function importDocument(file) {
  $("#document-status").textContent = "Extracting text locally…";
  try {
    if (file.size > 1024 * 1024) throw new Error("Document exceeds the 1 MB limit.");
    const result = await api("/api/profile/document", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, base64: await encodeFile(file) }),
    });
    const target = $("#profile-form").elements.namedItem(result.destination || "experience");
    target.value = [target.value, result.text].filter(Boolean).join("\n\n");
    $("#document-status").textContent = `Extracted ${result.characters} characters from ${file.name}. Review and save your profile.`;
  } catch (error) {
    console.error("Could not extract CV text:", error);
    $("#document-status").textContent = error.message;
    toast(error.message, true);
  }
}

async function importBackup(file) {
  try {
    const backup = JSON.parse(await file.text());
    const result = await api("/api/import", { method: "POST", body: JSON.stringify({ backup }) });
    await refresh();
    toast(`Backup imported: ${result.imported} job(s), ${result.applications_imported} application pack(s), ${result.events_imported} history events; ${result.skipped + result.applications_skipped + result.events_skipped} invalid item(s) skipped.`);
  } catch (error) {
    console.error("Could not import backup:", error);
    toast(`Backup was not imported: ${error.message}`, true);
  } finally {
    $("#backup-file").value = "";
  }
}

async function importEmailExport(file) {
  $("#email-proposals").textContent = "Reading this export locally…";
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("Email export exceeds the 2 MB limit.");
    const result = await api("/api/email/scan", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, base64: await encodeFile(file) }),
    });
    renderEmailProposals(result.proposals);
    toast(`${result.proposals.length} possible status update(s) found. Review before approving.`);
  } catch (error) {
    console.error("Could not review email export:", error);
    $("#email-proposals").textContent = error.message;
    toast(error.message, true);
  } finally {
    $("#email-export-file").value = "";
  }
}

function renderEmailProposals(proposals) {
  $("#email-proposals").dataset.proposals = JSON.stringify(proposals);
  if (!proposals.length) {
    $("#email-proposals").innerHTML = '<p class="empty-inline">No matching status signals found. Your tracker was not changed.</p>';
    return;
  }
  $("#email-proposals").innerHTML = proposals.map((proposal, index) => `
    <article class="email-proposal" data-proposal-index="${index}">
      <div><strong>${escapeHtml(proposal.company)} · ${escapeHtml(proposal.title)}</strong>
        <span>${escapeHtml(proposal.subject || "(no subject)")}</span>
        <small>${escapeHtml(proposal.sender || "Unknown sender")} · ${escapeHtml(formatDate(proposal.received_at))}</small>
        <span>${escapeHtml(proposal.current_status)} → <strong>${escapeHtml(proposal.proposed_status)}</strong></span>
      </div>
      <button class="small-button primary" type="button" data-action="approve-email">Approve</button>
    </article>`).join("");
}

async function approveEmailProposal(button) {
  const proposals = JSON.parse($("#email-proposals").dataset.proposals || "[]");
  const card = button.closest("[data-proposal-index]");
  const proposal = proposals[Number(card.dataset.proposalIndex)];
  if (!proposal) return;
  try {
    await api("/api/email/approve", {
      method: "POST",
      body: JSON.stringify({ job_id: proposal.job_id, status: proposal.proposed_status, subject: proposal.subject, sender: proposal.sender }),
    });
    proposals.splice(Number(card.dataset.proposalIndex), 1);
    renderEmailProposals(proposals);
    await refresh();
    toast("Email signal approved and recorded.");
  } catch (error) {
    console.error("Could not approve email signal:", error);
    toast(error.message, true);
  }
}

async function syncNotion() {
  const button = $("#sync-notion");
  button.disabled = true;
  try {
    const result = await api("/api/notion/sync", { method: "POST", body: "{}" });
    toast(`Notion sync complete: ${result.created} created, ${result.updated} updated.`);
  } catch (error) {
    console.error("Notion sync failed:", error);
    toast(error.message, true);
  } finally {
    button.disabled = !state.config.notion_configured;
  }
}

function printApplication() {
  const form = $("#application-form");
  const popup = window.open("", "_blank");
  if (!popup) {
    toast("Allow the print window to open, then try again.", true);
    return;
  }
  const title = $("#application-title").textContent;
  const fields = [
    ["CV / profile summary", form.elements.cv.value],
    ["Cover letter", form.elements.cover_letter.value],
    ["Application question answers", form.elements.answers.value],
    ["Reviewer notes", form.elements.review.value],
  ];
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} application drafts</title>
    <style>body{font:14px/1.6 sans-serif;max-width:760px;margin:40px auto;color:#20251f}h1{font-size:24px}h2{font-size:17px;margin-top:30px;border-bottom:1px solid #ddd;padding-bottom:5px}pre{white-space:pre-wrap;font:inherit}.note{background:#f4f1e9;padding:12px}@media print{body{margin:0 auto}}</style></head>
    <body><h1>${escapeHtml(title)} · application drafts</h1><p class="note">Review and correct all details before using these materials. Fieldwork does not submit applications.</p>
    ${fields.map(([label, text]) => `<h2>${escapeHtml(label)}</h2><pre>${escapeHtml(text)}</pre>`).join("")}
    <script>window.addEventListener("load",()=>window.print())<\/script></body></html>`);
  popup.document.close();
}

async function handleClick(event) {
  const closeButton = event.target.closest("[data-close]");
  if (closeButton) document.getElementById(closeButton.dataset.close)?.close();

  const aiButton = event.target.closest("[data-ai-task]");
  if (aiButton) {
    if (currentApplication) await runAITask(aiButton.dataset.aiTask, currentApplication.id);
    return;
  }

  const action = event.target.closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "add") {
    $("#job-dialog").showModal();
    return;
  }
  if (action.dataset.action === "copy-followup") {
    try {
      await navigator.clipboard.writeText($("#followup-result").innerText.replace("Copy draft", ""));
      toast("Follow-up draft copied; it was not sent.");
    } catch (error) {
      console.error("Could not copy follow-up draft:", error);
      toast("Clipboard access is unavailable. Select and copy the draft instead.", true);
    }
    return;
  }
  if (action.dataset.action === "approve-email") {
    await approveEmailProposal(action);
    return;
  }
  if (action.dataset.action === "company-research" && currentApplication) {
    await researchCompany(currentApplication.id);
    return;
  }
  if (action.dataset.action === "ats-check" && currentApplication) {
    await runATSCheck(currentApplication.id);
    return;
  }
  if (action.dataset.action === "close-interview") {
    $("#interview-result").innerHTML = "";
    return;
  }

  const jobCard = action.closest("[data-job-id]");
  if (jobCard && action.dataset.action === "draft") {
    await openApplication(jobCard.dataset.jobId);
    return;
  }
  if (jobCard && action.dataset.action === "delete") {
    const job = state.jobs.find(({ job: item }) => item.id === jobCard.dataset.jobId)?.job;
    if (!job || !window.confirm(`Remove ${job.title} at ${job.company} and its application history?`)) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      await refresh();
      toast("Opportunity and related application data removed.");
    } catch (error) {
      console.error("Could not remove job:", error);
      toast(error.message, true);
    }
    return;
  }

  const sourceCard = action.closest("[data-source-id]");
  if (sourceCard && action.dataset.action === "remove-source") {
    try {
      await api(`/api/sources/${encodeURIComponent(sourceCard.dataset.sourceId)}`, { method: "DELETE" });
      await refresh();
      toast("Job-board source removed. Previously discovered jobs remain in your shortlist.");
    } catch (error) {
      console.error("Could not remove job-board source:", error);
      toast(error.message, true);
    }
    return;
  }

  const applicationCard = action.closest("[data-application-id]");
  if (applicationCard) {
    const id = applicationCard.dataset.applicationId;
    if (action.dataset.action === "edit-application") await showApplication(id);
    else if (action.dataset.action === "outcome") openOutcome(id);
    else if (action.dataset.action === "interview-prep") await prepareInterview(id);
    else if (action.dataset.action === "followup") await draftFollowup(id);
  }
}

async function handleStatus(event) {
  const select = event.target.closest("[data-action='status']");
  const card = select?.closest("[data-job-id]");
  if (!select || !card) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(card.dataset.jobId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value }),
    });
    await refresh();
    toast("Application status updated.");
  } catch (error) {
    console.error("Could not update application status:", error);
    toast(error.message, true);
  }
}

$("#profile-form").addEventListener("submit", saveProfile);
$("#job-form").addEventListener("submit", addJob);
$("#application-form").addEventListener("submit", saveApplication);
$("#outcome-form").addEventListener("submit", submitOutcome);
$("#source-form").addEventListener("submit", addSource);
$("#status-filter").addEventListener("change", renderJobs);
$("#jobs-list").addEventListener("change", handleStatus);
$("#sync-sources").addEventListener("click", syncSources);
$("#run-skills-plan").addEventListener("click", runSkillsPlan);
$("#run-ai-skills-plan").addEventListener("click", runAISkillsPlan);
$("#add-job-button").addEventListener("click", () => $("#job-dialog").showModal());
$("#copy-application").addEventListener("click", async () => {
  const form = $("#application-form");
  const text = `CV / PROFILE SUMMARY\n${form.elements.cv.value}\n\nCOVER LETTER\n${form.elements.cover_letter.value}\n\nAPPLICATION ANSWERS\n${form.elements.answers.value}\n\nREVIEW NOTES\n${form.elements.review.value}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("Application drafts copied to clipboard.");
  } catch (error) {
    console.error("Could not copy application drafts:", error);
    toast("Clipboard access is unavailable. Select and copy the draft text instead.", true);
  }
});
$("#print-application").addEventListener("click", printApplication);
$("#profile-document").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importDocument(file);
  event.target.value = "";
});
$("#backup-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importBackup(file);
});
$("#email-export-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importEmailExport(file);
});
$("#sync-notion").addEventListener("click", syncNotion);
$("#interview-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action='interview-prep']");
  if (button) prepareInterview(button.closest("[data-application-id]").dataset.applicationId);
});
document.addEventListener("click", handleClick);
document.addEventListener("hashchange", () => {
  $$(".side-link").forEach((link) => link.classList.toggle("active", link.hash === location.hash));
});
$("#current-date").textContent = new Date().toLocaleDateString(undefined, {
  weekday: "long", month: "long", day: "numeric",
}).toUpperCase();

(async function start() {
  try {
    await api("/api/health");
    await migrateLegacyData();
    await refresh();
  } catch (error) {
    console.error("Could not start Fieldwork:", error);
    toast(`The Fieldwork server is not ready: ${error.message}. Start it with python3 server.py.`, true);
  }
})();
