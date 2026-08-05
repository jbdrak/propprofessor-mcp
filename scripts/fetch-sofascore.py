#!/usr/bin/env python3
"""
Fetch today's tennis matches from Sofascore via cloudscraper (bypasses Cloudflare).

Usage: python3 fetch-sofascore.py [YYYY-MM-DD]
Output: JSON array of {homeTeam, awayTeam, startTime, tournament, status}

Sofascore API: /api/v1/sport/tennis/scheduled-events/{date}
"""

import json
import sys
from datetime import datetime, timezone

try:
    import cloudscraper
except ImportError:
    # Distinguish a missing dependency from a legitimate zero-match day:
    # exit non-zero so the Node caller can emit a one-time diagnostic instead
    # of treating this as an empty schedule.
    sys.stderr.write(
        "fetch-sofascore.py: cloudscraper is required (python3 -m pip install cloudscraper)\n"
    )
    sys.exit(3)

date_str = sys.argv[1] if len(sys.argv) > 1 else datetime.now(timezone.utc).strftime("%Y-%m-%d")

url = f"https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/{date_str}"

try:
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "darwin", "mobile": False}
    )
    resp = scraper.get(url, timeout=15)
    resp.raise_for_status()
    data = resp.json()
except Exception:
    print("[]", end="")
    sys.exit(0)

events = data.get("events", [])
matches = []

for event in events:
    home = event.get("homeTeam", {})
    away = event.get("awayTeam", {})
    start_ts = event.get("startTimestamp")
    status = event.get("status", {})
    tournament = event.get("tournament", {})

    if not home.get("name") or not away.get("name"):
        continue

    # Convert startTimestamp to ISO
    if start_ts:
        try:
            dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
            start_iso = dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        except (ValueError, OSError):
            start_iso = ""
    else:
        start_iso = ""

    matches.append({
        "homeTeam": home["name"],
        "awayTeam": away["name"],
        "startTime": start_iso,
        "tournament": tournament.get("name", ""),
        "status": status.get("type", {}).get("description", ""),
    })

print(json.dumps(matches), end="")
