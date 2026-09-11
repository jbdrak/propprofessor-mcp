'use strict';

// Conservative SharpOdds event/market identity matching (Task 4).
//
// Pure functions, no network. Decides whether a SharpOdds event/market/side
// may be attached to a PP screen/exact row before history is accepted.
// Fail-closed: anything ambiguous or mismatched returns matched: false with
// diagnostic reasons.
//
// Event identity:
// - Prefer a stable SharpOdds event ID when the caller pins one. An ID
//   mismatch fails closed even when team names agree; an ID match decides
//   event identity (team/time/league recorded as diagnostics only).
// - Without a pinned ID, require BOTH home and away participants (normalized,
//   alias-aware, exact equality only — never substring), normalized
//   league/sport agreement when both sides specify one, and a bounded
//   start-time agreement. Missing start time on either side fails closed.
// - Reversed display order is accepted but reported as order 'swapped' with a
//   weaker matchStrength; feed home/away semantics are preserved by mapping
//   requested home/away sides across the swap.
// Market identity:
// - Market type (moneyline/spread/total), segment (full-game vs period), side
//   (swap-aware; away/home alias to over/under for totals), and requested line
//   where the provider payload identifies one. Unknown segments fail closed.

const DEFAULT_TIME_TOLERANCE_MS = 90 * 60 * 1000;
const LINE_EPSILON = 1e-9;

const MARKET_ALIASES = {
  spread: 'spread',
  spreads: 'spread',
  total: 'total',
  totals: 'total',
  moneyline: 'moneyline',
  moneylines: 'moneyline',
  ml: 'moneyline'
};

const SEGMENT_ALIASES = {
  game: 'full-game',
  fullgame: 'full-game',
  fulltime: 'full-game',
  fg: 'full-game',
  regulation: 'full-game',
  match: 'full-game',
  main: 'full-game',
  '1h': '1st-half',
  '1sthalf': '1st-half',
  firsthalf: '1st-half',
  fh: '1st-half',
  '2h': '2nd-half',
  '2ndhalf': '2nd-half',
  secondhalf: '2nd-half',
  sh: '2nd-half',
  '1q': '1st-quarter',
  '1stquarter': '1st-quarter',
  firstquarter: '1st-quarter',
  '2q': '2nd-quarter',
  '2ndquarter': '2nd-quarter',
  secondquarter: '2nd-quarter',
  '3q': '3rd-quarter',
  '3rdquarter': '3rd-quarter',
  thirdquarter: '3rd-quarter',
  '4q': '4th-quarter',
  '4thquarter': '4th-quarter',
  fourthquarter: '4th-quarter',
  '1p': '1st-period',
  '1stperiod': '1st-period',
  firstperiod: '1st-period',
  '2p': '2nd-period',
  '2ndperiod': '2nd-period',
  secondperiod: '2nd-period',
  '3p': '3rd-period',
  '3rdperiod': '3rd-period',
  thirdperiod: '3rd-period'
};

const SIDE_ALIASES = {
  home: 'home',
  h: 'home',
  away: 'away',
  a: 'away',
  over: 'over',
  o: 'over',
  under: 'under',
  u: 'under'
};

const LEAGUE_ALIASES = {
  mlb: 'mlb',
  majorleaguebaseball: 'mlb',
  nfl: 'nfl',
  nationalfootballleague: 'nfl',
  nba: 'nba',
  nationalbasketballassociation: 'nba',
  nhl: 'nhl',
  nationalhockeyleague: 'nhl',
  wnba: 'wnba',
  mls: 'mls',
  majorleaguesoccer: 'mls',
  ncaab: 'ncaab',
  menscollegebasketball: 'ncaab',
  collegebasketball: 'ncaab',
  ncaaf: 'ncaaf',
  collegefootball: 'ncaaf',
  epl: 'epl',
  englishpremierleague: 'epl',
  premierleague: 'epl',
  laliga: 'laliga',
  seriea: 'seriea',
  bundesliga: 'bundesliga',
  ligue1: 'ligue1',
  championsleague: 'ucl',
  uefachampionsleague: 'ucl',
  atp: 'atp',
  wta: 'wta',
  ufc: 'ufc',
  mma: 'mma'
};

