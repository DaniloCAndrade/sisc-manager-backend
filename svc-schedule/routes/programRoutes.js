const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ProgramController');

router.post('/', ctrl.criarPrograma);
router.get('/', ctrl.listarProgramas);
router.put('/:programName', ctrl.atualizarPrograma);
router.delete('/:programName', ctrl.deletarPrograma);

module.exports = router;