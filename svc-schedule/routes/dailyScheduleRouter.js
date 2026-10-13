const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/DailyScheduleController');

// Endpoints usados pelo frontend atual
router.post('/gerarEscalaPeriodo', ctrl.gerarEscalaPeriodo);
router.post('/buscaTabelaPeriodo', ctrl.buscaTabelaPeriodo);
router.post('/buscarEscalaPeriodo', ctrl.buscarEscalaPeriodo);
router.post('/gerarRelatorioCSV', ctrl.gerarRelatorioCSV);

// Endpoints de edição de dia
router.put('/:id', ctrl.atualizarEscala);
router.patch('/:ano/:mes/:dia/absence', ctrl.marcarAusencia);
router.patch('/:ano/:mes/:dia/substitutions', ctrl.atualizarSubstituicoes);
router.post('/:ano/:mes/:dia/overnight', ctrl.registrarOvernight);
router.get('/:ano/:mes/:dia/suggest-overnight', ctrl.sugerirOvernight);

module.exports = router;