// api/routes/config.js
const express = require('express');
const axios   = require('axios');

const DynatraceTenants = require('../models/DynatraceTenants');

const router = express.Router();

// Helper: client axios do tenant autenticado via x-tenant-id / ?tenantId
const getApiClient = (req) => req.app.locals.getTenantClient(req);

// ─────────────────────────────────────────────────────────────────
// GET /api/config/tenants
// Lista simplificada de tenants para os selects do frontend.
// Lê direto do MongoDB (não usa mais variável de ambiente).
// ─────────────────────────────────────────────────────────────────
router.get('/tenants', async (req, res) => {
  try {
    const docs = await DynatraceTenants.find({}, 'nome label tenantId baseUrl').lean();
    const list = docs.map((t) => ({
      id:       String(t._id),   // _id do MongoDB — usado como identificador nas rotas
      label:    t.label || t.nome,
      nome:     t.nome,
      tenantId: t.tenantId,
    }));
    return res.json(list);
  } catch (err) {
    console.error('[config/tenants] Erro ao buscar tenants:', err.message);
    return res.status(500).json({ error: 'Falha ao buscar tenants.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/config/frontends?tenantId=<_id>
// Busca as Web Applications do tenant informado via Dynatrace v1.
// ─────────────────────────────────────────────────────────────────
router.get('/frontends', async (req, res) => {
  const { tenantId } = req.query;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId é obrigatório.' });
  }

  try {
    // Busca o tenant no banco pelo _id
    const tenant = await DynatraceTenants.findById(tenantId).lean();

    if (!tenant) {
      return res.status(404).json({ error: `Tenant não encontrado: ${tenantId}` });
    }

    const client = axios.create({
      baseURL: tenant.baseUrl,
      headers: { Authorization: `Api-Token ${tenant.apiToken}` },
    });

    const { data } = await client.get('/api/config/v1/applications/web', {
      headers: { Accept: 'application/json; charset=utf-8' },
    });

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.values)
      ? data.values
      : [];

    return res.json(list.map((app) => ({ id: app.id, name: app.name })));

  } catch (err) {
    console.error('[config/frontends] Erro:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Falha ao buscar aplicações Web do Dynatrace.' });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/config/service-tags?tenantId=<_id>&from=now-30d
// ─────────────────────────────────────────────────────────────────
router.get('/service-tags', async (req, res) => {
  try {
    const client = getApiClient(req);
    const { from } = req.query;

    const { data } = await client.get('/api/v2/tags', {
      params: {
        entitySelector: 'type(service)',
        from: from || 'now-30d',
        pageSize: 500,
      },
    });

    const rawTags = data.tags || [];
    const map     = new Map();

    for (const tag of rawTags) {
      const repr = tag.stringRepresentation;
      if (!repr) continue;
      const [key, value] = repr.split(':');
      if (!key) continue;
      if (!map.has(key)) map.set(key, new Set());
      if (value) map.get(key).add(value);
    }

    const items = Array.from(map.entries()).map(([key, set]) => ({
      key,
      values: Array.from(set).sort(),
    }));

    return res.json({ items });

  } catch (err) {
    console.error('[config/service-tags] Erro:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Falha ao buscar tags de serviços.' });
  }
});

module.exports = router;