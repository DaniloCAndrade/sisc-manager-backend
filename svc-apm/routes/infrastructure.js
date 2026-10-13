const express = require('express');
const router = express.Router();
const {
  dynaInfraHostAvailability,
  dynaInfraSyntheticAvailability,
} = require('../controllers/dynaInfraController');

// GET /api/infra/host-availability?id=<tenantId>&from=&to=
router.get('/host-availability', dynaInfraHostAvailability);

// GET /api/infra/synthetic-availability?id=<tenantId>&from=&to=
router.get('/synthetic-availability', dynaInfraSyntheticAvailability);

module.exports = router;