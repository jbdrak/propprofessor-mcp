'use strict';

const fs = require('fs');
const path = require('path');

const WEEKLY_SCHEDULE_2026 = {
  // Week of June 15, 2026 — grass swing begins
  '2026-06-15': {
    start: '2026-06-15',
    end: '2026-06-21',
    atp: [
      { name: "Queen's Club Championships", surface: 'Grass', level: 'ATP 500', city: 'London', slug: 'queens' },
      { name: 'Halle Open', surface: 'Grass', level: 'ATP 500', city: 'Halle', slug: 'halle' }
    ],
    wta: [
      {
        name: 'Vanda Pharmaceuticals Berlin Tennis Open',
        surface: 'Grass',
        level: 'WTA 500',
        city: 'Berlin',
        slug: 'berlin'
      },
      { name: 'Lexus Nottingham Open', surface: 'Grass', level: 'WTA 250', city: 'Nottingham', slug: 'nottingham' }
    ],
    challenger: [
      { name: 'Surbiton Trophy', surface: 'Grass', level: 'Challenger', city: 'Surbiton', slug: 'surbiton' },
      {
        name: 'Nottingham Open Challenger',
        surface: 'Grass',
        level: 'Challenger',
        city: 'Nottingham',
        slug: 'nottingham-c'
      }
    ]
  },

  // Week of June 22, 2026 — main grass swing
  '2026-06-22': {
    start: '2026-06-22',
    end: '2026-06-28',
    atp: [
      { name: 'Halle Open', surface: 'Grass', level: 'ATP 500', city: 'Halle', slug: 'halle' },
      { name: 'Mallorca Championships', surface: 'Grass', level: 'ATP 250', city: 'Mallorca', slug: 'mallorca' },
      { name: 'Lexus Eastbourne Open', surface: 'Grass', level: 'ATP 250', city: 'Eastbourne', slug: 'eastbourne' }
    ],
    wta: [
      { name: 'Bad Homburg Open', surface: 'Grass', level: 'WTA 500', city: 'Bad Homburg', slug: 'bad-homburg' },
      { name: 'Lexus Eastbourne Open', surface: 'Grass', level: 'WTA 250', city: 'Eastbourne', slug: 'eastbourne' }
    ],
    challenger: [
      { name: 'Ilkley Trophy', surface: 'Grass', level: 'Challenger', city: 'Ilkley', slug: 'ilkley' },
      {
        name: 'Nottingham Challenger',
        surface: 'Grass',
        level: 'Challenger',
        city: 'Nottingham',
        slug: 'nottingham-c'
      },
      { name: 'Wimbledon Qualifying', surface: 'Grass', level: 'Qualifying', city: 'London', slug: 'wimbledon-q' }
    ]
  },

  // Week of June 29, 2026 — Wimbledon main draw + lead-ins
  '2026-06-29': {
    start: '2026-06-29',
    end: '2026-07-05',
    atp: [
      { name: 'The Championships, Wimbledon', surface: 'Grass', level: 'Grand Slam', city: 'London', slug: 'wimbledon' }
    ],
    wta: [
      { name: 'The Championships, Wimbledon', surface: 'Grass', level: 'Grand Slam', city: 'London', slug: 'wimbledon' }
    ],
    challenger: []
  },

  // Week of July 6, 2026 — Wimbledon second week
  '2026-07-06': {
    start: '2026-07-06',
    end: '2026-07-12',
    atp: [
      {
        name: 'The Championships, Wimbledon',
        surface: 'Grass',
        level: 'Grand Slam',
        city: 'London',
        slug: 'wimbledon'
      },
      { name: 'Hall of Fame Open', surface: 'Grass', level: 'ATP 250', city: 'Newport', slug: 'newport' },
      { name: 'Swedish Open', surface: 'Clay', level: 'ATP 250', city: 'Bastad', slug: 'bastad' }
    ],
    wta: [
      { name: 'The Championships, Wimbledon', surface: 'Grass', level: 'Grand Slam', city: 'London', slug: 'wimbledon' }
    ],
    challenger: []
  },

  // Week of July 13, 2026 — clay swing + first hardcourt prep
  '2026-07-13': {
    start: '2026-07-13',
    end: '2026-07-19',
    atp: [
      { name: 'Hamburg Open', surface: 'Clay', level: 'ATP 500', city: 'Hamburg', slug: 'hamburg' },
      { name: 'Swiss Open Gstaad', surface: 'Clay', level: 'ATP 250', city: 'Gstaad', slug: 'gstaad' },
      { name: 'Croatia Open Umag', surface: 'Clay', level: 'ATP 250', city: 'Umag', slug: 'umag' },
      { name: 'Hall of Fame Open', surface: 'Grass', level: 'ATP 250', city: 'Newport', slug: 'newport' }
    ],
    wta: [
      { name: 'UniCredit Iasi Open', surface: 'Clay', level: 'WTA 250', city: 'Iasi', slug: 'iasi' },
      { name: 'Hungarian Grand Prix', surface: 'Clay', level: 'WTA 250', city: 'Budapest', slug: 'budapest' }
    ],
    challenger: []
  },

  // Week of July 20, 2026 — last grass / hardcourt prep
  '2026-07-20': {
    start: '2026-07-20',
    end: '2026-07-26',
    atp: [
      { name: 'Generali Open', surface: 'Clay', level: 'ATP 250', city: 'Kitzbuhel', slug: 'kitzbuhel' },
      {
        name: 'Winston-Salem Open',
        surface: 'Hardcourt',
        level: 'ATP 250',
        city: 'Winston-Salem',
        slug: 'winston-salem'
      }
    ],
    wta: [
      { name: 'Vanda Pharmaceuticals Athens Open', surface: 'Clay', level: 'WTA 250', city: 'Athens', slug: 'athens' },
      { name: 'Prague Open', surface: 'Clay', level: 'WTA 250', city: 'Prague', slug: 'prague' }
    ],
    challenger: []
  },

  // Week of July 27, 2026 — hardcourt prep for the North American swing
  '2026-07-27': {
    start: '2026-07-27',
    end: '2026-08-02',
    atp: [
      { name: 'Citi Open Washington', surface: 'Hardcourt', level: 'ATP 500', city: 'Washington', slug: 'washington' },
      { name: 'Los Cabos Open', surface: 'Hardcourt', level: 'ATP 250', city: 'Los Cabos', slug: 'los-cabos' },
      { name: 'Kitzbuhel', surface: 'Clay', level: 'ATP 250', city: 'Kitzbuhel', slug: 'kitzbuhel' }
    ],
    wta: [
      { name: 'Washington Citi Open', surface: 'Hardcourt', level: 'WTA 500', city: 'Washington', slug: 'washington' },
      {
        name: 'Mubadala Silicon Valley Classic',
        surface: 'Hardcourt',
        level: 'WTA 250',
        city: 'San Jose',
        slug: 'san-jose'
      }
    ],
    challenger: []
  },

  // Week of August 3, 2026 — Masters 1000 begins
  '2026-08-03': {
    start: '2026-08-03',
    end: '2026-08-09',
    atp: [
      { name: 'National Bank Open', surface: 'Hardcourt', level: 'Masters', city: 'Toronto', slug: 'toronto' },
      { name: 'Generali Open', surface: 'Clay', level: 'ATP 250', city: 'Kitzbuhel', slug: 'kitzbuhel' }
    ],
    wta: [{ name: 'National Bank Open', surface: 'Hardcourt', level: 'WTA 1000', city: 'Montreal', slug: 'montreal' }],
    challenger: []
  },

  // Week of August 10, 2026 — Masters 1000 second week + Cincinnati
  '2026-08-10': {
    start: '2026-08-10',
    end: '2026-08-16',
    atp: [{ name: 'Cincinnati Open', surface: 'Hardcourt', level: 'Masters', city: 'Cincinnati', slug: 'cincinnati' }],
    wta: [{ name: 'Cincinnati Open', surface: 'Hardcourt', level: 'WTA 1000', city: 'Cincinnati', slug: 'cincinnati' }],
    challenger: []
  },

  // Week of August 24, 2026 — US Open window (2026 US Open runs Aug 23–Sep 13
  // per the official tournament calendar; main-draw singles from Aug 30)
  '2026-08-24': {
    start: '2026-08-24',
    end: '2026-08-30',
    atp: [{ name: 'US Open', surface: 'Hardcourt', level: 'Grand Slam', city: 'New York', slug: 'us-open' }],
    wta: [{ name: 'US Open', surface: 'Hardcourt', level: 'Grand Slam', city: 'New York', slug: 'us-open' }],
    challenger: []
  },

  // Week of August 31, 2026 — US Open main draw
  '2026-08-31': {
    start: '2026-08-31',
    end: '2026-09-06',
    atp: [{ name: 'US Open', surface: 'Hardcourt', level: 'Grand Slam', city: 'New York', slug: 'us-open' }],
    wta: [{ name: 'US Open', surface: 'Hardcourt', level: 'Grand Slam', city: 'New York', slug: 'us-open' }],
    challenger: []
  },

  // Week of September 7, 2026 — US Open finals week + WTA 125 events
  // (ATIK Antalya Open: clay; Kia Open Barranquilla: hard, Sep 7–13 2026
  // per the official WTA tournament pages)
  '2026-09-07': {
    start: '2026-09-07',
    end: '2026-09-13',
    atp: [{ name: 'US Open', surface: 'Hardcourt', level: 'Grand Slam', city: 'New York', slug: 'us-open' }],
    wta: [
      { name: 'US Open', surface: 'Hardcourt', level: 'Grand Slam', city: 'New York', slug: 'us-open' },
      { name: 'ATIK Antalya Open', surface: 'Clay', level: 'WTA 125', city: 'Antalya', slug: 'antalya' },
      { name: 'Kia Open', surface: 'Hardcourt', level: 'WTA 125', city: 'Barranquilla', slug: 'barranquilla' }
    ],
    challenger: []
  }
};

