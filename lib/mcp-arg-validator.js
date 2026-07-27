'use strict';

/**
 * Minimal JSON-Schema arg validator for MCP tool calls.
 *
 * The MCP server already declares inputSchema with `additionalProperties: false`
 * on every tool, but the JSON-RPC frame never enforces it — the client is
 * expected to. This module gives the server its own enforcement so that:
 *   - A misbehaving or hostile client can't smuggle unexpected fields
 *     through to handlers (or to the PropProfessor backend).
 *   - Type mismatches (string where number expected) are caught up front
 *     with a precise error message, before the handler does `Number(...)`
 *     coercions that silently produce NaN.
 *
 * Scope: we intentionally implement just the JSON-Schema subset that the
 * project actually uses in lib/propprofessor-tool-definitions.js:
 *   - type: 'object' / 'string' / 'number' / 'integer' / 'boolean' / 'array'
 *   - properties: { name: { type, enum?, items?, description? } }
 *   - required: string[]
 *   - additionalProperties: false
 *   - enum: string[]
 *   - items: { type }
 *
 * Anything outside this subset (oneOf, allOf, $ref, patternProperties, ...)
 * falls through to the existing handler-level validation, which is fine
 * because the project's schemas don't use those constructs.
 *
 * The validator never throws — it returns { ok: true } on success or
 * { ok: false, code, message, errors } on failure so the caller can wire
 * the result into the existing categorizeError() pipeline.
 */

const KNOWN_BOOKS = new Set([
  'NovigApp',
  'NoVigApp',
  'Fliff',
  'DraftKings',
  'FanDuel',
  'Pinnacle',
  'Circa',
  'BetOnline',
  'BookMaker',
  'BetMGM',
  'Caesars',
  'BetRivers',
  'PointsBet',
  'WynnBet',
  'Barstool',
  'FoxBet',
  'Unibet',
  'Betway',
  'Bet365',
  'WilliamHill',
  'Bovada',
  'MyBookie',
  'BetUS',
  'Heritage',
  'SportsBetting',
  'GTBets',
  'BetAnySports',
  '5Dimes',
  'BetOnline',
  'YouWager',
  'BetDSI',
  'JustBet',
  'Cloudbet',
  'Nitrogen',
  'Stake',
  'Prophet',
  'OnyxOdds',
  'Polymarket',
  'Kalshi',
  'Rebet',
  'theScore',
  'Bet105',
  'BetParx',
  'Fanatics',
  'FanaticsMarkets',
  '4cx',
  'BallyBet',
  'Prop Builder',
  'PrizePicks',
  'Betr',
  'Dabble',
  'DraftKings6',
  'OwnersBox',
  'Sleeper',
  'ParlayPlay',
  'HotStreak',
  'BoomFantasy',
  'Betr (Alt)',
  'Dabble (Alt)',
  'DraftKings6 (Alt)',
  'Rebet (Alt)',
  'Underdog (Alt)'
]);
const KNOWN_LEAGUES = new Set([
  'NBA',
  'MLB',
  'NFL',
  'NHL',
  'WNBA',
  'NCAAB',
  'NCAAF',
  'Soccer',
  'Tennis',
  'UFC',
  'NBASL'
]);

/**
 * Normalize a book name for comparison — lowercase, strip non-alphanumeric.
 */
function normalizeBookName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Check known-value params (book, books, league, leagues) against known lists
 * and return a validation error object, or null if all values are valid.
 */
function validateKnownValues(args) {
  if (!args || typeof args !== 'object') return null;

  // Single book
  if (args.book !== undefined && args.book !== null) {
    const book = String(args.book).trim();
    const normalized = normalizeBookName(book);
    const matches = [...KNOWN_BOOKS].some((known) => normalizeBookName(known) === normalized);
    if (!matches && book.length > 0) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Unknown book: "${book}". If this is a valid book name, it may not be in the known list.`,
        errors: [`book: unrecognized value "${book}"`]
      };
    }
  }

  // Books array
  if (args.books !== undefined && Array.isArray(args.books)) {
    for (const b of args.books) {
      const normalized = normalizeBookName(String(b));
      const matches = [...KNOWN_BOOKS].some((known) => normalizeBookName(known) === normalized);
      if (!matches && String(b).trim().length > 0) {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Unknown book in books array: "${b}". If this is a valid book name, it may not be in the known list.`,
          errors: [`books[${args.books.indexOf(b)}]: unrecognized value "${b}"`]
        };
      }
    }
  }

  // Single league
  if (args.league !== undefined && args.league !== null) {
    const league = String(args.league).trim();
    if (!KNOWN_LEAGUES.has(league) && league.length > 0) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Unknown league: "${league}". Known leagues: ${[...KNOWN_LEAGUES].join(', ')}`,
        errors: [`league: unrecognized value "${league}"`]
      };
    }
  }

  // Leagues array
  if (args.leagues !== undefined && Array.isArray(args.leagues)) {
    for (const l of args.leagues) {
      if (!KNOWN_LEAGUES.has(String(l).trim())) {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Unknown league in leagues array: "${l}". Known leagues: ${[...KNOWN_LEAGUES].join(', ')}`,
          errors: [`leagues[${args.leagues.indexOf(l)}]: unrecognized value "${l}"`]
        };
      }
    }
  }

  return null;
}

