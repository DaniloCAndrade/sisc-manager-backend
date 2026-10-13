const express = require('express');
const router = express.Router();
const {
  dynaRequestCount,
  dynaActionRegion,
  dynaBrowserFamily,
  dynaActionOs,
} = require('../controllers/dynaServicesController');

// GET /api/services/request-count?id=<tenantId>&from=&to=&tagKey=&tagValue=
router.get('/request-count', dynaRequestCount);

// GET /api/services/action-geolocation?id=<tenantId>&from=&to=&apps=
router.get('/action-geolocation', dynaActionRegion);

// GET /api/services/browser-family?id=<tenantId>&from=&to=&apps=
router.get('/browser-family', dynaBrowserFamily);

// GET /api/services/action-os?id=<tenantId>&from=&to=&apps=
router.get('/action-os', dynaActionOs);

module.exports = router;