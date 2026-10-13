const express = require('express');
const DynatraceTenants = require('../models/DynatraceTenants');
const {
  criarDynaTenants,
  listarDynaTenants,
  listarTenantsSimples,
  buscarDynaTenants,
  atualizarDynaTenants,
  deletarDynaTenants,
  buscarFrontends,
  buscarTags,
} = require('../controllers/dynatraceTenantsController');

const router = express.Router();

// ── CRUD ──────────────────────────────────────────────────────────
router.get('/', listarDynaTenants);
router.get('/simples', listarTenantsSimples);
router.post('/', criarDynaTenants);

// Rotas específicas ANTES do /:id para evitar conflito
router.get('/frontends', buscarFrontends);   // GET /api/dynaTenant/frontends?id=<_id>
router.get('/tags', buscarTags);        // GET /api/dynaTenant/tags?id=<_id>&from=&to=

// PATCH /api/dynaTenant/:id/baseUrl — atualização cirúrgica (usado pelo svc-inventory)
router.patch('/:id/baseUrl', async (req, res) => {
  const { baseUrl } = req.body;
  if (!baseUrl) return res.status(400).json({ success: false, message: 'baseUrl é obrigatório.' });
  try {
    await DynatraceTenants.findByIdAndUpdate(req.params.id, { baseUrl });
    if (typeof req.app.locals.reloadTenants === 'function') await req.app.locals.reloadTenants();
    return res.json({ success: true });
  } catch (err) {
    console.error('[dynaTenant PATCH baseUrl]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id', buscarDynaTenants);
router.put('/:id', atualizarDynaTenants);
router.delete('/:id', deletarDynaTenants);

module.exports = router;