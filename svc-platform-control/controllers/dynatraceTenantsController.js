/**
 * dynatraceTenantsController.js
 * CRUD de tenants Dynatrace + endpoints auxiliares de configuração:
 *   - buscarFrontends  → lista web applications do tenant
 *   - buscarTags       → lista tags de serviços do tenant
 */

const DynatraceTenants = require('../models/DynatraceTenants');
const { buildServiceTagFilterExpression, createDynaClient } = require('./dynaHelpers');

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const criarDynaTenants = async (req, res) => {
  try {
    const dynatraceTenants = new DynatraceTenants(req.body);
    await dynatraceTenants.save();

    if (typeof req.app.locals.reloadTenants === 'function') {
      await req.app.locals.reloadTenants();
    }

    res.status(201).json({
      success: true,
      data: dynatraceTenants,
      message: 'Dynatrace Tenants criado com sucesso',
    });
  } catch (error) {
    console.error('[criarDynaTenants]', error.message);
    res.status(400).json({ success: false, message: error.message });
  }
};

const listarDynaTenants = async (req, res) => {
  try {
    const dynatraceTenants = await DynatraceTenants.find();
    res.json({ success: true, data: dynatraceTenants });
  } catch (error) {
    console.error('[listarDynaTenants]', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

const listarTenantsSimples = async (req, res) => {
  try {
    const tenants = await DynatraceTenants
      .find()
      .select('_id nome tenantId')
      .sort({ nome: 1 });
    res.json({ success: true, data: tenants });
  } catch (error) {
    console.error('[listarTenantsSimples]', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

const buscarDynaTenants = async (req, res) => {
  try {
    const dynaTenants = await DynatraceTenants.findById(req.params.id);
    if (!dynaTenants) {
      return res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    }
    res.json({ success: true, data: dynaTenants });
  } catch (error) {
    console.error('[buscarDynaTenants]', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

const atualizarDynaTenants = async (req, res) => {
  try {
    const dynaTenants = await DynatraceTenants.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true },
    );
    if (!dynaTenants) {
      return res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    }

    if (typeof req.app.locals.reloadTenants === 'function') {
      await req.app.locals.reloadTenants();
    }

    res.json({ success: true, data: dynaTenants, message: 'dynaTenants atualizado com sucesso' });
  } catch (error) {
    console.error('[atualizarDynaTenants]', error.message);
    res.status(400).json({ success: false, message: error.message });
  }
};

const deletarDynaTenants = async (req, res) => {
  try {
    const dynaTenants = await DynatraceTenants.findByIdAndDelete(req.params.id);
    if (!dynaTenants) {
      return res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    }

    if (typeof req.app.locals.reloadTenants === 'function') {
      await req.app.locals.reloadTenants();
    }

    res.json({ success: true, message: 'dynaTenants deletado com sucesso' });
  } catch (error) {
    console.error('[deletarDynaTenants]', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Configuração / discovery ─────────────────────────────────────────────────

/** Lista as web applications (frontends) cadastradas no tenant */
const buscarFrontends = async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Query param "id" é obrigatório.' });
    }

    const dynaTenants = await DynatraceTenants.findById(id);
    if (!dynaTenants) {
      return res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    }

    const client = createDynaClient(dynaTenants);
    const { data } = await client.get('/api/config/v1/applications/web', {
      headers: { Accept: 'application/json; charset=utf-8' },
    });

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.values)
        ? data.values
        : [];

    const dataResp = list.map((app) => ({ id: app.id, name: app.name }));

    res.json({ success: true, data: dataResp });
  } catch (error) {
    console.error('[buscarFrontends]', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Lista as tags de serviços do tenant */
const buscarTags = async (req, res) => {
  try {
    const { id, from, to } = req.query;

    const dynaTenants = await DynatraceTenants.findById(id);
    if (!dynaTenants) {
      return res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    }

    const client = createDynaClient(dynaTenants);

    const params = { entitySelector: 'type("SERVICE")' };
    if (from) params.from = from;
    if (to) params.to = to;

    const dtResp = await client.get('/api/v2/tags', { params });
    const tags = dtResp.data?.tags ?? [];

    const tagKeysSet = new Set();
    const tagValuesByKey = {};

    for (const t of tags) {
      const { key, value } = t;
      if (!key) continue;

      tagKeysSet.add(key);

      if (value) {
        if (!tagValuesByKey[key]) tagValuesByKey[key] = new Set();
        tagValuesByKey[key].add(value);
      }
    }

    const normalizedTagValuesByKey = Object.fromEntries(
      Object.entries(tagValuesByKey).map(([k, set]) => [k, Array.from(set)]),
    );

    res.json({
      tagKeys: Array.from(tagKeysSet),
      tagValuesByKey: normalizedTagValuesByKey,
    });
  } catch (error) {
    console.error('[buscarTags]', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  criarDynaTenants,
  listarDynaTenants,
  listarTenantsSimples,
  buscarDynaTenants,
  atualizarDynaTenants,
  deletarDynaTenants,
  buscarFrontends,
  buscarTags,
};