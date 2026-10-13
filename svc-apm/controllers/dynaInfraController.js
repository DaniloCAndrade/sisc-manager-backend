/**
 * dynaInfraController.js
 * Métricas de infraestrutura.
 *
 * Endpoints:
 *   dynaInfraHostAvailability      → Disponibilidade de hosts (top 20)
 *   dynaInfraSyntheticAvailability → Disponibilidade de monitores sintéticos (top 20)
 */

const { getTenantById } = require('../services/platformControlClient');
const { createDynaClient } = require('./dynaHelpers');

// ─── Helper local ─────────────────────────────────────────────────────────────

async function findTenantOrFail(id, res) {
  const tenant = await getTenantById(id);
  if (!tenant) {
    res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    return null;
  }
  return tenant;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * Disponibilidade média dos hosts no período.
 * Retorna os top 20 em ordem decrescente de disponibilidade.
 */
const dynaInfraHostAvailability = async (req, res) => {
  try {
    const { id, from, to } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);

    const params = {
      metricSelector: 'builtin:host.availability:splitBy():avg:sort(value(avg,descending)):limit(20)',
      from: from || 'now-5m',
      resolution: '5m',
    };
    if (from && to) params.to = to;

    const { data } = await client.get('/api/v2/metrics/query', { params });
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Disponibilidade dos monitores sintéticos (browser) por localização.
 * Retorna os top 20 em ordem decrescente.
 */
const dynaInfraSyntheticAvailability = async (req, res) => {
  try {
    const { id, from, to } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);

    const params = {
      metricSelector:
        'builtin:synthetic.browser.availability.location.total:' +
        'splitBy():sort(value(auto,descending)):limit(20)',
      from: from || 'now-2h',
    };
    if (from && to) params.to = to;

    const { data } = await client.get('/api/v2/metrics/query', { params });
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  dynaInfraHostAvailability,
  dynaInfraSyntheticAvailability,
};