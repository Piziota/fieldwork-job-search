# Job Search Portal

A local-first job search workspace for setting your target countries and application language, reviewing jobs against your requirements, and preparing editable application drafts.

## Run locally

No dependencies or build step are needed. With Python 3 installed:

```bash
python3 -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000) from this project directory.

Alternatively, open `index.html` directly in a browser. Data is kept in that browser's local storage; clearing browser site data removes it. Do not use a shared browser for personal information.

## Current scope

- Save job-search preferences, target countries, and application language.
- Add job postings manually and view an explainable match score.
- Create editable CV, cover-letter, and application-answer drafts from information you provide.
- Track a job as saved, applied, or interviewing.

The application-language preference is recorded, but draft templates are currently in English. Drafts are not AI-generated or verified claims. Review and correct every draft before using it. The app does not fetch postings, upload documents, or submit applications.

## Privacy

The app runs without external requests and does not send profile, job, or application data to a server. It stores that information in browser local storage on this device.
