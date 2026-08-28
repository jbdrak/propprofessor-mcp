'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPlayerSelection } = require('../lib/propprofessor-selection-type');

describe('isPlayerSelection', () => {
  it('returns true for individual player names', () => {
    assert.strictEqual(isPlayerSelection('LeBron James'), true);
    assert.strictEqual(isPlayerSelection('Shohei Ohtani'), true);
    assert.strictEqual(isPlayerSelection('Frances Tiafoe'), true);
    assert.strictEqual(isPlayerSelection('Karl-Anthony Towns'), true);
    assert.strictEqual(isPlayerSelection('Caitlin Clark'), true);
  });

  it('returns false for team names', () => {
    assert.strictEqual(isPlayerSelection('New York Mets'), false);
    assert.strictEqual(isPlayerSelection('Los Angeles Lakers'), false);
    assert.strictEqual(isPlayerSelection('Minnesota Lynx'), false);
    assert.strictEqual(isPlayerSelection('Cincinnati Reds'), false);
    assert.strictEqual(isPlayerSelection('Boston Red Sox'), false);
    assert.strictEqual(isPlayerSelection('Golden State Warriors'), false);
  });

  it('returns false for line labels', () => {
    assert.strictEqual(isPlayerSelection('Under 7.5'), false);
    assert.strictEqual(isPlayerSelection('Over 180.5'), false);
    assert.strictEqual(isPlayerSelection('Under 169.5'), false);
    assert.strictEqual(isPlayerSelection('Over 8.5'), false);
  });

  it('returns false for market-qualified teams', () => {
    assert.strictEqual(isPlayerSelection('New York Mets -1.5'), false);
    assert.strictEqual(isPlayerSelection('New York Mets +2.5'), false);
    assert.strictEqual(isPlayerSelection('Cincinnati Reds -1.5'), false);
    assert.strictEqual(isPlayerSelection('New York Liberty -6.5'), false);
    assert.strictEqual(isPlayerSelection('Dallas Wings +7.5'), false);
  });

  it('returns false for team totals', () => {
    assert.strictEqual(isPlayerSelection('Team Total Points'), false);
    assert.strictEqual(isPlayerSelection('Team Total Runs'), false);
    assert.strictEqual(isPlayerSelection('Team Total Touchdowns'), false);
  });

  it('returns true for player + prop label', () => {
    assert.strictEqual(isPlayerSelection('Giannis Antetokounmpo Points'), true);
    assert.strictEqual(isPlayerSelection('LeBron James Assists'), true);
    assert.strictEqual(isPlayerSelection('Luka Doncic Rebounds'), true);
    assert.strictEqual(isPlayerSelection('Shohei Ohtani Strikeouts'), true);
  });

  it('returns true for player props with Under/Over prefix', () => {
    // These are player props that begin with "Under" but end with a stat suffix
    assert.strictEqual(isPlayerSelection('Under 7.5 Strikeouts'), true);
    assert.strictEqual(isPlayerSelection('Over 200.5 Passing Yards'), false); // "Yards" not in suffix list
  });

  it('returns false for empty/undefined/null', () => {
    assert.strictEqual(isPlayerSelection(''), false);
    assert.strictEqual(isPlayerSelection(null), false);
    assert.strictEqual(isPlayerSelection(undefined), false);
  });

  it('returns true for single-word surnames', () => {
    assert.strictEqual(isPlayerSelection('Ohtani'), true);
    assert.strictEqual(isPlayerSelection('Tatum'), true);
    assert.strictEqual(isPlayerSelection('Tiafoe'), true);
  });
});
