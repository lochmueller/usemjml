import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { mjmlVersion } from './mjml.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Invalid configuration: ${error.message}`);
  process.exit(78); // EX_CONFIG
}

const app = buildApp(config);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

try {
  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(
    {
      mjml: mjmlVersion,
      basicAuth: config.auth.users.size > 0,
      validationLevel: config.mjml.validationLevel,
      includes: config.mjml.includes,
    },
    'mjml-server ready',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
