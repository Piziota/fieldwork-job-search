# Fieldwork

Fieldwork is a local-first job-search workspace for discovering opportunities, tailoring application materials, organizing interviews, and tracking outcomes. It is an original implementation, not a copy of another project.

## Run locally

Requirements: Python 3.9 or newer. The core app uses only the Python standard library.

```bash
python3 server.py
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000). The server binds to loopback by default and stores your profile and job-search data in `data/fieldwork.sqlite3`. Set `FIELDWORK_DB_PATH` to use another database path. Keep a backup of this file; it contains your personal information.

## Features

- Dashboard with saved, applied, interviewing, and offer counts.
- Search profile with target roles, countries, languages, work preferences, salary expectations, and skills.
- Discover and refresh public job listings from Greenhouse, Lever, Ashby, and SmartRecruiters boards.
- Rank jobs against your profile, save interesting roles, and move them through an application pipeline.
- Create and edit role-specific CV and cover-letter drafts, keep a history of application actions, and print or save drafts as PDF from your browser.
- Run a local keyword-coverage check against a posting; it is not a proprietary ATS score or a hiring prediction.
- Track local interview date/time details and prepare question/research notes.
- Suggest skills to develop based on the saved job set and draft learning plans.
- Import Gmail Takeout `.mbox` or `.eml` files locally; review each proposed application-status update before applying it.
- Import and export a JSON backup of your profile, jobs, drafts, and history.

Applications and status changes remain under your control; Fieldwork does not submit job applications automatically.

## Optional integrations

Copy `.env.example` to `.env` and add only the credentials for integrations you choose. Restart the server after changing the file. `.env` is ignored by Git.

- **AI drafting, interview prep, and skills plans:** choose `openai`, `anthropic`, or `gemini` in `FIELDWORK_AI_PROVIDER` and add the matching API key. AI features remain unavailable until configured. Review all generated text before using it.
- **Company research:** set `BRAVE_SEARCH_API_KEY` to enable web search.
- **Notion:** set `NOTION_API_KEY` and `NOTION_DATABASE_ID` to enable one-way synchronization of job tracker fields. It does not sync your candidate profile or application documents. Create a Notion database with a title property (for example `Name`); optional properties include `Company`, `Status`, `Location`, `URL`, `Application language`, `Employment type`, and `Salary`.
- **PDF text extraction:** install the optional dependency with `python3 -m pip install -r requirements.txt`. Without it, PDF imports return an installation message. TXT, Markdown, and DOCX imports use built-in support.

Environment values are read by the local server and are never sent to the browser. Do not expose this development server to the public internet.

## Job-board sources

Add a supported board by its provider and board slug in **Job sources** (for example, Greenhouse board slug `acme`). A source slug is not a general URL. Fieldwork fetches from fixed provider hosts and supports publicly available listings; it does not bypass login pages or scrape arbitrary job sites.

## Gmail and application documents

Email import is a local Gmail Takeout `.mbox`/`.eml` file importer, not a live Gmail OAuth integration. It scans messages for possible application updates and requires your approval for each suggestion. CV and cover-letter drafts are editable text; printing them through the browser can save a PDF, but Fieldwork does not yet provide a fully designed CV template or guarantee ATS parsing results.

## Development and tests

```bash
python3 -m unittest discover -s tests -v
```

No application credentials or external service accounts are required to run the test suite.
