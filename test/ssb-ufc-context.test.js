'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports getUfcContext, detectEventType, detectWeightClass, detectFightImportance', () => {
    const mod = require('../lib/ssb-ufc-context');
    assert.equal(typeof mod.getUfcContext, 'function');
    assert.equal(typeof mod.detectEventType, 'function');
    assert.equal(typeof mod.detectWeightClass, 'function');
    assert.equal(typeof mod.detectFightImportance, 'function');
  });
});

// ---------------------------------------------------------------------------
// detectEventType
// ---------------------------------------------------------------------------

describe('detectEventType', () => {
  it('returns Unknown for empty / non-string input', () => {
    const { detectEventType } = require('../lib/ssb-ufc-context');
    assert.equal(detectEventType(), 'Unknown');
    assert.equal(detectEventType(null), 'Unknown');
    assert.equal(detectEventType(''), 'Unknown');
    assert.equal(detectEventType(42), 'Unknown');
  });

  it('detects numbered PPV events', () => {
    const { detectEventType } = require('../lib/ssb-ufc-context');
    assert.equal(detectEventType('UFC 300'), 'PPV');
    assert.equal(detectEventType('UFC 290'), 'PPV');
    assert.equal(detectEventType('UFC 2'), 'PPV');
    assert.equal(detectEventType('UFC 5'), 'PPV');
  });

  it('detects Fight Night events', () => {
    const { detectEventType } = require('../lib/ssb-ufc-context');
    assert.equal(detectEventType('UFC Fight Night: Edwards vs Brady'), 'Fight Night');
    assert.equal(detectEventType('UFC Fight Night: Whittaker vs Aliskerov'), 'Fight Night');
    assert.equal(detectEventType('UFC Fight Night: Moicano vs Saint-Denis'), 'Fight Night');
  });

  it('detects ESPN cards', () => {
    const { detectEventType } = require('../lib/ssb-ufc-context');
    assert.equal(detectEventType('UFC on ESPN: Cannonier vs Borralho'), 'ESPN Card');
    assert.equal(detectEventType('UFC on ABC: Sandhagen vs Nurmagomedov'), 'ESPN Card');
  });

  it('detects TUF Finale events', () => {
    const { detectEventType } = require('../lib/ssb-ufc-context');
    assert.equal(detectEventType('TUF Finale: Grasso vs Araujo'), 'TUF Finale');
  });

  it('detects literal PPV mention', () => {
    const { detectEventType } = require('../lib/ssb-ufc-context');
    assert.equal(detectEventType('UFC PPV Event'), 'PPV');
  });

  it('returns Unknown for unrecognised event names', () => {
    const { detectEventType } = require('../lib/ssb-ufc-context');
    assert.equal(detectEventType('Random Fighting Championship'), 'Unknown');
    assert.equal(detectEventType('Bellator 300'), 'Unknown');
  });
});

// ---------------------------------------------------------------------------
// detectWeightClass
// ---------------------------------------------------------------------------

describe('detectWeightClass', () => {
  it('returns null for empty / non-string input', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass(), null);
    assert.equal(detectWeightClass(null), null);
    assert.equal(detectWeightClass(''), null);
    assert.equal(detectWeightClass(42), null);
  });

  it('detects Heavyweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Heavyweight'), 'Heavyweight');
  });

  it('detects Light Heavyweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Light Heavyweight'), 'Light Heavyweight');
    assert.equal(detectWeightClass('Light-Heavyweight'), 'Light Heavyweight');
  });

  it('detects Middleweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Middleweight'), 'Middleweight');
  });

  it('detects Welterweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Welterweight'), 'Welterweight');
  });

  it('detects Lightweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Lightweight'), 'Lightweight');
  });

  it('detects Featherweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Featherweight'), 'Featherweight');
  });

  it('detects Bantamweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Bantamweight'), 'Bantamweight');
  });

  it('detects Flyweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Flyweight'), 'Flyweight');
  });

  it('detects Strawweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Strawweight'), 'Strawweight');
  });

  it("detects Women's divisions", () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass("Women's Strawweight"), "Women's Strawweight");
    assert.equal(detectWeightClass("Women's Flyweight"), "Women's Flyweight");
    assert.equal(detectWeightClass("Women's Bantamweight"), "Women's Bantamweight");
    assert.equal(detectWeightClass("Women's Featherweight"), "Women's Featherweight");
  });

  it('detects Catchweight', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Catchweight'), 'Catchweight');
  });

  it('returns null for unrecognised weight class', () => {
    const { detectWeightClass } = require('../lib/ssb-ufc-context');
    assert.equal(detectWeightClass('Cruiserweight'), null);
    assert.equal(detectWeightClass('SuperMiddle'), null);
    assert.equal(detectWeightClass('DivisionX'), null);
  });
});

