'use strict';

// Minimal Express server for the /api/v1/purge/request endpoint.
// Can be run standalone or mounted into the main CHT API via require().

const express = require('express');
const apiHandler = require('./api-handler');

const createRouter = () => {
  const router = express.Router();

  router.post('/api/v1/purge/request', express.json(), async (req, res) => {
    try {
      const result = await apiHandler.handlePurgeRequest(req.body);
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error('Purge request error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

// Standalone server mode
const startStandalone = (port = 3100) => {
  const app = express();
  app.use(createRouter());
  return app.listen(port, () => {
    console.log(`Purge API listening on port ${port}`);
  });
};

module.exports = {
  createRouter,
  startStandalone,
};
