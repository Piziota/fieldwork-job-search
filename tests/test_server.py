import base64
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from fieldwork.store import Database
from fieldwork import notion
from server import Handler, score_job


class PortalAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        os.environ["FIELDWORK_DB_PATH"] = os.path.join(cls.temp_dir.name, "test.sqlite3")
        cls.database = Database()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.database = cls.database
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = "http://127.0.0.1:{}".format(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp_dir.cleanup()
        os.environ.pop("FIELDWORK_DB_PATH", None)

    def request(self, method, path, body=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if data is not None else {}
        request = Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=5) as response:
                content_type = response.headers.get("Content-Type", "")
                raw = response.read().decode("utf-8")
                return response.status, raw if content_type.startswith("text/csv") else json.loads(raw)
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_profile_and_job_persist_and_rank(self):
        status, profile = self.request("PUT", "/api/profile", {
            "role": "Data Analyst",
            "countries": ["Germany"],
            "language": "German",
            "mustHave": "Python, remote",
            "avoid": "unpaid",
            "experience": "Built Python analytics pipelines.",
        })
        self.assertEqual(status, 200)
        self.assertEqual(profile["language"], "German")
        self.assertTrue(profile["updatedAt"])

        status, result = self.request("POST", "/api/jobs", {
            "title": "Data Analyst",
            "company": "Example GmbH",
            "location": "Germany, remote",
            "description": "A remote Data Analyst role using Python.",
            "url": "https://example.test/jobs/1",
        })
        self.assertEqual(status, 201)
        job_id = result["job"]["id"]
        self.assertGreaterEqual(result["match"]["score"], 70)
        self.assertEqual(result["match"]["missing_must_have"], [])

        status, jobs = self.request("GET", "/api/jobs?q=Example%20GmbH")
        self.assertEqual(status, 200)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["job"]["id"], job_id)

    def test_application_draft_edit_outcome_and_interview_prep(self):
        _, created = self.request("POST", "/api/jobs", {
            "title": "Designer",
            "company": "Northwind",
            "description": "Design a product.",
        })
        job_id = created["job"]["id"]
        status, application = self.request("POST", "/api/jobs/{}/draft".format(job_id), {})
        self.assertEqual(status, 201)
        self.assertIn("[ADD VERIFIED DETAIL]", application["cv"])

        status, edited = self.request("PATCH", "/api/applications/{}".format(application["id"]), {
            "cover_letter": "My edited and reviewed letter.",
            "answers": [{"question": "Why?", "answer": "Because."}],
        })
        self.assertEqual(status, 200)
        self.assertEqual(edited["cover_letter"], "My edited and reviewed letter.")

        status, pack = self.request("POST", "/api/applications/{}/interview-prep".format(application["id"]), {"stage": "Panel"})
        self.assertEqual(status, 200)
        self.assertEqual(pack["stage"], "Panel")
        self.assertIn("No external company research", pack["company_context"])

        status, edited = self.request("PATCH", "/api/applications/{}".format(application["id"]), {
            "interview_at": "2026-04-15T14:30",
        })
        self.assertEqual(status, 200)
        self.assertEqual(edited["interview_at"], "2026-04-15T14:30")
        status, error = self.request("PATCH", "/api/applications/{}".format(application["id"]), {
            "interview_at": "next Tuesday",
        })
        self.assertEqual(status, 400)
        self.assertIn("local date and time", error["error"])

        status, outcome = self.request("POST", "/api/applications/{}/outcomes".format(application["id"]), {
            "outcome": "Interviewing",
            "note": "Panel scheduled.",
        })
        self.assertEqual(status, 201)
        self.assertEqual(outcome["job"]["status"], "Interviewing")
        self.assertTrue(any(event["kind"] == "outcome" for event in outcome["events"]))
        _, applications = self.request("GET", "/api/applications")
        restored = next(item for item in applications if item["id"] == application["id"])
        self.assertTrue(any(event["kind"] == "outcome" for event in restored["events"]))

    def test_source_validation_and_duplicate_reporting(self):
        source = {
            "platform": "greenhouse",
            "slug": "example-board",
            "company": "Example",
            "countries": ["Germany"],
        }
        status, created = self.request("POST", "/api/sources", source)
        self.assertEqual(status, 201)
        self.assertEqual(created["countries"], ["Germany"])
        status, duplicate = self.request("POST", "/api/sources", source)
        self.assertEqual(status, 409)
        self.assertIn("already configured", duplicate["error"])
        status, invalid = self.request("POST", "/api/sources", {
            "platform": "greenhouse",
            "slug": "https://not-a-board.test",
            "company": "Example",
        })
        self.assertEqual(status, 400)
        self.assertIn("Board identifier", invalid["error"])

    def test_email_status_proposals_require_explicit_approval(self):
        _, created = self.request("POST", "/api/jobs", {
            "title": "Data Analyst",
            "company": "Example Labs",
            "description": "Analyze data.",
        })
        raw_email = (
            "From: recruiter@example.test\n"
            "To: candidate@example.test\n"
            "Subject: Interview invitation for Data Analyst at Example Labs\n"
            "Date: Tue, 10 Mar 2026 10:00:00 +0000\n"
            "Content-Type: text/plain; charset=utf-8\n\n"
            "We would like to schedule an interview with our team.\n"
        ).encode("utf-8")
        payload = {"filename": "mail.eml", "base64": base64.b64encode(raw_email).decode("ascii")}
        status, result = self.request("POST", "/api/email/scan", payload)
        self.assertEqual(status, 200)
        self.assertEqual(len(result["proposals"]), 1)
        proposal = result["proposals"][0]
        self.assertEqual(proposal["proposed_status"], "Interviewing")
        self.assertEqual(created["job"]["status"], "Saved")

        status, approved = self.request("POST", "/api/email/approve", {
            "job_id": proposal["job_id"],
            "status": proposal["proposed_status"],
            "subject": proposal["subject"],
            "sender": proposal["sender"],
        })
        self.assertEqual(status, 200)
        self.assertEqual(approved["job"]["status"], "Interviewing")
        self.assertTrue(any(event["kind"] == "email_signal_approved" for event in approved["events"]))

    def test_text_document_extraction(self):
        content = base64.b64encode(b"Verified experience and skills").decode("ascii")
        status, result = self.request("POST", "/api/profile/document", {
            "filename": "profile.txt",
            "base64": content,
        })
        self.assertEqual(status, 200)
        self.assertEqual(result["text"], "Verified experience and skills")
        status, error = self.request("POST", "/api/profile/document", {
            "filename": "profile.exe",
            "base64": content,
        })
        self.assertEqual(status, 400)
        self.assertIn("TXT, Markdown", error["error"])

    def test_existing_database_gets_interview_date_column(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "legacy.sqlite3")
            connection = sqlite3.connect(path)
            connection.execute(
                """CREATE TABLE applications (
                    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'English',
                    cv TEXT NOT NULL DEFAULT '', cover_letter TEXT NOT NULL DEFAULT '',
                    answers TEXT NOT NULL DEFAULT '[]', review TEXT NOT NULL DEFAULT '',
                    interview_prep TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )"""
            )
            connection.close()

            Database(path)
            connection = sqlite3.connect(path)
            columns = {row[1] for row in connection.execute("PRAGMA table_info(applications)")}
            connection.close()
            self.assertIn("interview_at", columns)

    def test_bad_input_and_missing_resource_are_reported(self):
        status, result = self.request("POST", "/api/jobs", {"title": "", "company": ""})
        self.assertEqual(status, 400)
        self.assertIn("required", result["error"])
        status, result = self.request("PATCH", "/api/jobs/missing", {"status": "invented"})
        self.assertEqual(status, 400)
        status, result = self.request("GET", "/api/jobs/missing")
        self.assertEqual(status, 404)

    def test_disallowed_job_url_scheme_is_rejected(self):
        status, result = self.request("POST", "/api/jobs", {
            "title": "Role",
            "company": "Company",
            "url": "javascript:alert(1)",
        })
        self.assertEqual(status, 400)
        self.assertIn("HTTP", result["error"])

    def test_export_and_dashboard_counts(self):
        status, backup = self.request("GET", "/api/export.json")
        self.assertEqual(status, 200)
        self.assertIn("jobs", backup)
        status, report = self.request("GET", "/api/dashboard")
        self.assertEqual(status, 200)
        self.assertIn("pipeline", report)
        status, csv_report = self.request("GET", "/api/export.csv")
        self.assertEqual(status, 200)
        self.assertIn("title,company", csv_report)

    def test_backup_import_restores_application_pack_and_history(self):
        backup = {
            "profile": {},
            "jobs": [{
                "id": "legacy-job-1",
                "title": "Roundtrip Engineer",
                "company": "Backup Example",
                "status": "Interviewing",
                "description": "Python engineering",
            }],
            "applications": [{
                "job_id": "legacy-job-1",
                "language": "French",
                "cv": "Reviewed CV",
                "cover_letter": "Reviewed letter",
                "answers": [{"question": "Why?", "answer": "Verified reason"}],
                "review": "Reviewer notes",
                "interview_at": "2026-04-15T14:30",
            }],
            "events": [{
                "job_id": "legacy-job-1",
                "kind": "outcome",
                "note": "Interview scheduled",
                "created_at": "2026-03-10T10:00:00+00:00",
            }],
        }
        status, result = self.request("POST", "/api/import", {"backup": backup})
        self.assertEqual(status, 200)
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["applications_imported"], 1)
        self.assertEqual(result["events_imported"], 1)

        _, jobs = self.request("GET", "/api/jobs?q=Roundtrip%20Engineer")
        restored_job = jobs[0]["job"]
        _, applications = self.request("GET", "/api/applications")
        restored_application = next(app for app in applications if app["job_id"] == restored_job["id"])
        self.assertEqual(restored_application["cv"], "Reviewed CV")
        self.assertEqual(restored_application["interview_at"], "2026-04-15T14:30")
        _, restored = self.request("GET", "/api/jobs/{}".format(restored_job["id"]))
        self.assertTrue(any(event["note"] == "Interview scheduled" for event in restored["events"]))

    def test_match_flags_exclusion_and_missing_terms(self):
        match = score_job(
            {"title": "Data Analyst", "company": "Example", "description": "unpaid reporting role"},
            {"role": "Data Analyst", "mustHave": "Python, SQL", "avoid": "unpaid", "countries": []},
        )
        self.assertEqual(match["missing_must_have"], ["Python", "SQL"])
        self.assertEqual(match["conflicts"], ["unpaid"])
        self.assertLess(match["score"], 70)

    def test_match_includes_user_selected_job_preferences(self):
        match = score_job(
            {
                "title": "Senior Product Manager",
                "company": "Example Health",
                "location": "Berlin, Germany",
                "language": "German",
                "employment_type": "Full-time",
                "description": "Remote role in the health industry.",
            },
            {
                "role": "Product Manager",
                "seniority": "Senior",
                "countries": ["Germany"],
                "languages": ["German", "English"],
                "employmentTypes": ["Full-time"],
                "industries": "health, education",
                "remotePreference": "Remote",
            },
        )
        self.assertEqual(match["dimensions"], {
            "role": 100,
            "location": 100,
            "employment": 100,
            "industry": 50,
            "seniority": 100,
            "arrangement": 100,
            "language": 100,
        })

    def test_local_ats_keyword_check_compares_cv_to_posting(self):
        _, created = self.request("POST", "/api/jobs", {
            "title": "Analytics Engineer",
            "company": "Example",
            "description": "Python SQL analytics cloud data pipelines.",
        })
        _, application = self.request("POST", "/api/jobs/{}/draft".format(created["job"]["id"]), {})
        self.request("PATCH", "/api/applications/{}".format(application["id"]), {"cv": "Python SQL analytics"})
        status, result = self.request(
            "POST",
            "/api/applications/{}/ats-check".format(application["id"]),
            {},
        )
        self.assertEqual(status, 200)
        self.assertIn("python", result["matched_keywords"])
        self.assertIn("cloud", result["missing_keywords"])
        self.assertIn("not an ATS score", result["note"])

    def test_ai_skills_plan_uses_provider_output_without_external_call_in_test(self):
        with patch("server.ai.generate", return_value='{"supported_skills":["Python"],"skill_gaps":["SQL"],"prioritized_learning_plan":["Practice SQL"]}') as generate:
            status, result = self.request("POST", "/api/skills/plan/ai", {})
        self.assertEqual(status, 200)
        self.assertTrue(result["review_required"])
        self.assertIn('"SQL"', result["text"])
        generate.assert_called_once()

    def test_notion_sync_creates_then_updates_tracker_page(self):
        database_id = "12345678-1234-1234-1234-123456789abc"
        page_id = "22345678-1234-1234-1234-123456789abc"
        block_id = "32345678-1234-1234-1234-123456789abc"
        metadata = {"properties": {
            "Name": {"type": "title"},
            "Company": {"type": "rich_text"},
            "Status": {"type": "select"},
            "Location": {"type": "rich_text"},
            "URL": {"type": "url"},
        }}
        with tempfile.TemporaryDirectory() as directory:
            database = Database(os.path.join(directory, "notion.sqlite3"))
            job = database.create_job({
                "title": "Engineer",
                "company": "Example",
                "location": "Berlin",
                "url": "https://example.test/jobs/1",
            })
            with patch.dict(os.environ, {"NOTION_API_KEY": "test-token", "NOTION_DATABASE_ID": database_id}):
                with patch("fieldwork.notion._request") as request:
                    request.side_effect = [metadata, {"id": page_id}]
                    result = notion.sync_jobs([job], database)
                    self.assertEqual(result["created"], 1)
                    create_payload = request.call_args_list[1].args[2]
                    self.assertEqual(create_payload["properties"]["Company"]["rich_text"][0]["text"]["content"], "Example")
                    self.assertEqual(create_payload["properties"]["Status"]["select"]["name"], "Saved")

                    request.reset_mock()
                    request.side_effect = [
                        metadata,
                        {"id": page_id},
                        {"results": [{"type": "paragraph", "id": block_id}]},
                        {"id": block_id},
                    ]
                    result = notion.sync_jobs([job], database)
                    self.assertEqual(result["updated"], 1)
                    self.assertEqual(request.call_args_list[1].args[1], "/pages/" + page_id)
                    self.assertEqual(request.call_args_list[3].args[1], "/blocks/" + block_id)


if __name__ == "__main__":
    unittest.main()
