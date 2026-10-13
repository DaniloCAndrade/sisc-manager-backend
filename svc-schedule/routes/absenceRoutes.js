const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/AbsenceController');

router.post('/', ctrl.criarAbsence);
router.get('/', ctrl.listarAbsence);
router.get('/ativo', ctrl.listarAbsenceAtivo);
router.put('/:id', ctrl.atualizarAbsence);
router.delete('/:id', ctrl.deletarAbsence);

module.exports = router;