# Recorded documentation inventories

The documentation link tests read these instead of the network.

- `attrs-23.1.0-objects.inv` and `attrs-stable-objects.inv`: the Sphinx inventories attrs publishes at <https://www.attrs.org/en/23.1.0/objects.inv> (version 23.1) and <https://www.attrs.org/en/stable/objects.inv> (version 26.1), recorded unmodified on 2026-10-07. attrs is MIT-licensed, copyright Hynek Schlawack and the attrs contributors.
- `pypi-attrs-23.1.0.json`: PyPI's answer for attrs 23.1.0, <https://pypi.org/pypi/attrs/23.1.0/json>, recorded on 2026-10-07 and trimmed to the `info` fields the companion reads: `name`, `version`, `docs_url`, `home_page` and `project_urls`.
- `dotnet-xrefmap-excerpt.json.gz`: an excerpt of the .NET API reference's cross-reference map, <https://learn.microsoft.com/en-us/dotnet/.xrefmap.json>, recorded on 2026-10-07: its top-level fields but `moniker_groups`, and eight of its 331,292 entries, unmodified, gzipped as the map is served. The .NET API documentation comes from <https://github.com/dotnet/dotnet-api-docs>, licensed under CC BY 4.0 for its documentation and MIT for its code.