// ---------------------------------------------------------------------------
// detectFightImportance
// ---------------------------------------------------------------------------

describe('detectFightImportance', () => {
  it('returns null for empty / non-string input', () => {
    const { detectFightImportance } = require('../lib/ssb-ufc-context');
    assert.equal(detectFightImportance(), null);
    assert.equal(detectFightImportance(null), null);
    assert.equal(detectFightImportance(''), null);
  });

  it('detects Main Event', () => {
    const { detectFightImportance } = require('../lib/ssb-ufc-context');
    assert.equal(detectFightImportance('Main Event'), 'Main Event');
    assert.equal(detectFightImportance('main event'), 'Main Event');
  });

  it('detects Co-Main', () => {
    const { detectFightImportance } = require('../lib/ssb-ufc-context');
    assert.equal(detectFightImportance('Co-Main'), 'Co-Main');
    assert.equal(detectFightImportance('Co-Main Event'), 'Co-Main');
    assert.equal(detectFightImportance('Co Main'), 'Co-Main');
  });

  it('detects Prelim', () => {
    const { detectFightImportance } = require('../lib/ssb-ufc-context');
    assert.equal(detectFightImportance('Prelim'), 'Prelim');
    assert.equal(detectFightImportance('Prelims'), 'Prelim');
  });

  it('detects Early Prelim', () => {
    const { detectFightImportance } = require('../lib/ssb-ufc-context');
    assert.equal(detectFightImportance('Early Prelim'), 'Early Prelim');
    assert.equal(detectFightImportance('early prelims'), 'Early Prelim');
  });

  it('returns null for unrecognised description', () => {
    const { detectFightImportance } = require('../lib/ssb-ufc-context');
    assert.equal(detectFightImportance('Some random fight'), null);
  });
});

// ---------------------------------------------------------------------------
// getUfcContext
// ---------------------------------------------------------------------------

