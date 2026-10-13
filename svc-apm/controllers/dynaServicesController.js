/**
 * dynaServicesController.js
 * Métricas de serviços e comportamento do usuário por dimensão técnica.
 *
 * Endpoints:
 *   dynaActionRegion   → Ações agrupadas por região do Brasil (ex-dynaActionTenant)
 *   dynaBrowserFamily  → Ações por família de browser (top 5)
 *   dynaActionOs       → Ações por sistema operacional
 */

const { getTenantById } = require('../services/platformControlClient');
const { buildUsqlAppCondition, buildServiceTagFilterExpression, createDynaClient } = require('./dynaHelpers');

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
 * Total de Requisições
 */
const dynaRequestCount = async (req, res) => {
  try {
    const { id, from, to, tagKey, tagValue } = req.query;

    const dynaTenants = await getTenantById(id);
    if (!dynaTenants) {
      return res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    }

    const client = createDynaClient(dynaTenants);
    const tagExpr = buildServiceTagFilterExpression(tagKey, tagValue);

    const metricSelector = tagExpr
      ? `builtin:service.requestCount.total:filter(and(or(in("dt.entity.service",entitySelector("type(service),${tagExpr}"))))):splitBy():sum`
      : 'builtin:service.requestCount.total:splitBy():sum';

    const params = { metricSelector, from: from || 'now-2h' };
    if (from && to) params.to = to;

    const { data } = await client.get('/api/v2/metrics/query', { params });
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Ações agrupadas por região brasileira.
 * Retorna top 3 + "Outros" para facilitar visualização em gráficos.
 */
const dynaActionRegion = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const appCond = buildUsqlAppCondition(apps);
    const whereParts = [];

    if (appCond) whereParts.push(appCond);
    whereParts.push('usersession.country = "Brazil"');

    const whereClause = whereParts.length
      ? 'WHERE ' + whereParts.join(' AND ') + ' '
      : '';

    const usql =
      'SELECT usersession.region, count(*) ' +
      'FROM useraction ' +
      whereClause +
      'GROUP BY usersession.region';

    const params = { query: usql };
    if (from) params.startTimestamp = from;
    if (to) params.endTimestamp = to;

    const { data } = await client.get(
      '/api/v1/userSessionQueryLanguage/table',
      { params },
    );

    const rows = (data.values || [])
      .map((row) => ({
        id: row[0] || 'Desconhecido',
        name: row[0] || 'Desconhecido',
        value: row[1] || 0,
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);

    const TOP_N = 3;
    const top = rows.slice(0, TOP_N);
    const othersTotal = rows.slice(TOP_N).reduce((acc, r) => acc + r.value, 0);

    if (othersTotal > 0) {
      top.push({ id: 'OTHERS', name: 'Outros', value: othersTotal });
    }

    res.json(top);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Ações de usuários reais agrupadas por família de browser.
 * Retorna top 5 + "Other".
 */
const dynaBrowserFamily = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const appCond = buildUsqlAppCondition(apps);
    const whereClause = appCond ? `WHERE ${appCond} ` : '';

    const usql =
      'SELECT usersession.browserFamily, count(*) ' +
      'FROM useraction ' +
      whereClause +
      'AND usersession.userType = "REAL_USER" ' +
      'GROUP BY usersession.browserFamily';

    const params = { query: usql };
    if (from) params.startTimestamp = from;
    if (to) params.endTimestamp = to;

    const { data } = await client.get(
      '/api/v1/userSessionQueryLanguage/table',
      { params },
    );

    const rows = (data.values || [])
      .map((row) => ({ family: row[0] || 'Unknown', count: row[1] || 0 }))
      .sort((a, b) => b.count - a.count);

    const total = rows.reduce((acc, r) => acc + r.count, 0);
    const TOP_N = 5;
    const top = rows.slice(0, TOP_N);
    const others = total - top.reduce((acc, r) => acc + r.count, 0);

    if (others > 0) top.push({ family: 'Other', count: others });

    res.json({ total, rows: top });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Ações de usuários reais agrupadas por sistema operacional.
 */
const dynaActionOs = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const appCond = buildUsqlAppCondition(apps);
    const whereClause = appCond ? `WHERE ${appCond} ` : '';

    const usql =
      'SELECT usersession.osFamily, count(*) ' +
      'FROM useraction ' +
      whereClause +
      'AND usersession.userType = "REAL_USER" ' +
      'GROUP BY usersession.osFamily';

    const params = { query: usql };
    if (from) params.startTimestamp = from;
    if (to) params.endTimestamp = to;

    const { data } = await client.get(
      '/api/v1/userSessionQueryLanguage/table',
      { params },
    );

    const rows = (data.values || []).map((row) => ({
      family: row[0] || 'Desconhecido',
      count: row[1] || 0,
    }));

    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  dynaRequestCount,
  dynaActionRegion,
  dynaBrowserFamily,
  dynaActionOs,
};