const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ExportController');

// GET /api/export/escala?inicio=2026-06-01&fim=2026-06-30
router.get('/escala', ctrl.exportEscala);

// GET /api/export/horas-extras?inicio=2026-06-01&fim=2026-06-30
router.get('/horas-extras', ctrl.exportHorasExtras);

module.exports = router;