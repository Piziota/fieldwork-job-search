import base64
import binascii
import email
import email.policy
import re
from datetime import timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser


MAX_IMPORT = 2 * 1024 * 1024
MAX_MESSAGES = 1000
STATUS_RULES = [
    ("Hired", ("welcome to the team", "employment agreement signed", "you are joining our team")),
    ("Offer", ("pleased to offer", "offer of employment", "offer letter", "job offer")),
    ("Rejected", ("not been selected", "not moving forward", "unable to offer", "we regret to inform", "application was unsuccessful")),
    ("Interviewing", ("invite you to interview", "interview invitation", "schedule an interview", "interview with our", "first-round interview")),
    ("Screening", ("assessment link", "technical assessment", "complete this assessment", "screening call")),
    ("Applied", ("application received", "thank you for applying", "successfully submitted your application")),
]


class EmailImportError(Exception):
    pass


class _HTMLText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        content = data.strip()
        if content:
            self.parts.append(content)


def _message_body(message):
    if message.is_multipart():
        parts = [part for part in message.walk() if part.get_content_type() == "text/plain" and not part.get_filename()]
        if not parts:
            parts = [part for part in message.walk() if part.get_content_type() == "text/html" and not part.get_filename()]
        chunks = []
        for part in parts[:5]:
            try:
                body = part.get_content()
            except (LookupError, UnicodeDecodeError, AttributeError):
                payload = part.get_payload(decode=True) or b""
                body = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            if part.get_content_type() == "text/html":
                parser = _HTMLText()
                parser.feed(body)
                body = " ".join(parser.parts)
            chunks.append(str(body))
        return " ".join(chunks)[:20000]
    try:
        body = message.get_content()
    except (LookupError, UnicodeDecodeError, AttributeError):
        payload = message.get_payload(decode=True) or b""
        body = payload.decode(message.get_content_charset() or "utf-8", errors="replace")
    if message.get_content_type() == "text/html":
        parser = _HTMLText()
        parser.feed(str(body))
        body = " ".join(parser.parts)
    return str(body)[:20000]


def _split_messages(content):
    # Gmail Takeout exports mbox files with a From_ separator before each message.
    chunks = re.split(br"(?m)^From [^\r\n]*\r?\n", content)
    return [chunk for chunk in chunks if b"\n" in chunk or b"\r" in chunk]


def _status(text):
    lowered = text.lower()
    for status, phrases in STATUS_RULES:
        if any(phrase in lowered for phrase in phrases):
            return status
    return None


def proposals(filename, encoded, jobs):
    if not isinstance(filename, str) or len(filename) > 255:
        raise EmailImportError("Email export filename must be 255 characters or fewer.")
    if not filename.lower().endswith((".mbox", ".eml")):
        raise EmailImportError("Choose an MBOX export or a single EML file.")
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMPORT * 4 // 3) + 8:
        raise EmailImportError("Email export exceeds the 2 MB limit.")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise EmailImportError("Email export is not valid base64 data.")
    if len(content) > MAX_IMPORT:
        raise EmailImportError("Email export exceeds the 2 MB limit.")
    messages = [content] if filename.lower().endswith(".eml") else _split_messages(content)
    if len(messages) > MAX_MESSAGES:
        raise EmailImportError("Email export is limited to 1,000 messages.")

    result = []
    seen = set()
    for raw in messages:
        try:
            message = email.message_from_bytes(raw, policy=email.policy.default)
            subject = str(message.get("subject", ""))[:240]
            body = _message_body(message)
            haystack = (subject + " " + body).lower()
            proposed_status = _status(haystack)
            if not proposed_status:
                continue
            sender = str(message.get("from", ""))[:240]
            sent_at = str(message.get("date", ""))[:120]
            try:
                date = parsedate_to_datetime(sent_at)
                if date and date.tzinfo is None:
                    date = date.replace(tzinfo=timezone.utc)
                sent_at = date.isoformat() if date else sent_at
            except (TypeError, ValueError, OverflowError):
                pass

            for job in jobs:
                company = re.sub(r"[^a-z0-9]", "", job["company"].lower())
                title_words = [word for word in re.findall(r"[a-z0-9]{3,}", job["title"].lower())]
                company_match = len(company) >= 3 and company in re.sub(r"[^a-z0-9]", "", haystack)
                title_match = not title_words or any(word in haystack for word in title_words)
                key = (job["id"], subject, sent_at, proposed_status)
                if company_match and title_match and key not in seen and job["status"] != proposed_status:
                    result.append({
                        "job_id": job["id"],
                        "title": job["title"],
                        "company": job["company"],
                        "current_status": job["status"],
                        "proposed_status": proposed_status,
                        "subject": subject,
                        "sender": sender,
                        "received_at": sent_at,
                    })
                    seen.add(key)
        except (ValueError, TypeError, UnicodeError):
            continue
    return result
