const express = require('express');
const router = express.Router();
const {
  dynaUserApdex,
  dynaUserSessions,
  dynaUserApdexCategory,
  dynaBounceRate,
  dynaRageClicks,
  dynaRageClicksPerPage,
  dynaApdexAnalyzeTopPages,
} = require('../controllers/dynaUserSessionsController');

// GET /api/user/apdex?id=<tenantId>&from=&to=&apps=
router.get('/apdex', dynaUserApdex);

// GET /api/user/sessions?id=<tenantId>&from=&to=&apps=
router.get('/sessions', dynaUserSessions);

// GET /api/user/apdex-category?id=<tenantId>&from=&to=&apps=
router.get('/apdex-category', dynaUserApdexCategory);

// GET /api/user/bounce-rate?id=<tenantId>&from=&to=&apps=
router.get('/bounce-rate', dynaBounceRate);

// GET /api/user/rage-clicks?id=<tenantId>&from=&to=&apps=
router.get('/rage-clicks', dynaRageClicks);

// GET /api/user/rage-clicks-per-page?id=<tenantId>&from=&to=&apps=
router.get('/rage-clicks-per-page', dynaRageClicksPerPage);

// GET /api/user/user-apdex?id=<tenantId>&from=&to=&apps=
router.get('/user-apdex', dynaApdexAnalyzeTopPages);

module.exports = router;