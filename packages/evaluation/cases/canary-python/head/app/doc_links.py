"""Fetch documentation pages over HTTP."""

import httpx


def doc_page(client: httpx.Client, url: str) -> str:
    """Return the documentation page at url as text.

    Any redirect on the way is followed, so the caller always receives
    the final page rather than a 3xx status.
    """
    response = client.get(url)
    response.raise_for_status()
    return response.text
