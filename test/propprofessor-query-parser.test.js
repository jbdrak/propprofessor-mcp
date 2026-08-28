'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  inferDefaultLeague,
  inferDefaultMarket,
  inferPreferredBook,
  parseNaturalLanguagePropQuery
} = require('../lib/propprofessor-query-parser');
const { getPropMarketsForSport } = require('../lib/propprofessor-market-registry');

describe('propprofessor query parser', () => {
  it('parses a player prop question with book, line, and side', () => {
    const parsed = parseNaturalLanguagePropQuery('is Fliff James Harden points over 18.5 good');
    assert.equal(parsed.book, 'Fliff');
    assert.equal(parsed.player, 'James Harden');
    assert.equal(parsed.side, 'over');
    assert.equal(parsed.line, 18.5);
    assert.equal(parsed.intent, 'screen');
  });

  it('infers tennis edge searches from simple prompts', () => {
    const parsed = parseNaturalLanguagePropQuery('find Rebet tennis edges');
    assert.equal(parsed.league, 'Tennis');
    assert.equal(parsed.book, 'Rebet');
    assert.equal(parsed.market, 'Moneyline');
    assert.equal(parsed.intent, 'screen');
  });

  it('infers a strikeouts market for MLB prompts', () => {
    const parsed = parseNaturalLanguagePropQuery('best NoVigApp MLB strikeouts');
    assert.equal(parsed.league, 'MLB');
    assert.equal(parsed.book, 'NoVigApp');
    assert.equal(parsed.market, 'Pitcher Strikeouts');
  });

  it('distinguishes player strikeouts from pitcher strikeouts', () => {
    assert.equal(inferDefaultMarket('MLB player strikeouts', 'MLB'), 'Player Strikeouts');
    assert.equal(inferDefaultMarket('MLB pitcher strikeouts', 'MLB'), 'Pitcher Strikeouts');
  });

  it('recognizes the live MLB player and pitcher prop names', () => {
    assert.equal(inferDefaultMarket('player hits', 'MLB'), 'Player Hits');
    assert.equal(inferDefaultMarket('player runs', 'MLB'), 'Player Runs');
    assert.equal(inferDefaultMarket('player triples', 'MLB'), 'Player Triples');
    assert.equal(inferDefaultMarket('player walks', 'MLB'), 'Player Walks');
    assert.equal(inferDefaultMarket('pitcher earned runs allowed', 'MLB'), 'Pitcher Earned Runs Allowed');
    assert.equal(inferDefaultMarket('pitcher walks allowed', 'MLB'), 'Pitcher Walks Allowed');
    assert.equal(inferDefaultMarket('pitcher outs recorded', 'MLB'), 'Pitcher Outs Recorded');
  });

  it('checks combo and team-total phrases before component prop keywords', () => {
    assert.equal(inferDefaultMarket('player points rebounds assists', 'WNBA'), 'Player Points + Rebounds + Assists');
    assert.equal(inferDefaultMarket('team total points', 'WNBA'), 'Team Total Points');
  });

  it('keeps fantasy phrasing on the screen intent now that fantasy is not a public CLI command', () => {
    const parsed = parseNaturalLanguagePropQuery('is Underdog fantasy good today');
    assert.equal(parsed.intent, 'screen');
    assert.equal(parsed.book, 'Underdog');
  });

  it('exposes the helper inferencers', () => {
    assert.equal(inferPreferredBook('use Rebet'), 'Rebet');
    assert.equal(inferDefaultLeague('nba player points'), 'NBA');
    assert.equal(inferDefaultMarket('tennis spread', 'Tennis'), 'Spread');
  });

  it('infers MLS from mls / major league soccer phrasing', () => {
    assert.equal(inferDefaultLeague('mls'), 'MLS');
    assert.equal(inferDefaultLeague('major league soccer odds'), 'MLS');
  });

  it('routes OnyxOdds queries to the OnyxOdds book with suggested books', () => {
    const parsed = parseNaturalLanguagePropQuery('best MLB play on OnyxOdds');
    assert.equal(parsed.book, 'OnyxOdds');
    assert.equal(parsed.league, 'MLB');
    assert.deepEqual(parsed.suggestedTool.args, { books: ['OnyxOdds'] });
    assert.equal(inferPreferredBook('use OnyxOdds'), 'OnyxOdds');
  });

  it('infers NCAAF from specific college football phrasing over generic football', () => {
    assert.equal(inferDefaultLeague('college football odds'), 'NCAAF');
    assert.equal(parseNaturalLanguagePropQuery('best college football play').league, 'NCAAF');
  });

  it('still infers NFL from plain football phrasing', () => {
    assert.equal(inferDefaultLeague('football odds'), 'NFL');
    assert.equal(parseNaturalLanguagePropQuery('best football play').league, 'NFL');
  });

  it('still infers NCAAF from the explicit ncaaf keyword', () => {
    assert.equal(inferDefaultLeague('ncaaf'), 'NCAAF');
    assert.equal(parseNaturalLanguagePropQuery('best ncaaf passing play').league, 'NCAAF');
  });

  it('infers the existing NCAAF player yards prop markets', () => {
    assert.equal(inferDefaultMarket('college football passing yards'), 'Player Passing Yards');
    assert.equal(inferDefaultMarket('college football rushing yards'), 'Player Rushing Yards');
    assert.equal(inferDefaultMarket('college football receiving yards'), 'Player Receiving Yards');
  });

  it('keeps the parser aligned with every observed prop registry market', () => {
    for (const league of ['MLB', 'WNBA', 'NFL', 'NCAAF']) {
      for (const market of getPropMarketsForSport(league)) {
        assert.equal(inferDefaultMarket(`${league} ${market}`, league), market, `${league} ${market}`);
      }
    }
  });
});
