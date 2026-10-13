/**
 * dynaInventoryRoutes.js
 */
console.log('[DEBUG] dynaInventoryRoutes carregado');
const express = require('express');
const router = express.Router();
const controller = require('../controllers/dynaInventoryController');

// Valida conectividade e corrige URL automaticamente
router.post('/:tenantId/validate', controller.validateTenant);

// Executa o inventário completo (?force=true ignora cache) — ASSÍNCRONO: responde 202 na hora
router.post('/:tenantId/run', controller.runInventory);

// Acompanha o progresso da coleta assíncrona disparada em /run
router.get('/:tenantId/status', controller.getInventoryStatus);

// Exportações específicas ANTES do /:tenantId/export genérico
router.get('/:tenantId/export/dashboards', controller.exportDashboards);
router.get('/:tenantId/export/applications', controller.exportApplications);
router.get('/:tenantId/export/infrastructure', controller.exportInfrastructure);

// Exporta o inventário geral como arquivo Word (.docx)
router.get('/:tenantId/export', controller.exportInventory);

// Retorna o último resultado em cache (sem re-executar)
router.get('/:tenantId', controller.getLastInventory);

// Invalida o cache de um tenant específico
router.delete('/:tenantId/cache', controller.clearCache);

module.exports = router;