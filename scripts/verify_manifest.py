#!/usr/bin/env python3
"""Verify every document in data/manifest.yaml resolves against the Federal Register API.

Checks that each doc_number exists and that the manifest's recorded publication_date,
fr_type, action and page_length still match the API. Exits non-zero on any mismatch,
so it can be wired into CI as a data-drift guard.

Usage:  python3 scripts/verify_manifest.py
"""

import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

import yaml

API = "https://www.federalregister.gov/api/v1/documents"
FIELDS = ["publication_date", "type", "action", "page_length", "docket_ids"]
CHECKED = {
    "publication_date": "publication_date",
    "fr_type": "type",
    "action": "action",
    "page_length": "page_length",
}


def fetch(doc_number):
    url = f"{API}/{doc_number}.json?" + "&".join(f"fields[]={f}" for f in FIELDS)
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.load(resp)


def main():
    manifest_path = Path(__file__).resolve().parent.parent / "data" / "manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())

    status_map = manifest["status_map"]
    failures = []
    total = 0

    for proceeding in manifest["proceedings"]:
        print(f"\n{proceeding['id']}  ({proceeding['role']})")
        for version in proceeding["versions"]:
            doc = version["doc_number"]
            total += 1
            try:
                api = fetch(doc)
            except Exception as exc:  # network, 404, malformed JSON
                failures.append(f"{doc}: fetch failed — {exc}")
                print(f"  {doc}  FETCH FAILED  {exc}")
                continue

            # YAML parses unquoted ISO dates into datetime.date; the API returns strings.
            norm = lambda v: v.isoformat() if isinstance(v, date) else v

            diffs = [
                f"{key}: manifest={version[key]!r} api={api.get(api_key)!r}"
                for key, api_key in CHECKED.items()
                if key in version and norm(version[key]) != api.get(api_key)
            ]

            # The status field must stay derivable from the API's action string.
            expected = status_map.get(api.get("action"))
            if expected is None:
                diffs.append(f"action {api.get('action')!r} missing from status_map")
            elif expected != version.get("status"):
                diffs.append(f"status: manifest={version.get('status')!r} derived={expected!r}")

            if diffs:
                failures.extend(f"{doc}: {d}" for d in diffs)
                print(f"  {doc}  MISMATCH")
                for d in diffs:
                    print(f"      {d}")
            else:
                print(f"  {doc}  ok   {version['label']}")

    print(f"\n{total - len(failures)}/{total} checks passed")
    if failures:
        print(f"\n{len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
