import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


STATUSES = ("Saved", "Applied", "Screening", "Interviewing", "Offer", "Hired", "Rejected", "Withdrawn", "Archived", "Expired")
OUTCOMES = ("Applied", "Screening", "Interviewing", "Offer", "Hired", "Rejected", "Withdrawn", "Expired")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id():
    return str(uuid.uuid4())


class Database:
    def __init__(self, path=None):
        configured_path = path or os.environ.get("FIELDWORK_DB_PATH")
        self.path = Path(configured_path) if configured_path else Path(__file__).resolve().parent.parent / "data" / "fieldwork.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self):
        connection = sqlite3.connect(str(self.path), timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self):
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS profile (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    data TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sources (
                    id TEXT PRIMARY KEY,
                    platform TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    company TEXT NOT NULL,
                    countries TEXT NOT NULL DEFAULT '[]',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    UNIQUE(platform, slug)
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL DEFAULT 'manual',
                    external_id TEXT,
                    title TEXT NOT NULL,
                    company TEXT NOT NULL,
                    location TEXT NOT NULL DEFAULT '',
                    country TEXT NOT NULL DEFAULT '',
                    language TEXT NOT NULL DEFAULT '',
                    employment_type TEXT NOT NULL DEFAULT '',
                    salary TEXT NOT NULL DEFAULT '',
                    url TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'Saved',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(source, external_id)
                );
                CREATE TABLE IF NOT EXISTS applications (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
                    language TEXT NOT NULL DEFAULT 'English',
                    cv TEXT NOT NULL DEFAULT '',
                    cover_letter TEXT NOT NULL DEFAULT '',
                    answers TEXT NOT NULL DEFAULT '[]',
                    review TEXT NOT NULL DEFAULT '',
                    interview_at TEXT NOT NULL DEFAULT '',
                    interview_prep TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS integration_state (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            application_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(applications)").fetchall()
            }
            if "interview_at" not in application_columns:
                connection.execute("ALTER TABLE applications ADD COLUMN interview_at TEXT NOT NULL DEFAULT ''")

    @staticmethod
    def _json(value, fallback):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _job(row):
        item = dict(row)
        return item

    @staticmethod
    def _application(row):
        item = dict(row)
        item["answers"] = Database._json(item["answers"], [])
        return item

    def get_profile(self):
        with self.connect() as connection:
            row = connection.execute("SELECT data, updated_at FROM profile WHERE id = 1").fetchone()
        if not row:
            return {}
        profile = self._json(row["data"], {})
        profile["updatedAt"] = row["updated_at"]
        return profile

    def save_profile(self, data):
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO profile(id, data, updated_at) VALUES(1, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                (json.dumps(data, ensure_ascii=False), now()),
            )
        return self.get_profile()

    def list_jobs(self, status=None, query=None):
        sql = "SELECT * FROM jobs"
        clauses = []
        values = []
        if status:
            clauses.append("status = ?")
            values.append(status)
        if query:
            clauses.append("(title LIKE ? OR company LIKE ? OR location LIKE ? OR description LIKE ?)")
            needle = "%" + query + "%"
            values.extend((needle, needle, needle, needle))
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY updated_at DESC"
        with self.connect() as connection:
            rows = connection.execute(sql, values).fetchall()
        return [self._job(row) for row in rows]

    def get_job(self, job_id):
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row) if row else None

    def get_job_by_source(self, source, external_id):
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE source = ? AND external_id = ?",
                (source, str(external_id)),
            ).fetchone()
        return self._job(row) if row else None

    def create_job(self, data, source="manual", external_id=None):
        timestamp = now()
        job_id = new_id()
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO jobs(id, source, external_id, title, company, location, country,
                   language, employment_type, salary, url, description, status, created_at, updated_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    job_id, source, external_id, data["title"], data["company"],
                    data.get("location", ""), data.get("country", ""), data.get("language", ""),
                    data.get("employment_type", ""), data.get("salary", ""), data.get("url", ""),
                    data.get("description", ""), data.get("status", "Saved"), timestamp, timestamp,
                ),
            )
            connection.execute(
                "INSERT INTO events(id, job_id, kind, note, created_at) VALUES(?, ?, ?, ?, ?)",
                (new_id(), job_id, "created", "Job added to your search.", timestamp),
            )
        return self.get_job(job_id)

    def upsert_discovered_job(self, data, source, external_id):
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT id FROM jobs WHERE source = ? AND external_id = ?",
                (source, str(external_id)),
            ).fetchone()
            if existing:
                connection.execute(
                    """UPDATE jobs SET title=?, company=?, location=?, country=?, language=?,
                       employment_type=?, salary=?, url=?, description=?, updated_at=? WHERE id=?""",
                    (
                        data["title"], data["company"], data.get("location", ""),
                        data.get("country", ""), data.get("language", ""),
                        data.get("employment_type", ""), data.get("salary", ""),
                        data.get("url", ""), data.get("description", ""), now(), existing["id"],
                    ),
                )
                job_id = existing["id"]
            else:
                timestamp = now()
                job_id = new_id()
                connection.execute(
                    """INSERT INTO jobs(id, source, external_id, title, company, location, country,
                       language, employment_type, salary, url, description, status, created_at, updated_at)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Saved', ?, ?)""",
                    (
                        job_id, source, str(external_id), data["title"], data["company"],
                        data.get("location", ""), data.get("country", ""), data.get("language", ""),
                        data.get("employment_type", ""), data.get("salary", ""), data.get("url", ""),
                        data.get("description", ""), timestamp, timestamp,
                    ),
                )
                connection.execute(
                    "INSERT INTO events(id, job_id, kind, note, created_at) VALUES(?, ?, ?, ?, ?)",
                    (new_id(), job_id, "discovered", "Found in a configured public job-board feed.", timestamp),
                )
        return self.get_job(job_id)

    def update_job(self, job_id, changes):
        allowed = {"title", "company", "location", "country", "language", "employment_type", "salary", "url", "description", "status"}
        updates = {key: value for key, value in changes.items() if key in allowed}
        if not updates:
            return self.get_job(job_id)
        assignments = ", ".join(key + " = ?" for key in updates)
        with self.connect() as connection:
            previous = connection.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not previous:
                return None
            connection.execute(
                "UPDATE jobs SET " + assignments + ", updated_at = ? WHERE id = ?",
                list(updates.values()) + [now(), job_id],
            )
            if "status" in updates and updates["status"] != previous["status"]:
                connection.execute(
                    "INSERT INTO events(id, job_id, kind, note, created_at) VALUES(?, ?, ?, ?, ?)",
                    (new_id(), job_id, "status", updates["status"], now()),
                )
        return self.get_job(job_id)

    def delete_job(self, job_id):
        with self.connect() as connection:
            cursor = connection.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        return cursor.rowcount > 0

    def list_sources(self):
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM sources ORDER BY company COLLATE NOCASE").fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["countries"] = self._json(item["countries"], [])
            item["enabled"] = bool(item["enabled"])
            result.append(item)
        return result

    def add_source(self, platform, slug, company, countries):
        source_id = new_id()
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO sources(id, platform, slug, company, countries, created_at)
                   VALUES(?, ?, ?, ?, ?, ?)""",
                (source_id, platform, slug, company, json.dumps(countries), now()),
            )
        return next(source for source in self.list_sources() if source["id"] == source_id)

    def delete_source(self, source_id):
        with self.connect() as connection:
            cursor = connection.execute("DELETE FROM sources WHERE id = ?", (source_id,))
        return cursor.rowcount > 0

    def get_application(self, application_id):
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM applications WHERE id = ?", (application_id,)).fetchone()
        return self._application(row) if row else None

    def get_application_for_job(self, job_id):
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM applications WHERE job_id = ?", (job_id,)).fetchone()
        return self._application(row) if row else None

    def list_applications(self):
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT applications.*, jobs.title, jobs.company, jobs.status, jobs.url
                   FROM applications JOIN jobs ON jobs.id = applications.job_id
                   ORDER BY applications.updated_at DESC"""
            ).fetchall()
        applications = [dict(row, answers=self._json(row["answers"], [])) for row in rows]
        for application in applications:
            application["events"] = self.list_events(application["job_id"])
        return applications

    def save_application(self, job_id, values):
        timestamp = now()
        application_id = new_id()
        with self.connect() as connection:
            row = connection.execute("SELECT id FROM applications WHERE job_id = ?", (job_id,)).fetchone()
            if row:
                application_id = row["id"]
                updates = {
                    key: values[key] for key in ("language", "cv", "cover_letter", "answers", "review", "interview_at", "interview_prep")
                    if key in values
                }
                if updates:
                    assignments = ", ".join(key + " = ?" for key in updates)
                    encoded = [json.dumps(value, ensure_ascii=False) if key == "answers" else value for key, value in updates.items()]
                    connection.execute(
                        "UPDATE applications SET " + assignments + ", updated_at = ? WHERE id = ?",
                        encoded + [timestamp, application_id],
                    )
            else:
                connection.execute(
                    """INSERT INTO applications(id, job_id, language, cv, cover_letter, answers, review,
                       interview_at, interview_prep, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        application_id, job_id, values.get("language", "English"), values.get("cv", ""),
                        values.get("cover_letter", ""), json.dumps(values.get("answers", []), ensure_ascii=False),
                        values.get("review", ""), values.get("interview_at", ""), values.get("interview_prep", ""), timestamp, timestamp,
                    ),
                )
        return self.get_application(application_id)

    def add_event(self, job_id, kind, note, created_at=None):
        event_id = new_id()
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO events(id, job_id, kind, note, created_at) VALUES(?, ?, ?, ?, ?)",
                (event_id, job_id, kind, note, created_at or now()),
            )
        return event_id

    def list_events(self, job_id):
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM events WHERE job_id = ? ORDER BY created_at DESC",
                (job_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_integration_state(self, name):
        with self.connect() as connection:
            row = connection.execute("SELECT value FROM integration_state WHERE name = ?", (name,)).fetchone()
        return row["value"] if row else None

    def set_integration_state(self, name, value):
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO integration_state(name, value) VALUES(?, ?) "
                "ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                (name, value),
            )

    def dashboard(self):
        jobs = self.list_jobs()
        application_count = sum(job["status"] in ("Applied", "Screening", "Interviewing", "Offer", "Hired") for job in jobs)
        counts = {status: sum(job["status"] == status for job in jobs) for status in STATUSES}
        with self.connect() as connection:
            followups = connection.execute(
                """SELECT jobs.id AS job_id, jobs.title, jobs.company, applications.updated_at
                   FROM applications JOIN jobs ON jobs.id = applications.job_id
                   WHERE jobs.status IN ('Applied', 'Screening', 'Interviewing')
                   ORDER BY applications.updated_at"""
            ).fetchall()
        return {
            "total": len(jobs),
            "applications": application_count,
            "interviews": counts["Interviewing"],
            "pipeline": counts,
            "followups": [dict(row) for row in followups],
        }

    def export_data(self):
        jobs = self.list_jobs()
        events = []
        for job in jobs:
            events.extend(self.list_events(job["id"]))
        return {
            "version": 1,
            "exported_at": now(),
            "profile": self.get_profile(),
            "jobs": jobs,
            "applications": self.list_applications(),
            "events": events,
        }
