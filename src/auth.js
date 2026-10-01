/**
 * Basic Auth as a Fastify onRequest hook. Enabled as soon as at least one
 * account is configured, otherwise the server stays wide open.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Hash first so the comparison is constant time regardless of input length. */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function parseHeader(header) {
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'basic') return null;

  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;

  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

export function createBasicAuthHook({ users, realm, publicRoutes = new Set() }) {
  if (users.size === 0) return null;

  const credentials = new Map(
    [...users].map(([user, password]) => [user, digest(password)]),
  );
  // Compared against when the user is unknown, so both cases cost the same.
  const decoy = digest(Math.random().toString(36));
  const challenge = `Basic realm="${realm.replace(/"/g, '')}", charset="UTF-8"`;

  return async function basicAuth(request, reply) {
    if (publicRoutes.has(request.routeOptions?.url ?? request.url)) return;

    const provided = parseHeader(request.headers.authorization);
    const expected = provided ? credentials.get(provided.user) : undefined;
    const authenticated =
      provided !== null && timingSafeEqual(digest(provided.password), expected ?? decoy) && expected !== undefined;

    if (!authenticated) {
      request.log.warn({ ip: request.ip, user: provided?.user }, 'basic auth failed');
      return reply
        .code(401)
        .header('WWW-Authenticate', challenge)
        .send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or missing credentials' });
    }

    request.user = provided.user;
  };
}
