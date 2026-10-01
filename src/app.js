import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';

import { createBasicAuthHook } from './auth.js';
import { MjmlInputError, mjmlVersion, renderMjml, validateMjml } from './mjml.js';

const SERVER_NAME = 'mjml-server';
const MJML_CONTENT_TYPES = [
  'text/plain',
  'text/mjml',
  'text/x-mjml',
  'application/mjml',
  'text/html',
  'text/xml',
  'application/xml',
];

const BOOLEAN_OPTIONS = ['minify', 'beautify', 'keepComments'];
const TRUTHY = /^(1|true|yes|on)$/i;
const FALSY = /^(0|false|no|off)$/i;

/** Options may also arrive as query parameters, which are always strings. */
function optionsFromQuery(query = {}) {
  const options = {};

  if (query.validationLevel !== undefined) options.validationLevel = query.validationLevel;

  for (const key of BOOLEAN_OPTIONS) {
    const value = query[key];
    if (value === undefined) continue;
    if (TRUTHY.test(value)) options[key] = true;
    else if (FALSY.test(value)) options[key] = false;
    else throw new MjmlInputError(`Query parameter "${key}" must be a boolean`);
  }

  return options;
}

/** Accepts both a raw MJML body and a JSON envelope. */
function readInput(request) {
  const query = optionsFromQuery(request.query);

  if (typeof request.body === 'string') {
    return { source: request.body, overrides: query };
  }

  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
    const { mjml, template, content, config, options } = request.body;
    const source = mjml ?? template ?? content;
    if (typeof source !== 'string') {
      throw new MjmlInputError('The JSON body needs an "mjml" property containing the template');
    }
    return { source, overrides: { ...(config ?? options ?? {}), ...query } };
  }

  throw new MjmlInputError('No MJML given');
}

function wantsJson(request, config) {
  const format = request.query?.format;
  if (format === 'json') return true;
  if (format === 'html') return false;

  const accept = request.headers.accept ?? '';
  if (accept.includes('application/json')) return true;
  if (accept.includes('text/html')) return false;

  return config.response.format === 'json';
}

export function buildApp(config) {
  const app = Fastify({
    logger: { level: config.server.logLevel },
    logController: new LogController({
      disableRequestLogging: !config.server.requestLogging,
    }),
    trustProxy: config.server.trustProxy,
    bodyLimit: config.server.bodyLimit,
  });

  app.addContentTypeParser(MJML_CONTENT_TYPES, { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  );

  if (config.cors.origin) {
    app.register(cors, {
      origin: config.cors.origin === '*' ? true : config.cors.origin.split(',').map((o) => o.trim()),
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
      credentials: config.cors.origin !== '*',
    });
  }

  const publicRoutes = new Set(config.auth.protectHealth ? [] : ['/health']);
  const basicAuth = createBasicAuthHook({ ...config.auth, publicRoutes });
  if (basicAuth) app.addHook('onRequest', basicAuth);

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/version', async () => ({
    mjml: mjmlVersion,
    server: SERVER_NAME,
    node: process.versions.node,
  }));

  const render = async (request, reply) => {
    const { source, overrides } = readInput(request);
    const { html, errors } = await renderMjml(source, config, overrides);

    if (wantsJson(request, config)) {
      return { html, errors, mjml: mjmlVersion };
    }

    return reply
      .type(config.response.contentType)
      .header('X-MJML-Errors', String(errors.length))
      .send(html);
  };

  // "/" keeps this image a drop-in replacement for other mjml-server images.
  app.post('/', render);
  app.post('/render', render);

  app.post('/validate', async (request) => {
    const { source, overrides } = readInput(request);
    const { valid, errors, validationLevel } = await validateMjml(source, config, overrides);
    return { valid, errors, validationLevel, mjml: mjmlVersion };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MjmlInputError) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: error.message,
        errors: error.errors,
      });
    }

    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        message: error.message,
      });
    }

    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Rendering failed',
    });
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `No route for ${request.method} ${request.url}`,
      routes: ['POST /render', 'POST /validate', 'GET /version', 'GET /health'],
    }),
  );

  return app;
}