const TEAM_ALIASES = {
  'miami fl': 'miami florida',
  'la dodgers': 'los angeles dodgers',
  'la lakers': 'los angeles lakers',
  'la clippers': 'los angeles clippers',
  'la rams': 'los angeles rams',
  'la chargers': 'los angeles chargers',
  'la galaxy': 'los angeles galaxy',
  lafc: 'los angeles fc',
  'ny yankees': 'new york yankees',
  'ny mets': 'new york mets',
  'ny knicks': 'new york knicks',
  'ny nets': 'new york nets',
  'ny giants': 'new york giants',
  'ny jets': 'new york jets',
  'ny rangers': 'new york rangers',
  'ny islanders': 'new york islanders',
  nycfc: 'new york city fc',
  'sf giants': 'san francisco giants',
  'sf 49ers': 'san francisco 49ers',
  'tb lightning': 'tampa bay lightning',
  'tb rays': 'tampa bay rays',
  'tb buccaneers': 'tampa bay buccaneers',
  'stl cardinals': 'st louis cardinals',
  'stl blues': 'st louis blues',
  'chi cubs': 'chicago cubs',
  'chi whitesox': 'chicago white sox',
  'chi bulls': 'chicago bulls',
  'chi bears': 'chicago bears',
  'chi blackhawks': 'chicago blackhawks',
  'bos redsox': 'boston red sox',
  'bos celtics': 'boston celtics',
  'bos bruins': 'boston bruins'
};

function compact(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeTeamName(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return TEAM_ALIASES[cleaned] || cleaned;
}

function normalizeLeague(value) {
  if (value === null || value === undefined) return null;
  const key = compact(value);
  if (!key) return null;
  return LEAGUE_ALIASES[key] || key;
}

function normalizeMarketType(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase();
  if (!key) return null;
  return MARKET_ALIASES[key] || null;
}

function normalizeSegment(value) {
  if (value === null || value === undefined) return null;
  const key = compact(value);
  if (!key) return null;
  return SEGMENT_ALIASES[key] || null;
}

function normalizeSide(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase();
  if (!key) return null;
  return SIDE_ALIASES[key] || null;
}

function readFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function readRequestId(request) {
  return readFirst(request, ['sharpOddsEventId', 'sharpOddsId', 'eventId', 'gameId']);
}

function readCandidateId(candidate) {
  const event = candidate && typeof candidate.event === 'object' ? candidate.event : null;
  return (
    readFirst(candidate, ['eventId', 'gameId', 'id']) ??
    readFirst(event, ['id', 'eventId', 'gameId']) ??
    readFirst(candidate && candidate.meta, ['gameId', 'id'])
  );
}

function readTeams(source) {
  const event = source && typeof source.event === 'object' ? source.event : null;
  const meta = source && typeof source.meta === 'object' ? source.meta : null;
  const home =
    readFirst(source, ['homeTeam', 'home_team', 'home']) ??
    readFirst(event, ['homeTeam', 'home_team', 'home']) ??
    readFirst(meta, ['home_team', 'homeTeam', 'home', 'hn']);
  const away =
    readFirst(source, ['awayTeam', 'away_team', 'away']) ??
    readFirst(event, ['awayTeam', 'away_team', 'away']) ??
    readFirst(meta, ['away_team', 'awayTeam', 'away', 'an']);
  return { home, away };
}

function readLeague(source) {
  const event = source && typeof source.event === 'object' ? source.event : null;
  return readFirst(source, ['league', 'sport', 'leagueName']) ?? readFirst(event, ['league', 'sport', 'leagueName']);
}

function readStartTime(source) {
  const event = source && typeof source.event === 'object' ? source.event : null;
  return (
    readFirst(source, ['startTime', 'start_time', 'startTimeMs', 'commenceTime', 'gameTime']) ??
    readFirst(event, ['startTime', 'start_time', 'startTimeMs', 'commenceTime', 'gameTime'])
  );
}

function readMarket(source) {
  if (!source || typeof source !== 'object') return {};
  const market = source.market && typeof source.market === 'object' ? source.market : {};
  return {
    type: market.type ?? source.marketType ?? source.market_type,
    segment: market.segment ?? source.segment ?? source.period,
    side: market.side ?? source.side ?? source.requestedSide,
    line: market.line ?? source.line ?? source.requestedLine
  };
}

function parseTimeMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Second-precision epoch values are 10 digits; millis are 13.
    if (value < 1e12 && value >= 1e9) return Math.floor(value * 1000);
    return Math.floor(value);
  }
  const ms = Date.parse(String(value).trim());
  return Number.isFinite(ms) ? ms : null;
}

