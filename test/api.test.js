import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const TEMPLATE =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>';
const BROKEN = '<mjml><mj-body><mj-text>Hello</mj-text></mj-body></mjml>';

function start(env = {}) {
  return buildApp(loadConfig({ LOG_LEVEL: 'silent', ...env }));
}

describe('open server', () => {
  let app;
  before(async () => {
    app = start();
    await app.ready();
  });
  after(() => app.close());

  it('renders a raw MJML body to HTML', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render',
      headers: { 'content-type': 'text/plain' },
      payload: TEMPLATE,
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.equal(response.headers['x-mjml-errors'], '0');
    assert.match(response.body, /<!doctype html>/i);
    assert.match(response.body, /Hello/);
  });

  it('renders a JSON envelope on / for drop-in compatibility', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { mjml: TEMPLATE, config: { beautify: true } },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Hello/);
  });

  it('answers with JSON when asked to', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render?format=json',
      payload: { mjml: TEMPLATE },
    });

    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.errors, []);
    assert.match(body.html, /Hello/);
    assert.match(body.mjml, /^\d+\.\d+\.\d+/);
  });

  it('reports validation errors without failing in soft mode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render',
      headers: { accept: 'application/json' },
      payload: { mjml: BROKEN },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().errors.length, 1);
    assert.match(response.json().errors[0].message, /mj-text cannot be used inside mj-body/);
  });

  it('fails with 422 in strict mode and hides server paths', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render?validationLevel=strict',
      payload: { mjml: BROKEN },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().errors[0].tagName, 'mj-text');
    assert.doesNotMatch(response.body, /\/Users|\/app/);
  });

  it('validates', async () => {
    const good = await app.inject({ method: 'POST', url: '/validate', payload: { mjml: TEMPLATE } });
    assert.equal(good.statusCode, 200);
    assert.deepEqual(good.json().valid, true);

    const bad = await app.inject({
      method: 'POST',
      url: '/validate',
      headers: { 'content-type': 'text/plain' },
      payload: BROKEN,
    });
    assert.equal(bad.statusCode, 200);
    assert.equal(bad.json().valid, false);
    assert.equal(bad.json().errors[0].line, 1);
    assert.equal(bad.json().validationLevel, 'soft');
  });

  it('takes a validation level per request', async () => {
    const strict = await app.inject({
      method: 'POST',
      url: '/validate?validationLevel=strict',
      payload: { mjml: BROKEN },
    });
    assert.equal(strict.statusCode, 200);
    assert.equal(strict.json().valid, false);
    assert.equal(strict.json().validationLevel, 'strict');
    assert.equal(strict.json().errors[0].tagName, 'mj-text');

    const skipped = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { mjml: BROKEN, config: { validationLevel: 'skip' } },
    });
    assert.equal(skipped.json().valid, true);
    assert.equal(skipped.json().validationLevel, 'skip');
  });

  it('rejects an unknown validation level with 422', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/validate?validationLevel=pedantic',
      payload: { mjml: TEMPLATE },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().message, /validationLevel must be one of/);
  });

  it('reports the mjml version', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().mjml, /^\d+\.\d+\.\d+/);
    assert.equal(response.json().server, 'mjml-server');
  });

  it('is healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  it('rejects an empty body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render',
      headers: { 'content-type': 'text/plain' },
      payload: '',
    });
    assert.equal(response.statusCode, 422);
  });

  it('rejects unknown options', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render',
      payload: { mjml: TEMPLATE, config: { filePath: '/etc' } },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().message, /Unknown option "filePath"/);
  });

  it('ignores mj-include by default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render',
      payload: {
        mjml: '<mjml><mj-body><mj-include path="/etc/passwd" /></mj-body></mjml>',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /root:/);
  });
});

describe('protected server', () => {
  const env = { BASIC_AUTH_USER: 'mjml', BASIC_AUTH_PASSWORD: 's3cret' };
  const header = `Basic ${Buffer.from('mjml:s3cret').toString('base64')}`;
  let app;

  before(async () => {
    app = start(env);
    await app.ready();
  });
  after(() => app.close());

  it('challenges anonymous requests', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' });
    assert.equal(response.statusCode, 401);
    assert.match(response.headers['www-authenticate'], /^Basic realm="mjml-server"/);
  });

  it('rejects wrong credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/version',
      headers: { authorization: `Basic ${Buffer.from('mjml:wrong').toString('base64')}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it('accepts valid credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/render',
      headers: { authorization: header },
      payload: { mjml: TEMPLATE },
    });
    assert.equal(response.statusCode, 200);
  });

  it('leaves /health open by default', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
  });

  it('can protect /health as well', async () => {
    const protectedApp = start({ ...env, BASIC_AUTH_PROTECT_HEALTH: 'true' });
    await protectedApp.ready();
    const response = await protectedApp.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 401);
    await protectedApp.close();
  });

  it('supports multiple accounts', async () => {
    const multi = start({ BASIC_AUTH_USERS: 'alice:one,bob:two:with:colons' });
    await multi.ready();
    for (const pair of ['alice:one', 'bob:two:with:colons']) {
      const response = await multi.inject({
        method: 'GET',
        url: '/version',
        headers: { authorization: `Basic ${Buffer.from(pair).toString('base64')}` },
      });
      assert.equal(response.statusCode, 200, pair);
    }
    await multi.close();
  });
});

describe('configuration', () => {
  it('rejects a half configured account', () => {
    assert.throws(() => loadConfig({ BASIC_AUTH_USER: 'mjml' }), /must both be set/);
  });

  it('rejects an unknown validation level', () => {
    assert.throws(() => loadConfig({ MJML_VALIDATION_LEVEL: 'nope' }), /MJML_VALIDATION_LEVEL/);
  });

  it('keeps validating even when the server default is skip', async () => {
    const app = start({ MJML_VALIDATION_LEVEL: 'skip' });
    await app.ready();

    const rendered = await app.inject({
      method: 'POST',
      url: '/render?format=json',
      payload: { mjml: BROKEN },
    });
    assert.deepEqual(rendered.json().errors, []);

    const validated = await app.inject({ method: 'POST', url: '/validate', payload: { mjml: BROKEN } });
    assert.equal(validated.json().valid, false);
    assert.equal(validated.json().validationLevel, 'soft');

    await app.close();
  });

  it('applies MJML defaults from the environment', async () => {
    const plain = start();
    const minifying = start({ MJML_MINIFY: 'true', RESPONSE_FORMAT: 'json' });
    await Promise.all([plain.ready(), minifying.ready()]);

    const reference = await plain.inject({
      method: 'POST',
      url: '/render?format=json',
      payload: { mjml: TEMPLATE },
    });
    const response = await minifying.inject({
      method: 'POST',
      url: '/render',
      payload: { mjml: TEMPLATE },
    });

    assert.match(response.headers['content-type'], /application\/json/);
    assert.ok(response.json().html.length < reference.json().html.length);
    await Promise.all([plain.close(), minifying.close()]);
  });
});
