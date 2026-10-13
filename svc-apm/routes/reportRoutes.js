const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/reportController');

// GET /api/report/portal?id=<tenantId>&from=2026-05-01&to=2026-05-31
// GET /api/report/app?id=<tenantId>&from=2026-05-01&to=2026-05-31
// GET /api/report/getran?id=<tenantId>&from=2026-05-01&to=2026-05-31
router.get('/:reportKey', ctrl.gerarRelatorioAPM);

module.exports = router;