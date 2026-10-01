/**
 * Every knob of this server is an environment variable, so the container can be
 * configured from the outside without rebuilding or mounting a config file.
 */

const TRUTHY = /^(1|true|yes|on|enabled?)$/i;
const FALSY = /^(0|false|no|off|disabled?)$/i;

function readBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (TRUTHY.test(raw)) return true;
  if (FALSY.test(raw)) return false;
  throw new Error(`Expected a boolean value, got "${raw}"`);
}

function readInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected an integer, got "${value}"`);
  return parsed;
}

function readString(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function readJson(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function readEnum(value, allowed, fallback, name) {
  const raw = readString(value, fallback);
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')} — got "${raw}"`);
  }
  return raw;
}

/**
 * Basic Auth accounts come either as a single user/password pair or as a
 * comma separated list. Passwords may contain ":" — only the first one splits.
 */
function readUsers(env) {
  const users = new Map();

  const singleUser = readString(env.BASIC_AUTH_USER, '');
  const singlePassword = readString(env.BASIC_AUTH_PASSWORD, '');
  if (singleUser && singlePassword) users.set(singleUser, singlePassword);
  if (Boolean(singleUser) !== Boolean(singlePassword)) {
    throw new Error('BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must both be set');
  }

  for (const entry of readString(env.BASIC_AUTH_USERS, '').split(',')) {
    const pair = entry.trim();
    if (!pair) continue;
    const separator = pair.indexOf(':');
    if (separator < 1 || separator === pair.length - 1) {
      throw new Error('BASIC_AUTH_USERS must look like "user:password,other:secret"');
    }
    users.set(pair.slice(0, separator), pair.slice(separator + 1));
  }

  return users;
}

export function loadConfig(env = process.env) {
  const includeDir = readString(env.MJML_INCLUDE_DIR, '/var/lib/mjml/includes');

  return {
    server: {
      host: readString(env.HOST, '0.0.0.0'),
      port: readInt(env.PORT, 8080),
      bodyLimit: readInt(env.MAX_BODY_SIZE, 2 * 1024 * 1024),
      trustProxy: readBool(env.TRUST_PROXY, false),
      logLevel: readEnum(
        env.LOG_LEVEL,
        ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
        'info',
        'LOG_LEVEL',
      ),
      requestLogging: readBool(env.REQUEST_LOGGING, false),
    },
    cors: {
      origin: readString(env.CORS ?? env.CORS_ORIGIN, ''),
    },
    auth: {
      users: readUsers(env),
      realm: readString(env.BASIC_AUTH_REALM, 'mjml-server'),
      protectHealth: readBool(env.BASIC_AUTH_PROTECT_HEALTH, false),
    },
    response: {
      // "html" keeps drop-in compatibility with other mjml-server images,
      // "json" returns { html, errors, ... } instead.
      format: readEnum(env.RESPONSE_FORMAT, ['html', 'json'], 'html', 'RESPONSE_FORMAT'),
      contentType: readString(env.RESPONSE_CONTENT_TYPE, 'text/html; charset=utf-8'),
    },
    mjml: {
      validationLevel: readEnum(
        env.MJML_VALIDATION_LEVEL,
        ['skip', 'soft', 'strict'],
        'soft',
        'MJML_VALIDATION_LEVEL',
      ),
      minify: readBool(env.MJML_MINIFY, false),
      beautify: readBool(env.MJML_BEAUTIFY, false),
      keepComments: readBool(env.MJML_KEEP_COMMENTS, true),
      fonts: readJson(env.MJML_FONTS, undefined, 'MJML_FONTS'),
      includes: readBool(env.MJML_INCLUDES, false),
      includeDir,
    },
  };
}
