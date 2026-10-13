const express = require('express');
const axios = require('axios');
const router = express.Router();

const { getTenantById } = require('../services/platformControlClient');

// ======================================================
// Helpers
// ======================================================

function parseAppsParam(appsParam) {
  if (!appsParam) return [];
  return String(appsParam)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildUsqlAppCondition(appsParam) {
  const appIds = parseAppsParam(appsParam);
  if (!appIds.length) return '';
  const values = appIds.map((id) => `"${id}"`).join(',');
  return `useraction.internalApplicationId IN (${values})`;
}

// USQL exige timestamps em ms — converte relative time (now-Xh, now-Xd) se necessário
function toTimestampMs(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^now-(\d+)(m|h|d)$/i);
  if (!match) return undefined;
  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === 'm' ? amount * 60000
    : unit === 'h' ? amount * 3600000
      : amount * 86400000;
  return Date.now() - ms;
}

// ======================================================
// Cálculo canônico de APDEX
// ======================================================

function computeApdexByPage(rows) {
  const map = {};

  for (const row of rows) {
    const page = row[0];
    const category = row[1];
    const count = row[2] || 0;

    if (!map[page]) {
      map[page] = { SATISFIED: 0, TOLERATING: 0, FRUSTRATED: 0, TOTAL: 0 };
    }

    if (map[page][category] !== undefined) {
      map[page][category] += count;
    }
    map[page].TOTAL += count;
  }

  return Object.entries(map).map(([page, v]) => {
    const apdex = v.TOTAL > 0
      ? (v.SATISFIED + v.TOLERATING * 0.5) / v.TOTAL
      : null;

    const category =
      apdex === null ? 'N/A'
        : apdex < 0.5 ? 'Unacceptable'
          : apdex < 0.7 ? 'Poor'
            : 'Fair';

    return {
      page,
      apdex: apdex !== null ? Number(apdex.toFixed(2)) : null,
      category,
      total: v.TOTAL,
      satisfied: v.SATISFIED,
      tolerating: v.TOLERATING,
      frustrated: v.FRUSTRATED,
    };
  });
}

// ======================================================
// GET /api/apdex-analyze/top-pages?id=<tenantId>&from=&to=&apps=
// ======================================================

router.get('/top-pages', async (req, res) => {
  try {
    const { id, from, to, apps } = req.query;

    if (!id) {
      return res.status(400).json({ error: 'Query param "id" (tenantId) é obrigatório.' });
    }

    const tenant = await getTenantById(id);
    if (!tenant) {
      return res.status(404).json({ error: `Tenant não encontrado: ${id}` });
    }

    const client = axios.create({
      baseURL: tenant.baseUrl,
      headers: { Authorization: `Api-Token ${tenant.apiToken}` },
    });

    const appCond = buildUsqlAppCondition(apps);
    const whereApp = appCond ? `AND ${appCond}` : '';

    const usql =
      'SELECT useraction.name, useraction.apdexCategory, COUNT(*) ' +
      'FROM usersession ' +
      'WHERE userType = "REAL_USER" ' +
      whereApp + ' ' +
      'GROUP BY useraction.name, useraction.apdexCategory';

    const params = { query: usql };
    const startMs = toTimestampMs(from);
    const endMs = toTimestampMs(to);
    if (startMs) params.startTimestamp = startMs;
    if (endMs) params.endTimestamp = endMs;

    console.log('[apdex-analyze/top-pages] USQL:', usql);
    console.log('[apdex-analyze/top-pages] Params:', params);

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

  } catch (err) {
    console.error('[apdex-analyze/top-pages] Erro:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao calcular APDEX por página (RUM Classic)' });
  }
});

module.exports = router;