function parseLine(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function flipHomeAway(side) {
  if (side === 'home') return 'away';
  if (side === 'away') return 'home';
  return side;
}

function totalsAlias(side) {
  if (side === 'away') return 'over';
  if (side === 'home') return 'under';
  return side;
}

/**
 * Match a PP screen/exact row to a SharpOdds event/market/side.
 * @param {object} request PP row: teams, league/sport, startTime, market {type, segment, side, line}, optional sharpOddsEventId.
 * @param {object} candidate SharpOdds event/market/side (event nesting or flat; meta team aliases accepted).
 * @param {{ timeToleranceMs?: number }} [options]
 * @returns {{ matched: boolean, matchStrength: string|null, reasons: string[], order: string|null, timeDeltaMs: number|null, eventId: string|null }}
 */
function matchSharpOddsEvent(request = {}, candidate = {}, options = {}) {
  const reasons = [];
  const toleranceMs =
    Number.isFinite(Number(options.timeToleranceMs)) && Number(options.timeToleranceMs) > 0
      ? Number(options.timeToleranceMs)
      : DEFAULT_TIME_TOLERANCE_MS;

  const candidateIdRaw = readCandidateId(candidate);
  const candidateId = candidateIdRaw === undefined ? null : String(candidateIdRaw).trim();
  const requestIdRaw = readRequestId(request);
  const requestId = requestIdRaw === undefined ? null : String(requestIdRaw).trim();

  let order = null;
  let timeDeltaMs = null;
  let idPath = false;

  if (requestId !== null && candidateId !== null) {
    if (requestId !== candidateId) {
      reasons.push('id_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    idPath = true;
    reasons.push('id_match');
  }

  const reqTeams = readTeams(request);
  const candTeams = readTeams(candidate);
  const reqHome = normalizeTeamName(reqTeams.home);
  const reqAway = normalizeTeamName(reqTeams.away);
  const candHome = normalizeTeamName(candTeams.home);
  const candAway = normalizeTeamName(candTeams.away);

  if (!idPath) {
    if (!reqHome || !reqAway) {
      reasons.push('request_teams_missing');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    if (!candHome || !candAway) {
      reasons.push('team_missing');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    if (reqHome === candHome && reqAway === candAway) {
      order = 'aligned';
      reasons.push('teams_match');
    } else if (reqHome === candAway && reqAway === candHome) {
      order = 'swapped';
      reasons.push('teams_match', 'order_swapped');
    } else {
      reasons.push('team_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }

    const reqLeague = normalizeLeague(readLeague(request));
    const candLeague = normalizeLeague(readLeague(candidate));
    if (reqLeague !== null && candLeague !== null) {
      if (reqLeague !== candLeague) {
        reasons.push('league_mismatch');
        return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
      }
      reasons.push('league_match');
    } else {
      reasons.push('league_unconstrained');
    }

    const reqTime = parseTimeMs(readStartTime(request));
    const candTime = parseTimeMs(readStartTime(candidate));
    if (reqTime === null || candTime === null) {
      reasons.push('start_time_missing');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    timeDeltaMs = Math.abs(reqTime - candTime);
    if (timeDeltaMs > toleranceMs) {
      reasons.push('time_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    reasons.push('time_agree');
  } else {
    // ID path: record team/time/league agreement as diagnostics without gating.
    if (reqHome && reqAway && candHome && candAway) {
      if (reqHome === candHome && reqAway === candAway) {
        order = 'aligned';
        reasons.push('teams_match');
      } else if (reqHome === candAway && reqAway === candHome) {
        order = 'swapped';
        reasons.push('teams_match', 'order_swapped');
      } else {
        reasons.push('team_mismatch');
      }
    }
    const reqTime = parseTimeMs(readStartTime(request));
    const candTime = parseTimeMs(readStartTime(candidate));
    if (reqTime !== null && candTime !== null) {
      timeDeltaMs = Math.abs(reqTime - candTime);
      reasons.push(timeDeltaMs <= toleranceMs ? 'time_agree' : 'time_mismatch');
    }
  }

  // Market identity: each requested dimension must be satisfied by the candidate.
  const reqMarket = readMarket(request);
  const candMarket = readMarket(candidate);
  const hasMarketRequest =
    reqMarket.type !== undefined ||
    reqMarket.segment !== undefined ||
    reqMarket.side !== undefined ||
    reqMarket.line !== undefined;
  if (!hasMarketRequest) {
    reasons.push('market_unconstrained');
    return {
      matched: true,
      matchStrength: idPath ? 'exact-id' : order === 'swapped' ? 'swapped' : 'standard',
      reasons,
      order,
      timeDeltaMs,
      eventId: candidateId
    };
  }

  if (reqMarket.type !== undefined) {
    const reqType = normalizeMarketType(reqMarket.type);
    const candType = normalizeMarketType(candMarket.type);
    if (reqType === null) {
      reasons.push('market_unknown');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    if (candType === null) {
      reasons.push('market_unknown');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    if (reqType !== candType) {
      reasons.push('market_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    reasons.push('market_match');
  }

  if (reqMarket.segment !== undefined) {
    const reqSegment = normalizeSegment(reqMarket.segment);
    if (reqSegment === null) {
      reasons.push('segment_unknown');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    const candSegment = normalizeSegment(candMarket.segment);
    if (candSegment === null) {
      reasons.push('segment_unknown');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    if (reqSegment !== candSegment) {
      reasons.push('segment_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    reasons.push('segment_match');
  }

  if (reqMarket.side !== undefined) {
    const reqSide = normalizeSide(reqMarket.side);
    let candSide = normalizeSide(candMarket.side);
    if (reqSide === null || candSide === null) {
      reasons.push('side_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    // Preserve feed home/away semantics across reversed display order.
    if (order === 'swapped') candSide = flipHomeAway(candSide);
    // Totals encode sides as home/away in some provider payloads.
    const effectiveReq = totalsAlias(reqSide);
    const effectiveCand = totalsAlias(candSide);
    if (effectiveReq !== effectiveCand) {
      reasons.push('side_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    reasons.push('side_match');
  }

  const reqLine = parseLine(reqMarket.line);
  const candLine = parseLine(candMarket.line);
  if (reqLine !== null && candLine !== null) {
    if (Math.abs(reqLine - candLine) > LINE_EPSILON) {
      reasons.push('line_mismatch');
      return { matched: false, matchStrength: null, reasons, order, timeDeltaMs, eventId: candidateId };
    }
    reasons.push('line_match');
  } else {
    reasons.push('line_unconstrained');
  }

  let matchStrength;
  if (idPath) matchStrength = 'exact-id';
  else if (order === 'swapped') matchStrength = 'swapped';
  else if (reasons.includes('league_match')) matchStrength = 'strong';
  else matchStrength = 'standard';

  return { matched: true, matchStrength, reasons, order, timeDeltaMs, eventId: candidateId };
}

module.exports = {
  DEFAULT_TIME_TOLERANCE_MS,
  normalizeTeamName,
  normalizeLeague,
  normalizeMarketType,
  normalizeSegment,
  normalizeSide,
  matchSharpOddsEvent
};
