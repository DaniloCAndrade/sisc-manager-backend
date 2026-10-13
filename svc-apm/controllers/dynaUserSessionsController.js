/**
 * dynaUserSessionsController.js
 * Métricas de sessões e experiência do usuário final (RUM).
 *
 * Endpoints:
 *   dynaUserApdex            → Apdex agregado (Real users)
 *   dynaUserSessions         → Usuários ativos estimados
 *   dynaUserApdexCategory    → Ações por categoria Apdex
 *   dynaBounceRate           → Sessões com / sem bounce
 *   dynaRageClicks           → Rage clicks por quantidade
 *   dynaRageClicksPerPage    → Rage clicks por página (top 5)
 *   dynaApdexAnalyzeTopPages → Páginas com Apdex ruim (< 0.7)
 */

const { getTenantById } = require('../services/platformControlClient');
const {
  buildEntitySelectorForApps,
  buildUsqlAppCondition,
  computeApdexByPage,
  createDynaClient,
} = require('./dynaHelpers');

// ─── Helpers locais ───────────────────────────────────────────────────────────

async function findTenantOrFail(id, res) {
  const tenant = await getTenantById(id);
  if (!tenant) {
    res.status(404).json({ success: false, message: 'dynaTenants não encontrado' });
    return null;
  }
  return tenant;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

const dynaUserApdex = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const entitySelector = buildEntitySelectorForApps(apps);

    const metricSelector =
      'builtin:apps.web.apdex.userType:' +
      'filter(eq("User type","Real users")):' +
      'splitBy("User type")';

    const params = {
      metricSelector,
      from: from || 'now-2h',
      resolution: 'Inf',
    };
    if (to) params.to = to;
    if (entitySelector) params.entitySelector = entitySelector;

    const { data } = await client.get('/api/v2/metrics/query', { params });

    const series = data?.result?.[0]?.data || [];
    let apdex = null;
    for (const row of series) {
      const v = Array.isArray(row.values) ? row.values[0] : null;
      if (typeof v === 'number') { apdex = v; break; }
    }

    res.json({ apdex });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const dynaUserSessions = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const entitySelector = buildEntitySelectorForApps(apps);

    const metricSelector =
      'builtin:apps.web.activeUsersEst:' +
      'filter(eq("User type","Real users")):' +
      'splitBy()';

    const params = {
      metricSelector,
      from: from || 'now-2h',
      resolution: 'Inf',
    };
    if (from && to) params.to = to;
    if (entitySelector) params.entitySelector = entitySelector;

    const { data } = await client.get('/api/v2/metrics/query', { params });
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const dynaUserApdexCategory = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const entitySelector = buildEntitySelectorForApps(apps);

    const metricSelector =
      'builtin:apps.web.actionCount.category:' +
      'splitBy("Apdex category"):sum:sort(value(sum,descending))';

    const params = { metricSelector, from: from || 'now-2h' };
    if (from && to) params.to = to;
    if (entitySelector) params.entitySelector = entitySelector;

    const { data } = await client.get('/api/v2/metrics/query', { params });
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const dynaBounceRate = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const appCond = buildUsqlAppCondition(apps);
    const whereClause = appCond ? `WHERE ${appCond} ` : '';

    const usql =
      'SELECT bounce, count(*) ' +
      'FROM usersession ' +
      whereClause +
      'AND userType = "REAL_USER" ' +
      'GROUP BY bounce';

    const params = { query: usql };
    if (from) params.startTimestamp = from;
    if (to) params.endTimestamp = to;

    const { data } = await client.get(
      '/api/v1/userSessionQueryLanguage/table',
      { params },
    );

    const rows = (data.values || []).map((row) => {
      const isBounce =
        row[0] === true || row[0] === 'true' || row[0] === 1 || row[0] === '1';
      return {
        label: isBounce ? 'Sessões com bounce' : 'Sessões sem bounce',
        count: row[1] || 0,
      };
    });

    const aggregated = Object.values(
      rows.reduce((acc, r) => {
        if (!acc[r.label]) acc[r.label] = { label: r.label, count: 0 };
        acc[r.label].count += r.count;
        return acc;
      }, {}),
    );

    const total = aggregated.reduce((acc, r) => acc + r.count, 0);
    res.json({ total, rows: aggregated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const dynaRageClicks = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const appCond = buildUsqlAppCondition(apps);
    const whereClause = appCond ? `WHERE ${appCond} ` : '';

    const usql =
      'SELECT numberOfRageClicks, count(*) ' +
      'FROM usersession ' +
      whereClause +
      'AND userType = "REAL_USER" ' +
      'GROUP BY numberOfRageClicks';

    const params = { query: usql };
    if (from) params.startTimestamp = from;
    if (to) params.endTimestamp = to;

    const { data } = await client.get(
      '/api/v1/userSessionQueryLanguage/table',
      { params },
    );

    const rows = (data.values || []).map((row) => {
      const clicks = row[0] ?? 0;
      const count = row[1] || 0;
      const label =
        clicks === 0 ? '0 cliques de raiva'
          : clicks === 1 ? '1 clique de raiva'
            : clicks === 2 ? '2 cliques de raiva'
              : `${clicks} cliques de raiva`;
      return { clicks, label, count };
    });

    rows.sort((a, b) => b.count - a.count);

    const TOP_N = 5;
    const top = rows.slice(0, TOP_N);
    const others = rows.slice(TOP_N);
    const total = rows.reduce((acc, r) => acc + r.count, 0);
    const othersTotal = others.reduce((acc, r) => acc + r.count, 0);

    const finalRows = top.map(({ label, count }) => ({ label, count }));
    if (othersTotal > 0) finalRows.push({ label: 'Outros', count: othersTotal });

    res.json({ total, rows: finalRows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const dynaRageClicksPerPage = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const appCond = buildUsqlAppCondition(apps);
    const whereClause = appCond ? `WHERE ${appCond} ` : '';

    const usql =
      'SELECT useraction.name, count(numberOfRageClicks) ' +
      'FROM usersession ' +
      whereClause +
      'AND userType = "REAL_USER" ' +
      'AND numberOfRageClicks > 0 ' +
      'GROUP BY useraction.name ORDER BY count(numberOfRageClicks) DESC';

    const params = { query: usql };
    if (from) params.startTimestamp = from;
    if (to) params.endTimestamp = to;

    const { data } = await client.get(
      '/api/v1/userSessionQueryLanguage/table',
      { params },
    );

    const rows = (data.values || [])
      .map((row) => ({ label: row[0] ?? 'Sem Nome', count: Number(row[1] ?? 0) }))
      .sort((a, b) => b.count - a.count);

    const TOP_N = 5;
    const top = rows.slice(0, TOP_N);
    const othersTotal = rows.slice(TOP_N).reduce((acc, r) => acc + r.count, 0);
    const total = rows.reduce((acc, r) => acc + r.count, 0);

    const finalRows = [...top];
    if (othersTotal > 0) finalRows.push({ label: 'Outros', count: othersTotal });

    res.json({ total, rows: finalRows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const dynaApdexAnalyzeTopPages = async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    const tenant = await findTenantOrFail(id, res);
    if (!tenant) return;

    const client = createDynaClient(tenant);
    const appCond = buildUsqlAppCondition(apps);
    const whereApp = appCond ? `AND ${appCond} ` : '';

    const usql =
      'SELECT useraction.name, useraction.apdexCategory, COUNT(*) ' +
      'FROM usersession ' +
      'WHERE userType = "REAL_USER" ' +
      whereApp +
      'GROUP BY useraction.name, useraction.apdexCategory';

    const params = { query: usql };
    if (from) params.startTimestamp = from;
    if (to) params.endTimestamp = to;

    const { data } = await client.get(
      '/api/v1/userSessionQueryLanguage/table',
      { params },
    );

    const computed = computeApdexByPage(data.values || []);
    const filtered = computed
      .filter((r) => r.apdex !== null && r.apdex < 0.7)
      .sort((a, b) => b.total - a.total);

    res.json({
      totalPagesAnalyzed: computed.length,
      totalWithBadApdex: filtered.length,
      topPages: filtered.slice(0, 3),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  dynaUserApdex,
  dynaUserSessions,
  dynaUserApdexCategory,
  dynaBounceRate,
  dynaRageClicks,
  dynaRageClicksPerPage,
  dynaApdexAnalyzeTopPages,
};