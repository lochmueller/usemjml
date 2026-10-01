/**
 * Thin wrapper around the MJML engine.
 *
 * We depend on mjml-core / mjml-preset-core / mjml-validator instead of the
 * "mjml" umbrella package: that package only adds this exact wiring plus the
 * CLI (chokidar, yargs, glob …), which a server never needs. The wiring below
 * mirrors mjml/lib/index.js one to one.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { default: mjml2html, assignComponents, components } = require('mjml-core');
const { assignDependencies, dependencies } = require('mjml-validator');
const presetCore = require('mjml-preset-core').default ?? require('mjml-preset-core');

assignComponents(components, presetCore.components);
assignDependencies(dependencies, presetCore.dependencies);

export const mjmlVersion = require('mjml-core/package.json').version;

/** Options a client may override per request — everything else is server side. */
const CLIENT_OPTIONS = new Set([
  'validationLevel',
  'minify',
  'beautify',
  'keepComments',
  'fonts',
  'minifyOptions',
  'juicePreserveTags',
]);

const VALIDATION_LEVELS = ['skip', 'soft', 'strict'];

/**
 * /validate answers with its own default instead of MJML_VALIDATION_LEVEL:
 * validating with the server default "skip" would be pointless, and "soft" is
 * the most thorough level because it also renders the template.
 */
export const DEFAULT_VALIDATION_LEVEL = 'soft';

export class MjmlInputError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'MjmlInputError';
    this.errors = errors;
  }
}

/** Drop the formattedMessage — it contains server side file paths. */
function cleanErrors(errors) {
  return (errors ?? []).map(({ line, message, tagName }) => ({ line, message, tagName }));
}

/** MJML puts absolute paths into its messages; never hand those to a client. */
function cleanMessage(error, errors) {
  if (errors.length > 0) {
    return `MJML validation failed: ${errors.map((entry) => entry.message).join('; ')}`;
  }
  return String(error.message).replaceAll(process.cwd(), '.');
}

export function buildOptions(config, overrides = {}) {
  const options = {
    validationLevel: config.mjml.validationLevel,
    minify: config.mjml.minify,
    beautify: config.mjml.beautify,
    keepComments: config.mjml.keepComments,
    ...(config.mjml.fonts ? { fonts: config.mjml.fonts } : {}),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!CLIENT_OPTIONS.has(key)) {
      throw new MjmlInputError(`Unknown option "${key}"`);
    }
    options[key] = value;
  }

  if (!VALIDATION_LEVELS.includes(options.validationLevel)) {
    throw new MjmlInputError(
      `validationLevel must be one of ${VALIDATION_LEVELS.join(', ')} — got "${options.validationLevel}"`,
    );
  }

  // Never let a request touch the file system: mj-include is opt-in and, when
  // enabled, sandboxed by MJML to the configured include directory.
  options.ignoreIncludes = !config.mjml.includes;
  if (config.mjml.includes) {
    options.filePath = config.mjml.includeDir;
    options.includePath = config.mjml.includeDir;
  }

  return options;
}

function assertSource(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new MjmlInputError('No MJML given');
  }
}

async function run(source, options) {
  const result = await mjml2html(source, options);
  return { html: result.html, errors: cleanErrors(result.errors) };
}

export async function renderMjml(source, config, overrides) {
  assertSource(source);
  const options = buildOptions(config, overrides);

  try {
    return await run(source, options);
  } catch (error) {
    // Strict validation and parser failures both land here.
    const errors = cleanErrors(error.errors);
    throw new MjmlInputError(cleanMessage(error, errors), errors);
  }
}

/**
 * Reports instead of failing: a broken template is a valid answer, so only a
 * broken *request* (no template, unknown option, unknown level) throws.
 *
 * "soft" and "strict" run the same rules and therefore report the same errors;
 * "strict" only makes MJML give up before rendering. "soft" is the default
 * because rendering surfaces failures the validator alone cannot see.
 */
export async function validateMjml(source, config, overrides = {}) {
  assertSource(source);
  const validationLevel = overrides.validationLevel ?? DEFAULT_VALIDATION_LEVEL;
  const options = buildOptions(config, { ...overrides, validationLevel });

  try {
    const { errors } = await run(source, options);
    return { valid: errors.length === 0, errors, validationLevel };
  } catch (error) {
    const errors = cleanErrors(error.errors);
    return {
      valid: false,
      validationLevel,
      errors: errors.length
        ? errors
        : [{ line: null, message: cleanMessage(error, errors), tagName: null }],
    };
  }
}
