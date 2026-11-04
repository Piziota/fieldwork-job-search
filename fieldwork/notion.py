import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class NotionError(Exception):
    pass


def configured():
    return bool(os.environ.get("NOTION_API_KEY") and os.environ.get("NOTION_DATABASE_ID"))


def _rich_text(value):
    return [{"type": "text", "text": {"content": str(value)[:2000]}}]


def _page_properties(job, database_properties, title_property):
    title = "{} — {}".format(job["company"], job["title"])[:2000]
    result = {title_property: {"title": _rich_text(title)}}
    optional_fields = {
        "Company": (job["company"], {"rich_text"}),
        "Status": (job["status"], {"select", "status"}),
        "Location": (job["location"] or job["country"], {"rich_text"}),
        "URL": (job["url"] or None, {"url"}),
        "Application language": (job["language"], {"rich_text"}),
        "Employment type": (job["employment_type"], {"rich_text"}),
        "Salary": (job["salary"], {"rich_text"}),
    }
    for name, (value, supported_types) in optional_fields.items():
        if name == title_property:
            continue
        property_info = database_properties.get(name, {})
        if not isinstance(property_info, dict):
            continue
        kind = property_info.get("type")
        if value and kind in supported_types:
            if kind in ("select", "status"):
                result[name] = {kind: {"name": str(value)[:100]}}
            elif kind == "url":
                result[name] = {"url": str(value)[:2000]}
            else:
                result[name] = {kind: _rich_text(value)}
    return result


def _sync_summary_block(page_id, summary):
    response = _request("GET", "/blocks/{}/children?page_size=100".format(page_id))
    blocks = response.get("results", []) if isinstance(response, dict) else None
    if not isinstance(blocks, list):
        raise NotionError("Notion returned an invalid page-content response.")
    for block in blocks:
        block_id = block.get("id")
        if block.get("type") == "paragraph" and isinstance(block_id, str) and re.fullmatch(r"[A-Fa-f0-9-]{32,36}", block_id):
            _request("PATCH", "/blocks/{}".format(block["id"]), {
                "paragraph": {"rich_text": _rich_text(summary[:2000])},
            })
            return
    _request("POST", "/blocks/{}/children".format(page_id), {
        "children": [{
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": _rich_text(summary[:2000])},
        }],
    })


def _request(method, endpoint, payload=None):
    token = os.environ.get("NOTION_API_KEY")
    if not token:
        raise NotionError("Set NOTION_API_KEY in the local server environment.")
    headers = {
        "Authorization": "Bearer " + token,
        "Notion-Version": os.environ.get("FIELDWORK_NOTION_VERSION", "2022-06-28"),
        "Content-Type": "application/json",
    }
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request("https://api.notion.com/v1" + endpoint, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise NotionError("Notion API response exceeded the 1 MB safety limit.")
            return json.loads(raw.decode("utf-8")) if raw else {}
    except HTTPError as error:
        if error.code in (401, 403):
            raise NotionError("Notion rejected the integration token or database access.")
        if error.code == 404:
            raise NotionError("Notion database was not found or was not shared with the integration.")
        raise NotionError("Notion API returned HTTP {}.".format(error.code))
    except URLError as error:
        raise NotionError("Notion API could not be reached: {}.".format(error.reason))
    except (UnicodeDecodeError, ValueError):
        raise NotionError("Notion API returned invalid JSON.")


def sync_jobs(jobs, database):
    if not configured():
        raise NotionError("Set NOTION_API_KEY and NOTION_DATABASE_ID in the local server environment.")
    database_id = os.environ["NOTION_DATABASE_ID"]
    if not re.fullmatch(r"[A-Fa-f0-9-]{32,36}", database_id):
        raise NotionError("NOTION_DATABASE_ID must be a Notion database UUID.")
    metadata = _request("GET", "/databases/" + database_id)
    if not isinstance(metadata, dict):
        raise NotionError("Notion returned invalid database details.")
    properties = metadata.get("properties", {})
    if not isinstance(properties, dict):
        raise NotionError("Notion returned an invalid database property list.")
    title_property = next(
        (name for name, value in properties.items() if isinstance(value, dict) and value.get("type") == "title"),
        None,
    )
    if not title_property:
        raise NotionError("The target Notion database has no title property.")

    created = updated = 0
    for job in jobs:
        page_key = "notion.page." + job["id"]
        page_id = database.get_integration_state(page_key)
        properties_payload = _page_properties(job, properties, title_property)
        summary = "\n".join(filter(None, [
            "Status: " + job["status"],
            "Location: " + (job["location"] or job["country"]),
            "Application language: " + job["language"],
            "Employment: " + job["employment_type"],
            "Salary: " + job["salary"],
            "Posting: " + job["url"],
        ]))
        summary = summary[:2000] or "No additional details."
        if page_id:
            if not re.fullmatch(r"[A-Fa-f0-9-]{32,36}", page_id):
                raise NotionError("Stored Notion page ID is invalid; clear the local integration mapping and sync again.")
            _request("PATCH", "/pages/" + page_id, {"properties": properties_payload})
            _sync_summary_block(page_id, summary)
            updated += 1
            continue
        children = [{
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": _rich_text(summary)},
        }]
        page = _request("POST", "/pages", {
            "parent": {"database_id": database_id},
            "properties": properties_payload,
            "children": children,
        })
        if not isinstance(page, dict) or not page.get("id"):
            raise NotionError("Notion did not return a page ID.")
        if not re.fullmatch(r"[A-Fa-f0-9-]{32,36}", page["id"]):
            raise NotionError("Notion returned an invalid page ID.")
        database.set_integration_state(page_key, page["id"])
        created += 1
    return {"created": created, "updated": updated, "sent_fields": ["job title", "company", "status", "location", "application language", "employment type", "salary", "posting URL"]}