describe('getUfcContext', () => {
  it('returns the correct output shape with ok: true and sport: UFC', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({});
    assert.equal(result.ok, true);
    assert.equal(result.sport, 'UFC');
    assert.equal(typeof result.eventType, 'string');
    assert.equal(typeof result.riskFlag, 'string');
    assert.equal(typeof result.signals, 'object');
    assert.equal(typeof result.fetchedAt, 'string');
  });

  it('detects PPV event type from numbered event', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC 300' });
    assert.equal(result.eventType, 'PPV');
    assert.equal(result.riskFlag, 'clean');
    assert.ok(result.riskSummary.includes('PPV'));
  });

  it('detects Fight Night event type', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC Fight Night: Edwards vs Brady' });
    assert.equal(result.eventType, 'Fight Night');
    assert.equal(result.riskFlag, 'low');
    assert.ok(result.riskSummary.includes('Fight Night'));
  });

  it('detects ESPN Card event type', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC on ESPN: Cannonier vs Borralho' });
    assert.equal(result.eventType, 'ESPN Card');
    assert.equal(result.riskFlag, 'low');
    assert.ok(result.riskSummary.includes('ESPN'));
  });

  it('detects ABC event type', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC on ABC: Sandhagen vs Nurmagomedov' });
    assert.equal(result.eventType, 'ESPN Card');
    assert.equal(result.riskFlag, 'low');
    assert.ok(result.riskSummary.includes('ABC'));
  });

  it('returns unknown for unrecognised event', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'Some Random Event' });
    assert.equal(result.eventType, 'Unknown');
    assert.equal(result.riskFlag, 'unknown');
    assert.ok(result.riskSummary.includes('Unable to assess'));
  });

  it('detects weight class when provided', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC 300', weightClass: 'Lightweight' });
    assert.equal(result.weightClass, 'Lightweight');
    assert.ok(result.riskSummary.includes('Lightweight'));
  });

  it('includes weight class in signals', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC 300', weightClass: 'Heavyweight' });
    assert.equal(result.signals.weightClass, 'Heavyweight');
    assert.equal(result.signals.eventType, 'PPV');
  });

  it('returns null weightClass when not provided', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC 300' });
    assert.equal(result.weightClass, null);
    assert.equal(result.signals.weightClass, null);
  });

  it('returns fightImportance as null', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC 300' });
    assert.equal(result.fightImportance, null);
  });

  it('returns riskFlag clean for PPV headliners', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC 300', weightClass: 'Heavyweight' });
    assert.equal(result.riskFlag, 'clean');
  });

  it('returns riskFlag low for Fight Night', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC Fight Night: Edwards vs Brady' });
    assert.equal(result.riskFlag, 'low');
  });

  it('returns riskFlag low for ESPN cards', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC on ESPN: Fight Night' });
    assert.equal(result.riskFlag, 'low');
  });

  it('returns riskFlag low for TUF Finale', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'TUF Finale: Grasso vs Araujo' });
    assert.equal(result.riskFlag, 'low');
  });

  it('handles full PPV event name with all params', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({
      event: 'UFC 300',
      weightClass: 'Lightweight',
      fighter1: 'Islam Makhachev',
      fighter2: 'Arman Tsarukyan',
      fightId: 'ufc-300-main-event'
    });
    assert.equal(result.ok, true);
    assert.equal(result.sport, 'UFC');
    assert.equal(result.eventType, 'PPV');
    assert.equal(result.weightClass, 'Lightweight');
    assert.equal(result.riskFlag, 'clean');
    assert.equal(result.signals.eventType, 'PPV');
    assert.equal(result.signals.weightClass, 'Lightweight');
  });

  it('handles full Fight Night with all params', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({
      event: 'UFC Fight Night: Whittaker vs Aliskerov',
      weightClass: 'Middleweight',
      fighter1: 'Robert Whittaker',
      fighter2: 'Ikram Aliskerov'
    });
    assert.equal(result.eventType, 'Fight Night');
    assert.equal(result.weightClass, 'Middleweight');
    assert.equal(result.riskFlag, 'low');
    assert.ok(result.riskSummary.includes('Middleweight'));
  });

  it('detects Women division weight classes', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({
      event: 'UFC 306',
      weightClass: "Women's Bantamweight"
    });
    assert.equal(result.weightClass, "Women's Bantamweight");
  });

  it('passes unrecognised weight class through as-is', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({
      event: 'UFC Fight Night',
      weightClass: 'CatchweightClass'
    });
    // "CatchweightClass" doesn't match any pattern, so it should pass through as-is
    assert.equal(result.weightClass, 'CatchweightClass');
  });

  it('has fetchedAt as valid ISO string', () => {
    const { getUfcContext } = require('../lib/ssb-ufc-context');
    const result = getUfcContext({ event: 'UFC 300' });
    assert.equal(typeof result.fetchedAt, 'string');
    assert.ok(result.fetchedAt.length > 0);
    assert.ok(!isNaN(Date.parse(result.fetchedAt)));
  });
});
