#!/usr/bin/env python3
"""
flashscore_tennis.py — Scrape tennis schedule from Flashscore (3-day window).

Scrapes yesterday, today, and tomorrow to catch delayed/rescheduled matches.
Uses Playwright to render the JS-heavy page and extract match data.
Writes JSON to stdout for the Node.js wrapper to consume.

Usage:
  python3 scripts/flashscore_tennis.py                    # today +/- 1 day
  python3 scripts/flashscore_tennis.py --date 2026-07-30  # specific center date

Timezone: Sets browser to America/Chicago so times are CDT/CST.
"""

import sys
import json
import argparse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("America/Chicago")


def local_date_string():
    return datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"error": "playwright not installed. Run: pip3 install playwright && playwright install chromium"}))
    sys.exit(1)

EXTRACT_JS = """() => {
    // Flashscore splits ATP/WTA and Challenger/ITF into separate containers.
    // Scrape every container; selecting only the largest one drops the main tour.
    const containers = Array.from(document.querySelectorAll('.sportName.tennis'));
    if (!containers.length) return { error: "no container found" };

    const results = [];

    for (const container of containers) {
        const children = Array.from(container.children);
        let currentTournament = "";
        let currentCategory = "";
        let currentSurface = "";

        for (const el of children) {
            const cls = typeof el.className === "string" ? el.className : "";

            if (cls.includes("headerLeague")) {
                const text = el.textContent.trim();

                const catMatch = text.match(
                    /(ATP\\s*-\\s*SINGLES|WTA\\s*-\\s*SINGLES|ATP\\s*-\\s*DOUBLES|WTA\\s*-\\s*DOUBLES|CHALLENGER\\s+MEN\\s*-\\s*SINGLES|CHALLENGER\\s+WOMEN\\s*-\\s*SINGLES|CHALLENGER\\s+MEN\\s*-\\s*DOUBLES|CHALLENGER\\s+WOMEN\\s*-\\s*DOUBLES|ITF\\s+MEN\\s*-\\s*SINGLES|ITF\\s+WOMEN\\s*-\\s*SINGLES|ITF\\s+MEN\\s*-\\s*DOUBLES|ITF\\s+WOMEN\\s*-\\s*DOUBLES)/i
                );
                currentCategory = catMatch ? catMatch[1] : "";

                const catIdx = text.indexOf(currentCategory);
                if (catIdx > 0) {
                    let raw = text.substring(0, catIdx).trim();
                    currentTournament = raw.replace(/,\\s*(hard|clay|grass|carpet)\\s*$/i, "").trim();
                } else {
                    currentTournament = text.substring(0, 60);
                }

                const surfMatch = text.match(/,\\s*(hard|clay|grass|carpet)\\b/i);
                currentSurface = surfMatch ? surfMatch[1].toLowerCase() : "";

            } else if (cls.includes("event__match")) {
                const timeEl = el.querySelector('[class*="event__time"]');
                const home = el.querySelector('[class*="event__participant--home"]')?.textContent?.trim();
                const away = el.querySelector('[class*="event__participant--away"]')?.textContent?.trim();
                const id = el.id?.replace(/^g_\\d+_/, "");
                const isScheduled = cls.includes("scheduled");
                const isLive = cls.includes("live");

                if (home) {
                    results.push({
                        id,
                        time: isScheduled ? (timeEl?.textContent?.trim() || null) : null,
                        status: isLive ? "live" : isScheduled ? "scheduled" : "finished",
                        home,
                        away,
                        tournament: currentTournament,
                        category: currentCategory,
                        surface: currentSurface
                    });
                }
            }
        }
    }
    return results;
}"""


def scrape_date(page, date_str, today_str):
    """Scrape a single date's Flashscore tennis page."""
    url = "https://www.flashscore.com/tennis/"
    if date_str != today_str:
        d = date_str.replace("-", "")
        url = f"https://www.flashscore.com/tennis/?d={d}"

    try:
        page.goto(url, wait_until="networkidle", timeout=30000)
        page.wait_for_selector('[class*="event__match"]', timeout=15000)

        # Scroll to trigger lazy loading
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(1500)

        data = page.evaluate(EXTRACT_JS)
        return data
    except Exception as e:
        return {"error": str(e)}


def merge_matches(all_matches):
    """Merge matches from multiple days, deduplicating by ID.
    Scheduled matches take priority over finished ones."""
    by_id = {}
    for match in all_matches:
        mid = match.get("id")
        if not mid:
            continue
        existing = by_id.get(mid)
        if not existing:
            by_id[mid] = match
        else:
            # Prefer scheduled > live > finished
            priority = {"scheduled": 3, "live": 2, "finished": 1}
            old_pri = priority.get(existing["status"], 0)
            new_pri = priority.get(match["status"], 0)
            if new_pri > old_pri:
                by_id[mid] = match
            # If same status, prefer the one with a time
            elif new_pri == old_pri and match.get("time") and not existing.get("time"):
                by_id[mid] = match
    return list(by_id.values())


def main():
    parser = argparse.ArgumentParser(description="Scrape Flashscore tennis schedule (3-day window)")
    parser.add_argument("--date", default=local_date_string(),
                        help="Center date to scrape (YYYY-MM-DD). Also scrapes +/- 1 day.")
    args = parser.parse_args()

    center = datetime.strptime(args.date, "%Y-%m-%d")
    today_str = args.date
    dates = [
        (center - timedelta(days=1)).strftime("%Y-%m-%d"),
        today_str,
        (center + timedelta(days=1)).strftime("%Y-%m-%d"),
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1920, "height": 10000},
            timezone_id="America/Chicago",
            locale="en-US"
        )
        page = context.new_page()

        all_raw = []
        errors = []

        for date_str in dates:
            result = scrape_date(page, date_str, today_str)
            if isinstance(result, dict) and "error" in result:
                errors.append(f"{date_str}: {result['error']}")
            elif isinstance(result, list):
                for m in result:
                    m["foundOn"] = date_str
                all_raw.extend(result)

        browser.close()

    # Merge and deduplicate
    merged = merge_matches(all_raw)
    scheduled = [m for m in merged if m["status"] == "scheduled"]

    output = {
        "date": args.date,
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "source": "flashscore",
        "timezone": "America/Chicago",
        "scrapedDates": dates,
        "totalMatches": len(merged),
        "scheduled": len(scheduled),
        "matches": merged
    }

    if errors:
        output["warnings"] = errors

    print(json.dumps(output))

    if not merged:
        sys.exit(1)


if __name__ == "__main__":
    main()