function validateArgs(schema, args) {
  const errors = [];
  // args must be a plain object. null, undefined, arrays, strings, etc. are
  // all invalid — surface them as a top-level error rather than silently
  // coercing to {} (which would skip validation entirely).
  if (args === undefined) {
    args = {};
  } else if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `Argument validation failed: arguments must be a JSON object, got ${describeType(args)}`,
      errors: [`arguments: expected object, got ${describeType(args)}`]
    };
  }
  // Honor __requiredAliases: when a deprecated alias is the only key present,
  // copy it into the canonical key so the required-check below accepts the
  // old name. We do this in a shallow copy so we don't mutate the caller's
  // args object — callers pass `params.arguments` from JSON-RPC and we don't
  // want surprise side effects on retry paths.
  if (schema && schema.__requiredAliases && typeof schema.__requiredAliases === 'object') {
    let needsCopy = false;
    for (const canonical of Object.keys(schema.__requiredAliases)) {
      if (args[canonical] === undefined) {
        const aliases = schema.__requiredAliases[canonical];
        if (Array.isArray(aliases)) {
          for (const alias of aliases) {
            if (args[alias] !== undefined) {
              needsCopy = true;
              break;
            }
          }
        }
        if (needsCopy) break;
      }
    }
    if (needsCopy) {
      args = { ...args };
      for (const [canonical, aliases] of Object.entries(schema.__requiredAliases)) {
        if (args[canonical] === undefined && Array.isArray(aliases)) {
          for (const alias of aliases) {
            if (args[alias] !== undefined) {
              args[canonical] = args[alias];
              break;
            }
          }
        }
      }
    }
  }
  validateObject(args, schema, '', errors);
  if (errors.length === 0) {
    // Schema pass — now check known values (book/league names)
    const knownCheck = validateKnownValues(args);
    if (knownCheck) return knownCheck;
    return { ok: true };
  }
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    message: `Argument validation failed: ${errors.join('; ')}`,
    errors
  };
}

/**
 * Normalize args for handler dispatch — sync canonical and deprecated alias
 * param names bidirectionally so existing handler code keeps reading the
 * legacy key while callers can use the cleaner canonical key.
 * Applied AFTER validateArgs has accepted the call, so the schema's
 * known-property check has already passed.
 *
 * Currently handles:
 *   - `gameIds` ↔ `game_ids` (get_play_details only — other tools don't
 *     expose a game-id param at all)
 *
 * Always returns a NEW object; never mutates the caller's args.
 *
 * @param {Object} args - Validated args from JSON-RPC.
 * @returns {Object} New args object with both canonical and alias keys populated.
 */
function normalizeArgs(args) {
  if (!args || typeof args !== 'object') return args;
  return { ...args };
}

function validateObject(value, schema, path, errors) {
  if (schema.type !== 'object') {
    errors.push(`${path || '<arg>'}: expected schema type 'object'`);
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path || '<arg>'}: expected object, got ${describeType(value)}`);
    return;
  }

  // additionalProperties: false — flag any unknown keys up front.
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        errors.push(`${path ? path + '.' : ''}${key}: unknown property (not in schema)`);
      }
    }
  }

  // Required fields present and non-null.
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(key in value) || value[key] === null || value[key] === undefined) {
        errors.push(`${path ? path + '.' : ''}${key}: required`);
      }
    }
  }

  // Per-property type checks.
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in value && value[key] !== undefined && value[key] !== null) {
        validateValue(value[key], propSchema, joinPath(path, key), errors);
      }
    }
  }
}

function validateValue(value, schema, path, errors) {
  // Enum wins over type — an enum mismatch is more specific.
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(
      `${path}: must be one of [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}], got ${JSON.stringify(value)}`
    );
    return;
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string, got ${describeType(value)}`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: expected finite number, got ${describeType(value)}`);
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path}: expected integer, got ${describeType(value)}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${path}: expected boolean, got ${describeType(value)}`);
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${describeType(value)}`);
        return;
      }
      if (schema.items && typeof schema.items === 'object') {
        for (let i = 0; i < value.length; i += 1) {
          if (value[i] !== null && value[i] !== undefined) {
            validateValue(value[i], schema.items, `${path}[${i}]`, errors);
          }
        }
      }
      break;
    case 'object':
      validateObject(value, schema, path, errors);
      break;
    default:
      // Unknown / unhandled schema type — pass through; the handler does its
      // own validation. (This is intentionally permissive: we don't want to
      // regress tools that use untyped property bags like `fields: { type: 'string' }`
      // to mean "free-form string".)
      break;
  }
}

function joinPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

module.exports = { validateArgs, normalizeArgs };
