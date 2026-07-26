'use strict';

/**
 * PropProfessor Schedule Service
 * Replaces all workarounds for stale tennis game dates with authoritative schedule source.
 * Primary source: Sofascore (covers ATP/WTA/Challenger/ITF)
 * Fallback: ESPN tennis schedule for ATP/WTA only
 */

const https = require('https');
const http = require('http');

/**
 * Fetch tennis schedule from Sofascore API
 * @param {string} date - ISO date string (YYYY-MM-DD)
 * @returns {Promise<Array>} Array of tournament events
 */
/**
 * Try fetching from the Sofascore scheduled-events endpoint (what their web UI uses).
 * More likely to return data than the scheduled-tournaments endpoint.
 */
async function fetchSofascoreEventsByDate(date) {
  const endpoints = [
    `https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/${date}`,
    `https://api.sofascore.com/api/v1/sport/tennis/scheduled-tournaments/${date}/page/1`
  ];

  for (const url of endpoints) {
    try {
      const data = await httpGet(
        url,
        {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.sofascore.com/',
          Origin: 'https://www.sofascore.com'
        },
        10000
      );

      const parsed = JSON.parse(data);
      const events = parsed.events || [];
      if (events.length > 0) {
        console.error(`[schedule] Found ${events.length} events from Sofascore endpoint: ${url}`);
        return events;
      }
    } catch {
      continue;
    }
  }

  throw new Error('All Sofascore endpoints failed');
}

/**
 * Simple HTTPS GET helper.
 */
function httpGet(url, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function fetchSofascoreSchedule(date) {
  return fetchSofascoreEventsByDate(date);
}

/**
 * Fetch ESPN tennis schedule for ATP/WTA tournaments using their scoreboard API.
 * Same endpoint that fetchEspnMatches() in propprofessor-tennis.js uses.
 * @param {string} date - ISO date string (YYYY-MM-DD)
 * @returns {Promise<Array>} Array of ESPN match data
 */
async function fetchESPNTennisSchedule(date) {
  const allMatches = [];
  const circuits = ['atp', 'wta'];

  for (const circuit of circuits) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/tennis/${circuit}/scoreboard?dates=${date}`;
      const data = await httpGet(
        url,
        {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
          Accept: 'application/json'
        },
        10000
      );

      const parsed = JSON.parse(data);
      const events = Array.isArray(parsed?.events) ? parsed.events : [];

      for (const event of events) {
        const groupings = Array.isArray(event?.groupings) ? event.groupings : [];
        for (const group of groupings) {
          const competitions = Array.isArray(group?.competitions) ? group.competitions : [];
          for (const comp of competitions) {
            const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
            if (competitors.length < 2) continue;

            const player1 = competitors[0]?.athlete?.displayName || '';
            const player2 = competitors[1]?.athlete?.displayName || '';
            if (!player1 || !player2) continue;

            allMatches.push({
              eventId: comp.id || event.id,
              startTime: comp.date || '',
              participants: [{ name: player1.trim() }, { name: player2.trim() }],
              tournament: event.league?.name || event.shortName || `${circuit.toUpperCase()} Tournament`
            });
          }
        }
      }
    } catch {
      continue;
    }
  }

  console.error(`[schedule] Found ${allMatches.length} matches from ESPN`);
  return allMatches;
}

/**
 * Convert Sofascore event data to PropProfessor game format
 * @param {Object} event - Sofascore event object
 * @param {string} tournament - Tournament name
 * @returns {Object} Game object with gameId
 */
function mapSofascoreEventToGame(event, tournament) {
  const eventId = event.id?.toString();
  const startTimestamp = event.startTime || event.time;

  if (!eventId || !startTimestamp) {
    return null;
  }

  // Extract teams from participants
  const participants = event.participants || [];
  const player1 = participants[0]?.name || '';
  const player2 = participants[1]?.name || '';

  if (!player1 || !player2) {
    return null;
  }

  // Generate gameId using PP's convention: Tennis:PREMATCH:player1:player2:unixTimestamp
  const unixTimestamp = Math.floor(startTimestamp / 1000);
  const gameId = `Tennis:PREMATCH:${player1}:${player2}:${unixTimestamp}`;

  return {
    gameId,
    tournament,
    startTimestamp,
    homeTeam: player1,
    awayTeam: player2,
    eventId,
    // Store original Sofascore data for reference
    sofascoreData: {
      event,
      tournament
    }
  };
}

/**
 * Get today's tennis schedule with Sofascore as primary source
 * @returns {Promise<Array>} Array of ScheduleGame objects
 */
async function getTodayTennisSchedule() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  let scheduleGames = [];

  try {
    // Try Sofascore first (primary source)
    const sofascoreEvents = await fetchSofascoreSchedule(today);
    console.error(`[schedule] Found ${sofascoreEvents.length} events from Sofascore`);

    for (const event of sofascoreEvents) {
      const tournament = event.tournament?.name || 'Unknown Tournament';
      const mappedGame = mapSofascoreEventToGame(event, tournament);

      if (mappedGame) {
        scheduleGames.push(mappedGame);
      }
    }
  } catch (err) {
    console.warn('[schedule] Sofascore failed, using ESPN fallback:', err.message);

    // Fallback to ESPN for ATP/WTA tournaments
    try {
      const espnMatches = await fetchESPNTennisSchedule(today);
      console.error(`[schedule] Found ${espnMatches.length} matches from ESPN`);

      for (const match of espnMatches) {
        const mappedGame = mapSofascoreEventToGame(
          {
            id: match.eventId,
            startTime: match.startTime,
            participants: match.participants
          },
          match.tournament || 'ESPN Tournament'
        );

        if (mappedGame) {
          scheduleGames.push(mappedGame);
        }
      }
    } catch (espnErr) {
      console.error('[schedule] ESPN fallback also failed:', espnErr.message);
      // Both sources failed - continue with empty schedule
    }
  }

  console.error(`[schedule] Total scheduled games for ${today}: ${scheduleGames.length}`);
  return scheduleGames;
}

/**
 * Get gameId from schedule based on teams and date
 * @param {Array} scheduleGames - Array of ScheduleGame objects
 * @param {string} homeTeam - Home team name
 * @param {string} awayTeam - Away team name
 * @param {string} date - Date (YYYY-MM-DD)
 * @returns {string|null} GameId or null if not found
 */
function getGameIdFromSchedule(scheduleGames, homeTeam, awayTeam, date) {
  // Normalize team names for matching
  const normalize = (name) => name?.toLowerCase().trim();
  const homeNorm = normalize(homeTeam);
  const awayNorm = normalize(awayTeam);

  for (const game of scheduleGames) {
    const gameDate = new Date(game.startTimestamp).toISOString().split('T')[0];

    if (gameDate !== date) continue;

    const homeGameNorm = normalize(game.homeTeam);
    const awayGameNorm = normalize(game.awayTeam);

    // Match both teams (order doesn't matter for tennis)
    if (
      (homeNorm === homeGameNorm && awayNorm === awayGameNorm) ||
      (homeNorm === awayGameNorm && awayNorm === homeGameNorm)
    ) {
      return game.gameId;
    }
  }

  return null;
}

module.exports = {
  fetchSofascoreSchedule,
  fetchESPNTennisSchedule,
  mapSofascoreEventToGame,
  getTodayTennisSchedule,
  getGameIdFromSchedule
};