// ---------------------------------------------------------------------------
// Player-circuit hints — used when a player is top-100 and the week has
// multiple plausible events. Maps the player's known circuit to a slug.
// Limited to a small set of well-known top-100 players per tour who play
// regular tour-level events. Lower-ranked players fall through to the
// generic "Challenger" / "ITF Futures" path.
// ---------------------------------------------------------------------------

// Player circuit map. Each entry maps a player's last name (as it appears
// in pp-mcp data) to the slugs of tourneys they're most likely to be
// entered in, in preference order. The matchup resolver picks the first
// preferred slug that's active in the given week.
//
// Coverage: top-100 ATP + top-100 WTA. The list is curated for the 2026
// grass swing (Halle / Mallorca / Bad Homburg / Eastbourne / Queen's /
// Berlin / Nottingham) but slugs for clay/hardcourt events are included
// in fallback position so clay-swing matchups route correctly too.
//
// Slug inventory is defined by the WEEKLY_SCHEDULE_2026 entries; any slug
// referenced here MUST exist in some week's `atp` or `wta` array, or the
// resolver will silently skip it. To extend coverage, add the player + a
// slug list; the regression test in test/ssb-tennis-context.test.js
// ("PLAYER_CIRCUIT coverage") catches misroutes.
const PLAYER_CIRCUIT = {
  // ─── WTA — grass swing core (Bad Homburg / Berlin / Eastbourne) ──────
  // British / British-conn. players tend toward Eastbourne
  Dart: { tour: 'wta', preferredSlugs: ['eastbourne', 'berlin', 'nottingham', 'wimbledon'] },
  Boulter: { tour: 'wta', preferredSlugs: ['eastbourne', 'nottingham', 'wimbledon'] },
  Watson: { tour: 'wta', preferredSlugs: ['eastbourne', 'nottingham', 'wimbledon'] },
  Burrage: { tour: 'wta', preferredSlugs: ['eastbourne', 'nottingham', 'wimbledon'] },
  Raducanu: { tour: 'wta', preferredSlugs: ['eastbourne', 'wimbledon'] },

  // Top-10 WTA — usually Bad Homburg or Berlin (the higher-tier grass events)
  Sabalenka: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'wimbledon'] },
  Swiatek: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'wimbledon'] },
  Rybakina: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Gauff: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Pegula: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Jabeur: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Sakkari: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },

  // Top-20 WTA — rest of grass-swing regulars
  Kasatkina: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Keys: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Bencic: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Svitolina: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Samsonova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Ostapenko: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Muchova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Pliskova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  'Haddad Maia': { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Kvitova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Vondrousova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Azarenka: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Andreescu: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Anisimova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Collins: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Stephens: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Kenin: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Andreeva: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Fernandez: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },

  // Top-50 WTA
  Kostyuk: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Kalinina: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Potapova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Kalinskaya: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Cirstea: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Kudermetova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Linette: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Mertens: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Alexandrova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Pavlyuchenkova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Siniakova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Krejcikova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Bouzkova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Bronzetti: { tour: 'wta', preferredSlugs: ['antalya', 'bad-homburg', 'eastbourne', 'wimbledon'] },
  Inglis: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Bondar: { tour: 'wta', preferredSlugs: ['eastbourne', 'nottingham', 'wimbledon'] },
  Udvardy: { tour: 'wta', preferredSlugs: ['eastbourne', 'nottingham', 'wimbledon'] },
  Zhu: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Barthel: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Dolehide: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Montgomery: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Rus: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Podrez: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Monnet: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Prozorova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Friedsam: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Ngounoue: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Rame: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Werner: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Tauson: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Sonmez: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Eala: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Hibino: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Hon: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Gasanova: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Lepchenko: { tour: 'wta', preferredSlugs: ['barranquilla', 'bad-homburg', 'eastbourne', 'wimbledon'] },
  Scott: { tour: 'wta', preferredSlugs: ['barranquilla'] },
  Siegemund: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Lys: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Frech: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Putintseva: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Wang: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Yuan: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Zhang: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },
  Zheng: { tour: 'wta', preferredSlugs: ['bad-homburg', 'berlin', 'eastbourne', 'wimbledon'] },
  Osaka: { tour: 'wta', preferredSlugs: ['bad-homburg', 'eastbourne', 'wimbledon'] },

  // ─── ATP — grass swing core (Halle / Mallorca / Queen's) ─────────────
  Djokovic: { tour: 'atp', preferredSlugs: ['wimbledon', 'queens', 'halle'] },
  Alcaraz: { tour: 'atp', preferredSlugs: ['queens', 'halle', 'wimbledon'] },
  Sinner: { tour: 'atp', preferredSlugs: ['halle', 'wimbledon'] },
  Zverev: { tour: 'atp', preferredSlugs: ['halle', 'wimbledon'] },
  Medvedev: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Rublev: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Tsitsipas: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Hurkacz: { tour: 'atp', preferredSlugs: ['halle', 'wimbledon'] },
  Rune: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Ruud: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Fritz: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  'De Minaur': { tour: 'atp', preferredSlugs: ['queens', 'halle', 'mallorca', 'wimbledon'] },
  Cobolli: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Minaur: { tour: 'atp', preferredSlugs: ['queens', 'halle', 'mallorca', 'wimbledon'] },
  'Auger-Aliassime': { tour: 'atp', preferredSlugs: ['halle', 'wimbledon'] },
  Dimitrov: { tour: 'atp', preferredSlugs: ['halle', 'wimbledon'] },
  Paul: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Khachanov: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Tiafoe: { tour: 'atp', preferredSlugs: ['queens', 'halle', 'wimbledon'] },
  Musetti: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Shelton: { tour: 'atp', preferredSlugs: ['halle', 'queens', 'mallorca', 'wimbledon'] },
  Bublik: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Draper: { tour: 'atp', preferredSlugs: ['queens', 'halle', 'wimbledon'] },
  Fonseca: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Popyrin: { tour: 'atp', preferredSlugs: ['halle', 'queens', 'mallorca', 'wimbledon'] },
  Djere: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Machac: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Korda: { tour: 'atp', preferredSlugs: ['halle', 'wimbledon'] },
  Struff: { tour: 'atp', preferredSlugs: ['halle', 'wimbledon'] },
  Etcheverry: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Cerundolo: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Mannarino: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Griekspoor: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Sonego: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Arnaldi: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Safiullin: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Humbert: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Fils: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Moutet: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Baez: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  'Bautista Agut': { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  // Zhang Zhizhen is an ATP grass-swing player (NOT Qinwen Zheng, who is WTA).
  // The WTA "Zhang" entry (Qinwen Zheng) is defined above in the WTA block;
  // this key is disambiguated as "Zhang Zhizhen" so it survives rather than
  // silently shadowing the WTA entry.
  'Zhang Zhizhen': { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Kecmanovic: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Muller: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Cazaux: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Halys: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Gaston: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Rinderknech: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Bonzi: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  'Mpetshi Perricard': { tour: 'atp', preferredSlugs: ['halle', 'queens', 'wimbledon'] },
  Goffin: { tour: 'atp', preferredSlugs: ['halle', 'queens', 'wimbledon'] },
  'Bautista-Agut': { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Munar: { tour: 'atp', preferredSlugs: ['mallorca', 'wimbledon'] },
  'Davidovich Fokina': { tour: 'atp', preferredSlugs: ['mallorca', 'wimbledon'] },
  'Carballes Baena': { tour: 'atp', preferredSlugs: ['mallorca', 'halle', 'wimbledon'] },
  Lopez: { tour: 'atp', preferredSlugs: ['mallorca', 'wimbledon'] },
  Verdasco: { tour: 'atp', preferredSlugs: ['mallorca', 'wimbledon'] },
  Skatov: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Ymer: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Echargui: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Smith: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Gojo: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Dougaz: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Sakamoto: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Ishii: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Quevedo: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Bu: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Tabur: { tour: 'atp', preferredSlugs: ['wimbledon-q', 'halle', 'eastbourne', 'wimbledon'] },
  Buse: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Coppejans: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Jubb: { tour: 'atp', preferredSlugs: ['queens', 'eastbourne', 'wimbledon'] },
  Vera: { tour: 'atp', preferredSlugs: ['queens', 'eastbourne', 'wimbledon'] },
  Ruiz: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Tiffon: { tour: 'atp', preferredSlugs: ['halle', 'eastbourne', 'wimbledon'] },
  Darderi: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Hanfmann: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Altmaier: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Kovacevic: { tour: 'atp', preferredSlugs: ['halle', 'mallorca', 'wimbledon'] },
  Bergs: { tour: 'atp', preferredSlugs: ['eastbourne', 'halle', 'wimbledon'] },
  Bertola: { tour: 'atp', preferredSlugs: ['wimbledon-q', 'eastbourne', 'wimbledon'] },
  Basing: { tour: 'atp', preferredSlugs: ['wimbledon-q', 'eastbourne', 'wimbledon'] },
  Choinski: { tour: 'atp', preferredSlugs: ['eastbourne', 'wimbledon'] },
  Marozsan: { tour: 'atp', preferredSlugs: ['mallorca', 'halle', 'wimbledon'] },
  Mochizuki: { tour: 'atp', preferredSlugs: ['wimbledon-q', 'eastbourne', 'wimbledon'] }
};

/**
 * Return the week entry for a given date (YYYY-MM-DD string or Date).
 * Returns null if the date falls outside the schedule data.
 * @param {string|Date} dateOrIso
 * @returns {object|null}
 */
function getWeekForDate(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(d.getTime())) return null;
  // ISO week start = Monday. Compute Monday of the week containing d.
  const day = d.getUTCDay() || 7; // Sunday = 7 in ISO
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  const iso = monday.toISOString().slice(0, 10);
  return WEEKLY_SCHEDULE_2026[iso] || null;
}

/**
 * Enumerate all tourneys (ATP + WTA + Challenger) active in the week
 * containing the given start timestamp.
 * @param {string|Date} startIso
 * @returns {Array<{name: string, surface: string, level: string, city: string, tour: string, slug: string}>}
 */
function listTourneysForWeek(startIso) {
  const week = getWeekForDate(startIso);
  if (!week) return [];
  const out = [];
  for (const t of week.atp || []) out.push({ ...t, tour: 'atp' });
  for (const t of week.wta || []) out.push({ ...t, tour: 'wta' });
  for (const t of week.challenger || []) out.push({ ...t, tour: 'challenger' });
  return out;
}

/**
 * Pick the best tourney for a matchup given the players and the week.
 * Strategy:
 *   1. If both players have PLAYER_CIRCUIT entries with overlapping preferredSlugs,
 *      return that tourney.
 *   2. If only one player has a circuit hint, use their top preferred slug
 *      that is in the week's active tourneys.
 *   3. Otherwise return null (caller falls back to the original "unknown" path).
 *
 * @param {string} player1
 * @param {string} player2
 * @param {string|Date} startIso
 * @returns {{name: string, surface: string, level: string, city: string, tour: string, slug: string}|null}
 */
function pickTourneyForMatchup(player1, player2, startIso) {
  const tourneys = listTourneysForWeek(startIso);
  if (tourneys.length === 0) return null;

  const c1 = player1 ? PLAYER_CIRCUIT[player1] : null;
  const c2 = player2 ? PLAYER_CIRCUIT[player2] : null;

  // Tour-alignment filter: when both players have a circuit hint, restrict
  // to slugs whose tour matches the players' tour. This prevents a matchup
  // like "Djere vs Zheng" (both ATP) from accidentally resolving to the
  // WTA version of Eastbourne when both ATP and WTA versions of the same
  // slug are active in the same week.
  let alignedTours = null;
  if (c1 && c2) {
    if (c1.tour === c2.tour) alignedTours = new Set([c1.tour]);
    // Mixed-tour hints fall through to no filter (we can't tell which is right)
  }

  const candidate = (slug) => {
    const hits = tourneys.filter((t) => t.slug === slug);
    if (hits.length === 0) return null;
    if (alignedTours) {
      const aligned = hits.find((t) => alignedTours.has(t.tour));
      if (aligned) return aligned;
    }
    return hits[0];
  };

  // Case 1: both have circuit hints with overlap
  if (c1 && c2) {
    const overlap = c1.preferredSlugs.filter((s) => c2.preferredSlugs.includes(s));
    for (const slug of overlap) {
      const hit = candidate(slug);
      if (hit) return hit;
    }
  }

  // Case 2: single circuit hint
  const hint = c1 || c2;
  if (hint) {
    for (const slug of hint.preferredSlugs) {
      const hit = candidate(slug);
      if (hit) return hit;
    }
  }

  // Case 3: no circuit hints at all. Fall back to week-level inference.
  // These are high-confidence: during a Grand Slam week every relevant
  // player is at that Slam (main draw or qualifying), and a single-event
  // week has only one possible tourney. Neither can misclassify a surface,
  // so they resolve the false `unknown` that the ESPN fallback otherwise
  // produces for WTA / challenger matchups with no venue data.
  const slam = tourneys.find((t) => t.level === 'Grand Slam');
  if (slam) return slam;

  if (tourneys.length === 1) return tourneys[0];

  // Genuinely ambiguous (multiple events per tour, no circuit hint): let the
  // caller fall through to its unknown path rather than guess wrong.
  return null;
}

// ---------------------------------------------------------------------------
// Auto-refresh: load circuit-cache.json (generated by scripts/refresh-tennis-circuit.js)
// at module-import time and merge with the static PLAYER_CIRCUIT. The cache
// is regenerated daily by the cron and overrides / augments the static map.
// Cached entries have last-write-wins on preferredSlugs (cache first, static
// fallback) — so a stale cache can't shrink coverage, it can only grow it.
// ---------------------------------------------------------------------------

const CIRCUIT_CACHE_PATH = path.join(__dirname, 'circuit-cache.json');
const CIRCUIT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadCircuitCache() {
  try {
    if (!fs.existsSync(CIRCUIT_CACHE_PATH)) return {};
    const raw = fs.readFileSync(CIRCUIT_CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.circuit) return {};
    const generatedAt = new Date(data.generatedAt).getTime();
    if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > CIRCUIT_CACHE_TTL_MS) {
      // Stale — fall through to static map. Don't fail; the static map is
      // a sensible fallback for up to a week past the cache expiry.
      return {};
    }
    return data.circuit;
  } catch {
    return {};
  }
}

const _cacheCircuit = loadCircuitCache();
const PLAYER_CIRCUIT_MERGED = { ...PLAYER_CIRCUIT, ..._cacheCircuit };

module.exports = {
  WEEKLY_SCHEDULE_2026,
  PLAYER_CIRCUIT: PLAYER_CIRCUIT_MERGED,
  PLAYER_CIRCUIT_STATIC: PLAYER_CIRCUIT,
  getWeekForDate,
  listTourneysForWeek,
  pickTourneyForMatchup,
  reloadCircuitCache() {
    // Re-read the cache file. Used by the cron job after refresh so the
    // running process picks up the new entries without a restart.
    const fresh = loadCircuitCache();
    Object.keys(PLAYER_CIRCUIT_MERGED).forEach((k) => {
      delete PLAYER_CIRCUIT_MERGED[k];
    });
    Object.assign(PLAYER_CIRCUIT_MERGED, PLAYER_CIRCUIT, fresh);
    return fresh;
  }
};
