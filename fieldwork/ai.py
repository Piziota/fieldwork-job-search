import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class AIError(Exception):
    pass


def configuration():
    provider = os.environ.get("FIELDWORK_AI_PROVIDER", "").strip().lower()
    providers = {
        "openai": bool(os.environ.get("OPENAI_API_KEY")),
        "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "gemini": bool(os.environ.get("GEMINI_API_KEY")),
    }
    return {
        "provider": provider or None,
        "ready": provider in providers and providers[provider],
        "available_providers": [name for name, configured in providers.items() if configured],
    }


def _post(url, headers, payload):
    request = Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urlopen(request, timeout=45) as response:
            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                raise AIError("AI provider response exceeded the 1 MB safety limit.")
            return json.loads(body.decode("utf-8"))
    except HTTPError as error:
        if error.code in (401, 403):
            raise AIError("The configured AI provider rejected its API key.")
        if error.code == 429:
            raise AIError("The AI provider rate limit was reached.")
        raise AIError("The AI provider returned HTTP {}.".format(error.code))
    except URLError as error:
        raise AIError("The AI provider could not be reached: {}.".format(error.reason))
    except (UnicodeDecodeError, ValueError):
        raise AIError("The AI provider returned an invalid response.")


def generate(prompt):
    config = configuration()
    provider = config["provider"]
    if not config["ready"]:
        raise AIError(
            "AI is not configured. Set FIELDWORK_AI_PROVIDER and its provider API key in your local environment."
        )
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 60000:
        raise ValueError("AI prompt must contain 1-60,000 characters.")

    if provider == "openai":
        response = _post(
            os.environ.get("FIELDWORK_OPENAI_URL", "https://api.openai.com/v1/chat/completions"),
            {"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"], "Content-Type": "application/json"},
            {
                "model": os.environ.get("FIELDWORK_OPENAI_MODEL", "gpt-4o-mini"),
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
            },
        )
        return response["choices"][0]["message"]["content"]

    if provider == "anthropic":
        response = _post(
            os.environ.get("FIELDWORK_ANTHROPIC_URL", "https://api.anthropic.com/v1/messages"),
            {
                "x-api-key": os.environ["ANTHROPIC_API_KEY"],
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            {
                "model": os.environ.get("FIELDWORK_ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
                "max_tokens": 4000,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        return "\n".join(block.get("text", "") for block in response.get("content", []) if block.get("type") == "text")

    response = _post(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent".format(
            quote(os.environ.get("FIELDWORK_GEMINI_MODEL", "gemini-2.0-flash"), safe="-.")
        ),
        {"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]},
        {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4000}},
    )
    return "\n".join(
        part.get("text", "")
        for candidate in response.get("candidates", [])
        for part in candidate.get("content", {}).get("parts", [])
    )
