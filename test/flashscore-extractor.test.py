import json
import sys
import unittest

from playwright.sync_api import sync_playwright

sys.path.insert(0, "scripts")
from flashscore_tennis import EXTRACT_JS


class FlashscoreExtractorTest(unittest.TestCase):
    def test_extracts_matches_from_all_tennis_containers(self):
        html = """
        <div class="sportName tennis">
          <div class="headerLeague">ATP Montreal, hard ATP - SINGLES</div>
          <div id="g_2_atp1" class="event__match event__match--scheduled">
            <div class="event__time">10:00</div>
            <div class="event__participant event__participant--home">Damm M.</div>
            <div class="event__participant event__participant--away">Tsitsipas S.</div>
          </div>
        </div>
        <div class="sportName tennis">
          <div class="headerLeague">Grodzisk Mazowiecki, hard CHALLENGER MEN - SINGLES</div>
          <div id="g_2_ch1" class="event__match event__match--scheduled">
            <div class="event__time">11:00</div>
            <div class="event__participant event__participant--home">Kirkin E.</div>
            <div class="event__participant event__participant--away">Ivashka I.</div>
          </div>
        </div>
        """

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            matches = page.evaluate(EXTRACT_JS)
            browser.close()

        self.assertEqual(
            {match["id"] for match in matches},
            {"atp1", "ch1"},
        )
        self.assertEqual(
            {(match["home"], match["away"]) for match in matches},
            {("Damm M.", "Tsitsipas S."), ("Kirkin E.", "Ivashka I.")},
        )


if __name__ == "__main__":
    unittest.main()
