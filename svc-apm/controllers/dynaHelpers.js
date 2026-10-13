/**
 * dynaHelpers.js
 * Funções utilitárias compartilhadas entre os controllers Dynatrace.
 */

// ─── App / Entity helpers ─────────────────────────────────────────────────────

function parseAppsParam(appsParam) {
  if (!appsParam) return [];
  return String(appsParam)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Monta entitySelector para filtrar APPLICATION entities pela API v2 */
function buildEntitySelectorForApps(appsParam) {
  const appIds = parseAppsParam(appsParam);
  if (!appIds.length) return '';
  const ids = appIds.map((id) => `"${id}"`).join(',');
  return `type("APPLICATION"),entityId(${ids})`;
}

/** Monta cláusula WHERE para USQL filtrando por internalApplicationId */
function buildUsqlAppCondition(appsParam) {
  const appIds = parseAppsParam(appsParam);
  if (!appIds.length) return '';
  const values = appIds.map((id) => `"${id}"`).join(',');
  return `useraction.internalApplicationId IN (${values})`;
}

// ─── Tag / Service helpers ────────────────────────────────────────────────────

/**
 * Monta a expressão de filtro por tag para entitySelector de serviços.
 * Exemplos:
 *   key="SISTEMA", value="PND"  → tag(SISTEMA:PND)
 *   key="enemprd", value=""     → tag(enemprd)
 *   key="" ou key="all"         → '' (sem filtro)
 */
function buildServiceTagFilterExpression(tagKeyRaw, tagValueRaw) {
  const key    = (tagKeyRaw  ?? '').toString().trim();
  const rawVal = (tagValueRaw ?? '').toString().trim();

  if (!key || key.toLowerCase() === 'all') return '';

  if (!rawVal || rawVal.toLowerCase() === 'all') return `tag(${key})`;

  return `tag(${key}:${rawVal})`;
}

// ─── Apdex helpers ────────────────────────────────────────────────────────────

/**
 * Calcula o Apdex real por página a partir de linhas USQL
 * [ pageName, apdexCategory, count ]
 */
function computeApdexByPage(rows) {
  const map = {};

  for (const row of rows) {
    const page     = row[0];
    const category = row[1];
    const count    = row[2] || 0;

    if (!map[page]) {
      map[page] = { SATISFIED: 0, TOLERATING: 0, FRUSTRATED: 0, TOTAL: 0 };
    }

    if (map[page][category] !== undefined) {
      map[page][category] += count;
    }
    map[page].TOTAL += count;
  }

  return Object.entries(map).map(([page, v]) => {
    const apdex =
      v.TOTAL > 0 ? (v.SATISFIED + v.TOLERATING * 0.5) / v.TOTAL : null;

    const category =
      apdex === null  ? 'N/A'
      : apdex < 0.5   ? 'Unacceptable'
      : apdex < 0.7   ? 'Poor'
      : 'Fair';

    return {
      page,
      apdex:      apdex !== null ? Number(apdex.toFixed(2)) : null,
      category,
      total:      v.TOTAL,
      satisfied:  v.SATISFIED,
      tolerating: v.TOLERATING,
      frustrated: v.FRUSTRATED,
    };
  });
}

// ─── Axios client factory ─────────────────────────────────────────────────────

const axios = require('axios');

/** Cria um cliente axios pré-configurado para um tenant Dynatrace */
function createDynaClient(tenant) {
  return axios.create({
    baseURL: tenant.baseUrl,
    headers: { Authorization: `Api-Token ${tenant.apiToken}` },
  });
}

module.exports = {
  parseAppsParam,
  buildEntitySelectorForApps,
  buildUsqlAppCondition,
  buildServiceTagFilterExpression,
  computeApdexByPage,
  createDynaClient,
};