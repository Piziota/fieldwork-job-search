import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class ResearchError(Exception):
    pass


def configured():
    return bool(os.environ.get("BRAVE_SEARCH_API_KEY"))


def search_company(job):
    api_key = os.environ.get("BRAVE_SEARCH_API_KEY")
    if not api_key:
        raise ResearchError("Set BRAVE_SEARCH_API_KEY in the local server environment to enable company research.")
    query = "{} {} official company careers about".format(job["company"], job["country"] or job["location"])
    url = "https://api.search.brave.com/res/v1/web/search?" + urlencode({"q": query, "count": 6})
    request = Request(url, headers={
        "Accept": "application/json",
        "X-Subscription-Token": api_key,
        "User-Agent": "FieldworkJobSearch/1.0",
    })
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                raise ResearchError("Search provider response exceeded the 1 MB safety limit.")
            payload = json.loads(body.decode("utf-8"))
    except HTTPError as error:
        if error.code in (401, 403):
            raise ResearchError("The search provider rejected its API key.")
        if error.code == 429:
            raise ResearchError("The search provider rate limit was reached.")
        raise ResearchError("Search provider returned HTTP {}.".format(error.code))
    except URLError as error:
        raise ResearchError("Search provider could not be reached: {}.".format(error.reason))
    except (UnicodeDecodeError, ValueError):
        raise ResearchError("Search provider returned invalid JSON.")

    results = []
    for item in payload.get("web", {}).get("results", [])[:6]:
        link = item.get("url", "")
        if not isinstance(link, str) or not link.startswith("https://"):
            continue
        results.append({
            "title": str(item.get("title", ""))[:240],
            "url": link[:2000],
            "description": str(item.get("description", ""))[:1000],
        })
    return results
