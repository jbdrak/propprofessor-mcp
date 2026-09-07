'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { assessSportContext } = require('../lib/propprofessor-context-gates');

const tennisContext = {
  gender: 'men',
  competitionScope: 'grand_slam',
  format: 'best_of_five'
};

const soccerContext = {
  outcomeStructure: 'three_way',
  competitionScope: 'epl'
};

const mlbContext = {
  startingPitchersConfirmed: true,
  lineupsConfirmed: true,
  weatherConfirmed: true
};

const footballContext = {
  kickoffTimingConfirmed: true,
  inactiveNewsTimingConfirmed: true,
  lineIdentityConfirmed: true
};

const basketballContext = {
  availabilityConfirmed: true,
  restConfirmed: true,
  paceContextConfirmed: true
};

const ufcContext = {
  replacementStatusConfirmed: true,
  weighInStatusConfirmed: true,
  weightClassConfirmed: true,
  boutFormatConfirmed: true
};

describe('assessSportContext', () => {
  it('exports a deterministic pure assessment with fresh arrays', () => {
    const first = assessSportContext({ league: 'UFC', market: 'Moneyline', sportContext: ufcContext });
    const second = assessSportContext({ league: 'UFC', market: 'Moneyline', sportContext: ufcContext });

    assert.deepEqual(first, {
      status: 'resolved',
      reasonCodes: [],
      requiredFields: [
        'replacementStatusConfirmed',
        'weighInStatusConfirmed',
        'weightClassConfirmed',
        'boutFormatConfirmed'
      ],
      missingFields: []
    });
    assert.notStrictEqual(first.reasonCodes, second.reasonCodes);
    assert.notStrictEqual(first.requiredFields, second.requiredFields);
  });

  it('resolves mens Grand Slam tennis totals only with explicit best-of-five context', () => {
    assert.deepEqual(assessSportContext({ league: 'Tennis', market: 'Total Games', sportContext: tennisContext }), {
      status: 'resolved',
      reasonCodes: [],
      requiredFields: ['gender', 'competitionScope', 'format'],
      missingFields: []
    });

    const unresolved = assessSportContext({
      league: 'Tennis',
      market: 'Total Games',
      sportContext: { ...tennisContext, format: 'best_of_three' }
    });
    assert.equal(unresolved.status, 'unresolved');
    assert.deepEqual(unresolved.reasonCodes, ['TENNIS_FORMAT_UNCONFIRMED']);
    assert.deepEqual(unresolved.missingFields, ['format']);
  });

  it('does not apply the tennis total rule to other tennis markets', () => {
    assert.deepEqual(assessSportContext({ league: 'Tennis', market: 'Moneyline', sportContext: {} }), {
      status: 'not_applicable',
      reasonCodes: ['TENNIS_TOTAL_LOGIC_NOT_APPLICABLE'],
      requiredFields: [],
      missingFields: []
    });
  });

  it('requires soccer three-way structure and competition scope', () => {
    for (const league of [
      'Soccer',
      'MLS',
      'EPL',
      'La Liga',
      'Bundesliga',
      'Ligue 1',
      'Liga MX',
      'Champions League',
      'Europa League',
      'EFL Championship'
    ]) {
      assert.equal(assessSportContext({ league, market: 'Moneyline', sportContext: soccerContext }).status, 'resolved');
    }

    const unresolved = assessSportContext({
      league: 'MLS',
      market: 'Match Handicap',
      sportContext: { outcomeStructure: 'two_way' }
    });
    assert.deepEqual(unresolved, {
      status: 'unresolved',
      reasonCodes: ['SOCCER_THREE_WAY_STRUCTURE_MISSING', 'SOCCER_COMPETITION_SCOPE_MISSING'],
      requiredFields: ['outcomeStructure', 'competitionScope'],
      missingFields: ['outcomeStructure', 'competitionScope']
    });
  });

  it('requires MLB pitcher, lineup, and weather context for totals', () => {
    assert.equal(
      assessSportContext({ league: 'MLB', market: 'Total Runs', sportContext: mlbContext }).status,
      'resolved'
    );

    const unresolved = assessSportContext({
      league: 'MLB',
      market: 'Total Runs',
      sportContext: { startingPitchersConfirmed: true, lineupsConfirmed: 'confirmed' }
    });
    assert.deepEqual(unresolved, {
      status: 'unresolved',
      reasonCodes: ['MLB_LINEUPS_UNCONFIRMED', 'MLB_WEATHER_UNCONFIRMED'],
      requiredFields: ['startingPitchersConfirmed', 'lineupsConfirmed', 'weatherConfirmed'],
      missingFields: ['lineupsConfirmed', 'weatherConfirmed']
    });
  });

  it('keeps NHL goalie confirmation as its own gate', () => {
    assert.equal(
      assessSportContext({ league: 'NHL', market: 'Moneyline', sportContext: { goaliesConfirmed: true } }).status,
      'resolved'
    );
    assert.deepEqual(assessSportContext({ league: 'NHL', market: 'Total Goals', sportContext: {} }), {
      status: 'unresolved',
      reasonCodes: ['NHL_GOALIE_CONFIRMATION_MISSING'],
      requiredFields: ['goaliesConfirmed'],
      missingFields: ['goaliesConfirmed']
    });
  });

  it('requires NFL timing and line identity with unchanged three-field behavior', () => {
    assert.equal(
      assessSportContext({ league: 'NFL', market: 'Point Spread', sportContext: footballContext }).status,
      'resolved'
    );

    assert.deepEqual(
      assessSportContext({
        league: 'NFL',
        market: 'Total Points',
        sportContext: { kickoffTimingConfirmed: true }
      }),
      {
        status: 'unresolved',
        reasonCodes: ['NFL_INACTIVE_NEWS_TIMING_MISSING', 'NFL_LINE_IDENTITY_MISSING'],
        requiredFields: ['kickoffTimingConfirmed', 'inactiveNewsTimingConfirmed', 'lineIdentityConfirmed'],
        missingFields: ['inactiveNewsTimingConfirmed', 'lineIdentityConfirmed']
      }
    );
  });

  it('requires NCAAF transfer context in addition to timing and line identity', () => {
    assert.deepEqual(assessSportContext({ league: 'NCAAF', market: 'Point Spread', sportContext: footballContext }), {
      status: 'unresolved',
      reasonCodes: ['NCAAF_TRANSFER_CONTEXT_MISSING'],
      requiredFields: [
        'kickoffTimingConfirmed',
        'inactiveNewsTimingConfirmed',
        'lineIdentityConfirmed',
        'transferContextConfirmed'
      ],
      missingFields: ['transferContextConfirmed']
    });
  });

  it('resolves NCAAF only when all four context fields are explicitly confirmed', () => {
    assert.deepEqual(
      assessSportContext({
        league: 'NCAAF',
        market: 'Point Spread',
        sportContext: { ...footballContext, transferContextConfirmed: true }
      }),
      {
        status: 'resolved',
        reasonCodes: [],
        requiredFields: [
          'kickoffTimingConfirmed',
          'inactiveNewsTimingConfirmed',
          'lineIdentityConfirmed',
          'transferContextConfirmed'
        ],
        missingFields: []
      }
    );
  });

  it('does not infer NCAAF transfer context from display-like strings', () => {
    const unresolved = assessSportContext({
      league: 'NCAAF',
      market: 'Point Spread',
      sportContext: { ...footballContext, transferContextConfirmed: 'confirmed' }
    });
    assert.equal(unresolved.status, 'unresolved');
    assert.deepEqual(unresolved.missingFields, ['transferContextConfirmed']);
    assert.deepEqual(unresolved.reasonCodes, ['NCAAF_TRANSFER_CONTEXT_MISSING']);
  });

  it('requires availability, rest, and pace context for basketball leagues', () => {
    for (const league of ['NBA', 'WNBA', 'NCAAB']) {
      assert.equal(
        assessSportContext({ league, market: 'Total Points', sportContext: basketballContext }).status,
        'resolved'
      );
    }

    assert.deepEqual(
      assessSportContext({ league: 'WNBA', market: 'Moneyline', sportContext: { availabilityConfirmed: true } }),
      {
        status: 'unresolved',
        reasonCodes: ['WNBA_REST_CONTEXT_MISSING', 'WNBA_PACE_CONTEXT_MISSING'],
        requiredFields: ['availabilityConfirmed', 'restConfirmed', 'paceContextConfirmed'],
        missingFields: ['restConfirmed', 'paceContextConfirmed']
      }
    );
  });

  it('requires UFC replacement, weigh-in, weight-class, and bout-format context', () => {
    assert.equal(
      assessSportContext({ league: 'UFC', market: 'Total Rounds', sportContext: ufcContext }).status,
      'resolved'
    );

    const unresolved = assessSportContext({
      league: 'UFC',
      market: 'Moneyline',
      sportContext: { replacementStatusConfirmed: true, weightClassConfirmed: true }
    });
    assert.deepEqual(unresolved, {
      status: 'unresolved',
      reasonCodes: ['UFC_WEIGH_IN_STATUS_MISSING', 'UFC_BOUT_FORMAT_MISSING'],
      requiredFields: [
        'replacementStatusConfirmed',
        'weighInStatusConfirmed',
        'weightClassConfirmed',
        'boutFormatConfirmed'
      ],
      missingFields: ['weighInStatusConfirmed', 'boutFormatConfirmed']
    });
  });

  it('fails closed for missing context and does not infer from display-like strings', () => {
    const result = assessSportContext({
      league: 'NBA',
      market: 'Total Points',
      sportContext: 'availability confirmed, rested, pace confirmed'
    });

    assert.deepEqual(result, {
      status: 'unresolved',
      reasonCodes: ['NBA_AVAILABILITY_MISSING', 'NBA_REST_CONTEXT_MISSING', 'NBA_PACE_CONTEXT_MISSING'],
      requiredFields: ['availabilityConfirmed', 'restConfirmed', 'paceContextConfirmed'],
      missingFields: ['availabilityConfirmed', 'restConfirmed', 'paceContextConfirmed']
    });
  });

  it('returns not_applicable for unknown or uncovered leagues', () => {
    for (const league of ['ATP', 'College Baseball', undefined]) {
      assert.deepEqual(assessSportContext({ league, market: 'Total', sportContext: {} }), {
        status: 'not_applicable',
        reasonCodes: ['LEAGUE_NOT_COVERED'],
        requiredFields: [],
        missingFields: []
      });
    }
  });
});
