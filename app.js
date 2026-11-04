"use strict";

const STORAGE_KEY = "fieldwork.portal.v1";
const profileForm = document.querySelector("#profile-form");
const jobForm = document.querySelector("#job-form");
const applicationForm = document.querySelector("#application-form");
const jobDialog = document.querySelector("#job-dialog");
const applicationDialog = document.querySelector("#application-dialog");
const jobsList = document.querySelector("#jobs-list");
const toast = document.querySelector("#toast");
const statusFilter = document.querySelector("#status-filter");

let state = { profile: {}, jobs: [] };
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function readState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.jobs)) {
      state = {
        profile: parsed.profile && typeof parsed.profile === "object" ? parsed.profile : {},
        jobs: parsed.jobs.filter((job) => job && typeof job.id === "string"),
      };
    } else {
      showToast("Saved data could not be read. Your browser data was left unchanged.");
    }
  } catch (error) {
    console.error("Could not read Fieldwork data:", error);
    showToast("Could not read saved data in this browser.");
  }
}

function persist(message) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (message) showToast(message);
    return true;
  } catch (error) {
    console.error("Could not save Fieldwork data:", error);
    showToast("Could not save. Check browser storage settings and available space.");
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function splitTerms(value) {
  return value.split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
}

function getProfileFromForm() {
  const formData = new FormData(profileForm);
  return {
    role: String(formData.get("role") || "").trim(),
    language: String(formData.get("language") || "English"),
    countries: Array.from(profileForm.elements.countries.selectedOptions, (option) => option.value),
    mustHave: String(formData.get("mustHave") || "").trim(),
    avoid: String(formData.get("avoid") || "").trim(),
    evidence: String(formData.get("evidence") || "").trim(),
  };
}

function fillProfile() {
  const profile = state.profile;
  for (const name of ["role", "language", "mustHave", "avoid", "evidence"]) {
    if (profile[name] !== undefined) profileForm.elements[name].value = profile[name];
  }
  const countries = new Set(Array.isArray(profile.countries) ? profile.countries : []);
  for (const option of profileForm.elements.countries.options) option.selected = countries.has(option.value);
  document.querySelector("#profile-saved").textContent = profile.updatedAt
    ? `Saved ${new Date(profile.updatedAt).toLocaleString()}`
    : "Not saved yet";
}

function scoreJob(job) {
  const profile = state.profile;
  const haystack = `${job.title} ${job.company} ${job.country} ${job.language} ${job.description}`.toLowerCase();
  const countries = Array.isArray(profile.countries) ? profile.countries : [];
  const terms = splitTerms(profile.mustHave);
  const avoid = splitTerms(profile.avoid);
  const reasons = [];
  let score = 45;

  if (countries.length) {
    const matchingCountry = countries.find((country) => {
      if (country === "Remote / anywhere") return /remote|anywhere|distributed|worldwide/i.test(haystack);
      return haystack.includes(country.toLowerCase());
    });
    if (matchingCountry) {
      score += 20;
      reasons.push(`Location: ${matchingCountry}`);
    } else {
      score -= 15;
      reasons.push("Location not in your selected countries");
    }
  }

  if (profile.role) {
    const roleTerms = splitTerms(profile.role.replace(/\//g, ","));
    const roleMatch = roleTerms.some((term) => term.length > 2 && haystack.includes(term));
    if (roleMatch) {
      score += 15;
      reasons.push("Role keywords match");
    } else {
      score -= 5;
    }
  }

  if (terms.length) {
    const matched = terms.filter((term) => haystack.includes(term));
    score += Math.round((matched.length / terms.length) * 20);
    if (matched.length) reasons.push(`Requirements: ${matched.slice(0, 3).join(", ")}`);
    if (matched.length < terms.length) reasons.push(`${terms.length - matched.length} requirement(s) not found`);
  }

  const excluded = avoid.filter((term) => haystack.includes(term));
  if (excluded.length) {
    score -= Math.min(45, excluded.length * 22);
    reasons.push(`Conflicts: ${excluded.slice(0, 3).join(", ")}`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function renderJobs() {
  const filter = statusFilter.value;
  const jobs = [...state.jobs]
    .filter((job) => filter === "all" || job.status === filter)
    .sort((a, b) => scoreJob(b).score - scoreJob(a).score || b.createdAt - a.createdAt);
  const strongMatches = state.jobs.filter((job) => scoreJob(job).score >= 70).length;
  const activeApplications = state.jobs.filter((job) => ["Applied", "Interviewing"].includes(job.status)).length;
  document.querySelector("#stat-total").textContent = String(state.jobs.length);
  document.querySelector("#stat-matches").textContent = String(strongMatches);
  document.querySelector("#stat-applied").textContent = String(activeApplications);

  if (!jobs.length) {
    jobsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">↗</div>
        <h3>${state.jobs.length ? "No roles in this view" : "Your shortlist starts here"}</h3>
        <p>${state.jobs.length ? "Try a different status filter." : "Paste in a job description to see how it lines up with your search preferences. Add as many as you like."}</p>
        ${state.jobs.length ? "" : '<button class="button button-outline" type="button" data-action="add">Add your first job</button>'}
      </div>`;
    return;
  }

  jobsList.innerHTML = jobs.map((job) => {
    const { score, reasons } = scoreJob(job);
    const link = safeUrl(job.url);
    return `
      <article class="job-card" data-job-id="${escapeHtml(job.id)}">
        <div class="job-main">
          <p class="job-company">${escapeHtml(job.company)} <span class="separator">•</span> ADDED ${escapeHtml(new Date(job.createdAt).toLocaleDateString())}</p>
          <h3 class="job-title">${escapeHtml(job.title)}</h3>
          <div class="job-meta">
            ${job.country ? `<span class="meta-tag">${escapeHtml(job.country)}</span>` : ""}
            ${job.language ? `<span class="meta-tag">Application: ${escapeHtml(job.language)}</span>` : ""}
            <span class="meta-tag">${escapeHtml(job.status)}</span>
          </div>
          <div class="match-reasons">${reasons.length
            ? reasons.map((reason) => `<span class="reason-tag${reason.startsWith("Conflicts") || reason.startsWith("Location not") ? " negative" : ""}">${escapeHtml(reason)}</span>`).join("")
            : '<span class="reason-tag">Add search preferences for a more tailored match</span>'}</div>
        </div>
        <div class="job-actions">
          <div class="score${score < 50 ? " low" : ""}">${score}<span>/ 100 MATCH</span></div>
          <label class="visually-hidden" for="status-${escapeHtml(job.id)}">Status for ${escapeHtml(job.title)}</label>
          <select class="status-select" id="status-${escapeHtml(job.id)}" data-action="status" aria-label="Status for ${escapeHtml(job.title)}">
            ${["Saved", "Applied", "Interviewing"].map((status) => `<option${job.status === status ? " selected" : ""}>${status}</option>`).join("")}
          </select>
          <div class="job-buttons">
            ${link ? `<a class="small-button" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ""}
            <button class="small-button primary" type="button" data-action="draft">Prepare drafts</button>
            <button class="small-button danger" type="button" data-action="delete">Remove</button>
          </div>
        </div>
      </article>`;
  }).join("");
}

function getJob(jobId) {
  return state.jobs.find((job) => job.id === jobId);
}

function keywordEvidence(profile, job) {
  const evidence = profile.evidence.trim();
  if (!evidence) return "Add your real skills, accomplishments, and experience to your search profile before using this draft.";
  const jobText = `${job.title} ${job.description}`.toLowerCase();
  const pieces = evidence.split(/[\n.;]+/).map((part) => part.trim()).filter(Boolean);
  const relevant = pieces.filter((piece) => {
    const words = piece.toLowerCase().match(/[a-z0-9+#.-]{3,}/g) || [];
    return words.some((word) => jobText.includes(word));
  });
  return (relevant.length ? relevant : pieces).slice(0, 5).map((piece) => `• ${piece}`).join("\n");
}

function draftApplication(job) {
  const profile = state.profile;
  const person = profile.role || "professional";
  const evidence = keywordEvidence(profile, job);
  const cv = `${person}${profile.evidence ? `\n\nRelevant experience and evidence:\n${evidence}` : `\n\n${evidence}`}\n\nReview this summary and add only verified details before using it.`;
  const coverLetter = `Dear ${job.company} hiring team,\n\nI am interested in the ${job.title} role${job.country ? ` in ${job.country}` : ""}. I am exploring opportunities where my experience aligns with the work and requirements described in the posting.\n\nRelevant experience I have provided:\n${evidence}\n\nI would welcome the opportunity to discuss how my background relates to your team's needs. Thank you for your consideration.\n\nSincerely,\n[Your name]`;
  const answer = `I am interested in the ${job.title} position at ${job.company} because the role's work is relevant to the opportunities I am exploring. From the experience I have listed, the most relevant points are:\n\n${evidence}\n\nI would like to learn more about the team's priorities and discuss where my experience could be useful. Please personalize this answer with specific, accurate details before submitting.`;
  return { cv, coverLetter, answer };
}

function openApplication(jobId) {
  const job = getJob(jobId);
  if (!job) return;
  const existing = job.applicationPack || draftApplication(job);
  document.querySelector("#application-title").textContent = `${job.title} · ${job.company}`;
  applicationForm.elements.jobId.value = job.id;
  applicationForm.elements.cv.value = existing.cv;
  applicationForm.elements.coverLetter.value = existing.coverLetter;
  applicationForm.elements.answer.value = existing.answer;
  applicationDialog.showModal();
}

function handleProfileSubmit(event) {
  event.preventDefault();
  state.profile = { ...getProfileFromForm(), updatedAt: Date.now() };
  if (persist("Your search preferences are saved on this device.")) {
    document.querySelector("#profile-saved").textContent = `Saved ${new Date(state.profile.updatedAt).toLocaleString()}`;
    renderJobs();
  }
}

function handleJobSubmit(event) {
  event.preventDefault();
  const data = new FormData(jobForm);
  const job = {
    id: crypto.randomUUID(),
    title: String(data.get("title")).trim(),
    company: String(data.get("company")).trim(),
    country: String(data.get("country") || "").trim(),
    language: String(data.get("language") || "").trim(),
    url: String(data.get("url") || "").trim(),
    description: String(data.get("description")).trim(),
    status: "Saved",
    createdAt: Date.now(),
  };
  state.jobs.push(job);
  if (persist("Opportunity added to your shortlist.")) {
    jobForm.reset();
    jobDialog.close();
    renderJobs();
  } else {
    state.jobs = state.jobs.filter((item) => item.id !== job.id);
  }
}

function handleApplicationSubmit(event) {
  event.preventDefault();
  const job = getJob(applicationForm.elements.jobId.value);
  if (!job) {
    showToast("This opportunity is no longer in your shortlist.");
    return;
  }
  job.applicationPack = {
    cv: applicationForm.elements.cv.value,
    coverLetter: applicationForm.elements.coverLetter.value,
    answer: applicationForm.elements.answer.value,
    updatedAt: Date.now(),
  };
  if (persist("Your application drafts are saved on this device.")) applicationDialog.close();
}

profileForm.addEventListener("submit", handleProfileSubmit);
jobForm.addEventListener("submit", handleJobSubmit);
applicationForm.addEventListener("submit", handleApplicationSubmit);
statusFilter.addEventListener("change", renderJobs);

document.querySelector("#add-job-button").addEventListener("click", () => jobDialog.showModal());
document.querySelector("#copy-application").addEventListener("click", async () => {
  const data = new FormData(applicationForm);
  const text = `CV / PROFILE SUMMARY\n${data.get("cv")}\n\nCOVER LETTER\n${data.get("coverLetter")}\n\nAPPLICATION ANSWER\n${data.get("answer")}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Drafts copied to clipboard.");
  } catch (error) {
    console.error("Could not copy application drafts:", error);
    showToast("Clipboard access is unavailable. You can select and copy each draft.");
  }
});

document.addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close]");
  if (closeButton) document.getElementById(closeButton.dataset.close)?.close();

  const action = event.target.closest("[data-action]");
  if (!action) return;
  const card = action.closest("[data-job-id]");
  if (action.dataset.action === "add") {
    jobDialog.showModal();
  } else if (card && action.dataset.action === "draft") {
    openApplication(card.dataset.jobId);
  } else if (card && action.dataset.action === "delete") {
    const job = getJob(card.dataset.jobId);
    if (!job || !window.confirm(`Remove ${job.title} at ${job.company} and its saved drafts?`)) return;
    const previous = state.jobs;
    state.jobs = state.jobs.filter((item) => item.id !== job.id);
    if (persist("Opportunity removed.")) renderJobs();
    else state.jobs = previous;
  }
});

jobsList.addEventListener("change", (event) => {
  const select = event.target.closest('[data-action="status"]');
  const card = select?.closest("[data-job-id]");
  if (!select || !card) return;
  const job = getJob(card.dataset.jobId);
  if (!job) return;
  const previous = job.status;
  job.status = select.value;
  if (persist("Application status updated.")) renderJobs();
  else job.status = previous;
});

readState();
fillProfile();
renderJobs();
