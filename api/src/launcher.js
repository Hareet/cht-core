const logger = require('./logger');

process
  .on('unhandledRejection', reason => {
    logger.error('UNHANDLED REJECTION!');
    logger.error('  Reason: %o', reason);
  })
  .on('uncaughtException', err => {
    logger.error('UNCAUGHT EXCEPTION!');
    logger.error('  Error: %o', err);
    process.exit(1);
  });

const launchAPI = async () => {

  const app = require('./routing');

  const serverUtils = require('./server-utils');
  const apiPort = process.env.API_PORT || 5988;
  const config = require('./config');

  logger.info('Loading configuration…');
  await config.load();
  await config.addUserRolesToDb();
  logger.info('Configuration loaded successfully');
  await config.listen();

  // Define error-handling middleware last.
  // http://expressjs.com/guide/error-handling.html
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      // If we've already started a response (eg streaming), pass on to express to abort it
      // rather than attempt to resend headers for a 5xx response
      return next(err);
    }
    serverUtils.serverError(err, req, res);
  });

  app.listen(apiPort, () => {
    logger.info('Medic API listening on port ' + apiPort);
  });

};

module.exports = launchAPI;
