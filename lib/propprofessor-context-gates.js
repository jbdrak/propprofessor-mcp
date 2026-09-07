'use strict';

const RULES = {
  tennis: {
    total: {
      requiredFields: ['gender', 'competitionScope', 'format'],
      checks: {
        gender: (value) => value === 'men',
        competitionScope: (value) => value === 'grand_slam',
        format: (value) => value === 'best_of_five'
      },
      reasonCodes: {
        gender: 'TENNIS_MENS_CONTEXT_MISSING',
        competitionScope: 'TENNIS_GRAND_SLAM_SCOPE_MISSING',
        format: 'TENNIS_FORMAT_UNCONFIRMED'
      }
    }
  },
  soccer: {
    all: {
      requiredFields: ['outcomeStructure', 'competitionScope'],
      checks: {
        outcomeStructure: (value) => value === 'three_way',
        competitionScope: (value) => hasValue(value)
      },
      reasonCodes: {
        outcomeStructure: 'SOCCER_THREE_WAY_STRUCTURE_MISSING',
        competitionScope: 'SOCCER_COMPETITION_SCOPE_MISSING'
      }
    }
  },
  mlb: {
    total: {
      requiredFields: ['startingPitchersConfirmed', 'lineupsConfirmed', 'weatherConfirmed'],
      checks: {
        startingPitchersConfirmed: (value) => value === true,
        lineupsConfirmed: (value) => value === true,
        weatherConfirmed: (value) => value === true
      },
      reasonCodes: {
        startingPitchersConfirmed: 'MLB_STARTING_PITCHERS_UNCONFIRMED',
        lineupsConfirmed: 'MLB_LINEUPS_UNCONFIRMED',
        weatherConfirmed: 'MLB_WEATHER_UNCONFIRMED'
      }
    }
  },
  nhl: {
    all: {
      requiredFields: ['goaliesConfirmed'],
      checks: { goaliesConfirmed: (value) => value === true },
      reasonCodes: { goaliesConfirmed: 'NHL_GOALIE_CONFIRMATION_MISSING' }
    }
  },
  nfl: {
    all: footballRule('NFL')
  },
  ncaaf: {
    all: footballRule('NCAAF')
  },
  nba: {
    all: basketballRule('NBA')
  },
  wnba: {
    all: basketballRule('WNBA')
  },
  ncaab: {
    all: basketballRule('NCAAB')
  },
  ufc: {
    all: {
      requiredFields: [
        'replacementStatusConfirmed',
        'weighInStatusConfirmed',
        'weightClassConfirmed',
        'boutFormatConfirmed'
      ],
      checks: {
        replacementStatusConfirmed: (value) => value === true,
        weighInStatusConfirmed: (value) => value === true,
        weightClassConfirmed: (value) => value === true,
        boutFormatConfirmed: (value) => value === true
      },
      reasonCodes: {
        replacementStatusConfirmed: 'UFC_REPLACEMENT_STATUS_MISSING',
        weighInStatusConfirmed: 'UFC_WEIGH_IN_STATUS_MISSING',
        weightClassConfirmed: 'UFC_WEIGHT_CLASS_MISSING',
        boutFormatConfirmed: 'UFC_BOUT_FORMAT_MISSING'
      }
    }
  }
};

const SOCCER_ALIASES = new Set([
  'soccer',
  'mls',
  'epl',
  'la liga',
  'bundesliga',
  'ligue 1',
  'liga mx',
  'champions league',
  'europa league',
  'efl championship'
]);

function footballRule(league) {
  return {
    requiredFields: ['kickoffTimingConfirmed', 'inactiveNewsTimingConfirmed', 'lineIdentityConfirmed'],
    checks: {
      kickoffTimingConfirmed: (value) => value === true,
      inactiveNewsTimingConfirmed: (value) => value === true,
      lineIdentityConfirmed: (value) => value === true
    },
    reasonCodes: {
      kickoffTimingConfirmed: `${league}_KICKOFF_TIMING_MISSING`,
      inactiveNewsTimingConfirmed: `${league}_INACTIVE_NEWS_TIMING_MISSING`,
      lineIdentityConfirmed: `${league}_LINE_IDENTITY_MISSING`
    }
  };
}

function basketballRule(league) {
  return {
    requiredFields: ['availabilityConfirmed', 'restConfirmed', 'paceContextConfirmed'],
    checks: {
      availabilityConfirmed: (value) => value === true,
      restConfirmed: (value) => value === true,
      paceContextConfirmed: (value) => value === true
    },
    reasonCodes: {
      availabilityConfirmed: `${league}_AVAILABILITY_MISSING`,
      restConfirmed: `${league}_REST_CONTEXT_MISSING`,
      paceContextConfirmed: `${league}_PACE_CONTEXT_MISSING`
    }
  };
}

function hasValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getRule(league, market) {
  const normalizedLeague = normalize(league);
  const leagueRules = SOCCER_ALIASES.has(normalizedLeague) ? RULES.soccer : RULES[normalizedLeague];
  if (!leagueRules) return null;

  const marketKey = normalize(market);
  if (normalizedLeague === 'tennis') {
    return marketKey === 'total games' ? leagueRules.total : { notApplicable: 'TENNIS_TOTAL_LOGIC_NOT_APPLICABLE' };
  }
  if (normalize(league) === 'mlb') {
    return marketKey === 'total runs' || marketKey === 'total'
      ? leagueRules.total
      : { notApplicable: 'MLB_TOTAL_LOGIC_NOT_APPLICABLE' };
  }
  return leagueRules.all;
}

/**
 * Assess whether explicitly supplied sport context is sufficient for a market.
 * @param {{ league?: string, market?: string, sportContext?: object }} [options]
 * @returns {{ status: 'resolved'|'unresolved'|'not_applicable', reasonCodes: string[], requiredFields: string[], missingFields: string[] }}
 */
function assessSportContext({ league, market, sportContext } = {}) {
  const rule = getRule(league, market);
  if (!rule) {
    return {
      status: 'not_applicable',
      reasonCodes: ['LEAGUE_NOT_COVERED'],
      requiredFields: [],
      missingFields: []
    };
  }

  if (rule.notApplicable) {
    return {
      status: 'not_applicable',
      reasonCodes: [rule.notApplicable],
      requiredFields: [],
      missingFields: []
    };
  }

  const context = sportContext && typeof sportContext === 'object' ? sportContext : {};
  const requiredFields = [...rule.requiredFields];
  const missingFields = requiredFields.filter((field) => !rule.checks[field](context[field]));
  const reasonCodes = missingFields.map((field) => rule.reasonCodes[field]);

  return {
    status: missingFields.length > 0 ? 'unresolved' : 'resolved',
    reasonCodes,
    requiredFields,
    missingFields
  };
}

module.exports = { assessSportContext };
