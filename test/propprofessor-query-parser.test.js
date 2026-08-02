'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  inferDefaultLeague,
  inferDefaultMarket,
  inferPreferredBook,
  parseNaturalLanguagePropQuery
} = require('../lib/propprofessor-query-parser');

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
});
