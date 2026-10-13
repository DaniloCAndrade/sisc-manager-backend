const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/collaboratorController');

router.post('/', ctrl.criarCollaborator);
router.get('/', ctrl.listarCollaborator);
router.get('/ativo', ctrl.listarCollaboratorAtivo);
router.put('/:id', ctrl.atualizarCollaborator);
router.delete('/:id', ctrl.deletarCollaborator);

module.exports = router;