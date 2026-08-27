'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGoogleNewsUrl,
  buildEspnSearchUrl,
  stripCdata,
  parseRss,
  parseEspnSearch
} = require('../lib/propprofessor-news-sources');

describe('buildGoogleNewsUrl', () => {
  it('encodes the query and uses the legacy RSS endpoint', () => {
    const url = buildGoogleNewsUrl('Patrick Mahomes');
    assert.ok(url.startsWith('https://news.google.com/rss/search?q='));
    assert.ok(url.includes(encodeURIComponent('Patrick Mahomes')));
    assert.ok(url.includes('ceid=US:en'));
  });
});

describe('buildEspnSearchUrl', () => {
  it('encodes the query into the ESPN search path', () => {
    const url = buildEspnSearchUrl('Luka Doncic');
    assert.ok(url.startsWith('https://www.espn.com/search/_/q/'));
    assert.ok(url.includes(encodeURIComponent('Luka Doncic')));
  });
});

describe('stripCdata', () => {
  it('removes CDATA wrappers', () => {
    assert.equal(stripCdata('<![CDATA[hello]]>'), 'hello');
    assert.equal(stripCdata('<![CDATA[line one\nline two]]>'), 'line one\nline two');
  });

  it('returns the string unchanged when no CDATA present', () => {
    assert.equal(stripCdata('plain text'), 'plain text');
  });

  it('returns empty string for non-string input', () => {
    assert.equal(stripCdata(null), '');
    assert.equal(stripCdata(undefined), '');
    assert.equal(stripCdata(42), '');
  });
});

describe('parseRss', () => {
  const xml = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[Team wins big]]></title>
    <link>https://news.example.com/1</link>
    <pubDate>Mon, 25 Aug 2026 10:00:00 GMT</pubDate>
    <source url="https://src.example">ESPN</source>
  </item>
  <item>
    <title>Tweet style post</title>
    <link>https://nitter.example/status/12345</link>
    <pubDate>Tue, 26 Aug 2026 12:00:00 GMT</pubDate>
    <dc:creator>@handle</dc:creator>
  </item>
  <item>
    <title>No source tag here</title>
    <link>https://news.example.com/3</link>
    <pubDate>Wed, 27 Aug 2026 08:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

  it('parses all items with title/link/pubDate', () => {
    const items = parseRss(xml);
    assert.equal(items.length, 3);
    assert.equal(items[0].title, 'Team wins big');
    assert.equal(items[0].link, 'https://news.example.com/1');
    assert.equal(items[0].pubDate, 'Mon, 25 Aug 2026 10:00:00 GMT');
  });

  it('reads standard <source> when present', () => {
    const items = parseRss(xml);
    assert.equal(items[0].source, 'ESPN');
  });

  it('falls back to <dc:creator> for Nitter-style items', () => {
    const items = parseRss(xml);
    assert.equal(items[1].source, '@handle');
  });

  it('leaves source empty when neither tag is present', () => {
    const items = parseRss(xml);
    assert.equal(items[2].source, '');
  });

  it('strips CDATA from title and source', () => {
    const items = parseRss(xml);
    assert.equal(items[0].title, 'Team wins big');
  });

  it('returns [] for non-string input', () => {
    assert.deepEqual(parseRss(null), []);
    assert.deepEqual(parseRss(''), []);
    assert.deepEqual(parseRss(123), []);
  });
});

describe('parseEspnSearch', () => {
  const html = `
    <a href="https://www.espn.com/nba/story/_/id/999">Lakers trade rumor details</a>
    <a href="https://espn.com/nba/story/_/id/998">Celtics injury update report</a>
    <a href="https://other.com/unrelated">Skip me</a>
    <a href="https://www.espn.com/nba/story/_/id/997">Short</a>
  `;

  it('extracts only espn.com article links with sufficient title length', () => {
    const items = parseEspnSearch(html);
    assert.equal(items.length, 2, 'drops non-espn link and too-short title');
    assert.equal(items[0].source, 'ESPN');
    assert.ok(items[0].title.includes('Lakers'));
    assert.equal(items[0].pubDate, '');
  });

  it('caps at 10 results', () => {
    const big = Array.from(
      { length: 15 },
      (_, i) => `<a href="https://www.espn.com/x/${i}">Article number ${i} long enough</a>`
    ).join('');
    const items = parseEspnSearch(big);
    assert.equal(items.length, 10);
  });

  it('returns [] for non-string input', () => {
    assert.deepEqual(parseEspnSearch(null), []);
    assert.deepEqual(parseEspnSearch(''), []);
  });
});
