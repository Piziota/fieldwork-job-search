import html
import json
import re
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


PLATFORMS = {
    "greenhouse": "boards-api.greenhouse.io",
    "lever": "api.lever.co",
    "ashby": "api.ashbyhq.com",
    "smartrecruiters": "api.smartrecruiters.com",
}
SLUG_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
MAX_RESPONSE = 3 * 1024 * 1024


class ConnectorError(Exception):
    pass


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        text = data.strip()
        if text:
            self.parts.append(text)


def _plain_text(value):
    parser = _TextExtractor()
    parser.feed(value or "")
    return html.unescape(" ".join(parser.parts))


class _SameHostRedirect(HTTPRedirectHandler):
    def __init__(self, allowed_host):
        self.allowed_host = allowed_host

    def redirect_request(self, request, response, code, message, headers, new_url):
        from urllib.parse import urlparse

        parsed = urlparse(new_url)
        if parsed.scheme != "https" or parsed.hostname != self.allowed_host or parsed.username or parsed.password:
            raise ConnectorError("The job-board endpoint redirected to an untrusted host.")
        return super().redirect_request(request, response, code, message, headers, new_url)


def _request_json(platform, url):
    host = PLATFORMS[platform]
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "FieldworkJobSearch/1.0"})
    opener = build_opener(_SameHostRedirect(host))
    try:
        with opener.open(request, timeout=15) as response:
            if response.geturl().split("/")[2].split(":")[0] != host:
                raise ConnectorError("The job-board endpoint responded from an unexpected host.")
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ConnectorError("The job-board response exceeded the 3 MB safety limit.")
            return json.loads(raw.decode("utf-8"))
    except HTTPError as error:
        raise ConnectorError("The job-board returned HTTP {}.".format(error.code))
    except URLError as error:
        raise ConnectorError("The job-board could not be reached: {}.".format(error.reason))
    except (UnicodeDecodeError, ValueError):
        raise ConnectorError("The job-board returned invalid JSON.")


def validate_source(platform, slug, company):
    if platform not in PLATFORMS:
        raise ValueError("Choose Greenhouse, Lever, Ashby, or SmartRecruiters.")
    if not isinstance(slug, str) or not SLUG_PATTERN.fullmatch(slug):
        raise ValueError("Board identifier must be 1-100 letters, numbers, dots, underscores, or hyphens.")
    if not isinstance(company, str) or not company.strip() or len(company.strip()) > 120:
        raise ValueError("Company name is required and must be 120 characters or fewer.")
    return slug.strip(), company.strip()


def fetch_jobs(platform, slug, company):
    encoded_slug = quote(slug, safe="._-")
    if platform == "greenhouse":
        payload = _request_json(platform, "https://boards-api.greenhouse.io/v1/boards/{}/jobs?content=true".format(encoded_slug))
        postings = payload.get("jobs", [])
        normalized = []
        for item in postings:
            location = item.get("location") or {}
            normalized.append({
                "external_id": str(item.get("id", "")),
                "title": item.get("title", ""),
                "company": company,
                "location": location.get("name", "") if isinstance(location, dict) else str(location),
                "url": item.get("absolute_url", ""),
                "description": _plain_text(item.get("content", "")),
                "employment_type": "",
            })
        return normalized

    if platform == "lever":
        payload = _request_json(platform, "https://api.lever.co/v0/postings/{}?mode=json".format(encoded_slug))
        if not isinstance(payload, list):
            raise ConnectorError("The Lever board returned an unexpected response.")
        return [{
            "external_id": str(item.get("id", "")),
            "title": item.get("text", ""),
            "company": company,
            "location": (item.get("categories") or {}).get("location", ""),
            "employment_type": (item.get("categories") or {}).get("commitment", ""),
            "url": item.get("hostedUrl", ""),
            "description": item.get("descriptionPlain") or _plain_text(item.get("description", "")),
        } for item in payload]

    if platform == "ashby":
        payload = _request_json(platform, "https://api.ashbyhq.com/posting-api/job-board/{}".format(encoded_slug))
        postings = payload.get("jobs", [])
        return [{
            "external_id": str(item.get("id") or item.get("jobId") or item.get("jobUrl", "")),
            "title": item.get("title", ""),
            "company": company,
            "location": item.get("location", ""),
            "employment_type": item.get("employmentType", ""),
            "url": item.get("jobUrl", ""),
            "description": item.get("descriptionPlain") or _plain_text(item.get("descriptionHtml", "")),
        } for item in postings]

    payload = _request_json(platform, "https://api.smartrecruiters.com/v1/companies/{}/postings?limit=100".format(encoded_slug))
    postings = payload.get("content", [])
    return [{
        "external_id": str(item.get("id", "")),
        "title": item.get("name", ""),
        "company": company,
        "location": (item.get("location") or {}).get("city", ""),
        "country": (item.get("location") or {}).get("country", ""),
        "employment_type": (item.get("typeOfEmployment") or {}).get("label", ""),
        "url": item.get("ref", ""),
        "description": "",
    } for item in postings]
