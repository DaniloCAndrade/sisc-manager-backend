/**
 * dynaClassicLicenseService.js
 *
 * Coleta de consumo Classic (Host Units, DDU, DEM) — diferente do DPS,
 * usa a API do PRÓPRIO TENANT (Api-Token, mesmo padrão do svc-inventory),
 * não a Account Management API. Sem OAuth, sem Account UUID.
 *
 * Metric IDs confirmados manualmente via curl antes de implementar:
 *   dsfm:billing.hostunit.connected                         → Host Units (snapshot atual)
 *   builtin:billing.ddu.metrics.byEntity                     → DDU por entidade (soma = total)
 *   9 métricas builtin:billing.* → componentes de DEM (ver DEM_COMPONENTS)
 *
 * Tabela de conversão pra DEM (documentação Dynatrace):
 *   Ação sintética (browser)              ×1.0
 *   Requisição sintética (HTTP monitor)   ×0.1
 *   Sessão RUM sem Session Replay         ×0.25
 *   Sessão RUM com Session Replay         ×1.0
 *   Propriedade de sessão/ação            ×0.01
 *   Resultado sintético terceirizado      ×0.1
 */

async function apiFetch(baseUrl, apiToken, path, params = {}) {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), {
        headers: { Authorization: `Api-Token ${apiToken}` },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} em ${path}: ${body}`);
    }

    return res.json();
}

// Soma todos os valores numéricos de um resultado de /metrics/query,
// ignorando nulls — serve tanto pra métricas de contagem (DDU, DEM) quanto
// como base pro "último valor" de métricas snapshot.
function sumMetricResult(json) {
    let total = 0;
    for (const r of json.result || []) {
        for (const d of r.data || []) {
            for (const v of d.values || []) {
                if (typeof v === 'number') total += v;
            }
        }
    }
    return total;
}

// Último valor não-nulo (pra métricas "snapshot atual", tipo Host Units,
// onde somar não faz sentido — queremos o valor mais recente).
function lastMetricValue(json) {
    let last = null;
    for (const r of json.result || []) {
        for (const d of r.data || []) {
            for (const v of d.values || []) {
                if (typeof v === 'number') last = v;
            }
        }
    }
    return last;
}

/** Host Units — snapshot atual (últimas 2h, pega o valor mais recente). */
async function fetchHostUnits(baseUrl, apiToken) {
    const json = await apiFetch(baseUrl, apiToken, '/api/v2/metrics/query', {
        metricSelector: 'dsfm:billing.hostunit.connected',
        from: '-2h',
    });
    return lastMetricValue(json) ?? 0;
}

/** DDU total consumido no período — soma de todas as entidades/timestamps. */
// DDU = soma de 5 categorias (confirmado comparando com o painel nativo do
// Account Management: Metrics + Logs + Events + Serverless + Traces).
// Usar os metric IDs ".total" (agregados) em vez de ".byEntity"/".byDescription"
// — mais leve, já vem somado, não precisa de agregação extra do nosso lado.
const DDU_COMPONENTS = [
    { key: 'metrics', label: 'Metrics', metricId: 'builtin:billing.ddu.metrics.total' },
    { key: 'logs', label: 'Logs', metricId: 'builtin:billing.ddu.log.total' },
    { key: 'events', label: 'Events', metricId: 'builtin:billing.ddu.events.total' },
    { key: 'serverless', label: 'Serverless functions', metricId: 'builtin:billing.ddu.serverless.total' },
    { key: 'traces', label: 'Traces', metricId: 'builtin:billing.ddu.traces.total' },
];

async function fetchDduTotal(baseUrl, apiToken, from = '-30d') {
    let total = 0;
    const breakdown = [];

    for (const comp of DDU_COMPONENTS) {
        try {
            const json = await apiFetch(baseUrl, apiToken, '/api/v2/metrics/query', {
                metricSelector: comp.metricId,
                from,
            });
            const value = sumMetricResult(json);
            total += value;
            breakdown.push({ key: comp.key, label: comp.label, value });
        } catch (err) {
            breakdown.push({ key: comp.key, label: comp.label, error: err.message });
        }
    }

    return { total: Math.round(total * 100) / 100, breakdown };
}

// ── DEM: soma ponderada de 9 componentes (Classic não tem métrica única) ──
const DEM_COMPONENTS = [
    { key: 'synthetic_actions', label: 'Ações sintéticas (browser)', metricId: 'builtin:billing.synthetic.actions', weight: 1.0 },
    { key: 'synthetic_requests', label: 'Requisições sintéticas (HTTP)', metricId: 'builtin:billing.synthetic.requests', weight: 0.1 },
    { key: 'web_sessions', label: 'Sessões RUM web (sem Replay)', metricId: 'builtin:billing.apps.web.sessionsWithoutReplayByApplication:filter(eq(Type,Billed))', weight: 0.25 },
    { key: 'web_sessions_replay', label: 'Sessões RUM web (com Replay)', metricId: 'builtin:billing.apps.web.sessionsWithReplayByApplication:filter(eq(Type,Billed))', weight: 1.0 },
    { key: 'mobile_sessions', label: 'Sessões RUM mobile (sem Replay)', metricId: 'builtin:billing.apps.mobile.sessionsWithoutReplayByApplication:filter(eq(Type,Billed))', weight: 0.25 },
    { key: 'mobile_sessions_replay', label: 'Sessões RUM mobile (com Replay)', metricId: 'builtin:billing.apps.mobile.sessionsWithReplayByApplication:filter(eq(Type,Billed))', weight: 1.0 },
    { key: 'web_properties', label: 'Propriedades de sessão/ação (web)', metricId: 'builtin:billing.apps.web.userActionPropertiesByApplication', weight: 0.01 },
    { key: 'mobile_properties', label: 'Propriedades de sessão/ação (mobile)', metricId: 'builtin:billing.apps.mobile.userActionPropertiesByMobileApplication', weight: 0.01 },
    { key: 'synthetic_external', label: 'Resultados sintéticos terceirizados', metricId: 'builtin:billing.synthetic.external', weight: 0.1 },
];

/**
 * DEM total consumido no período — soma ponderada dos 9 componentes.
 * Cada componente é buscado individualmente (não derruba o total se um
 * componente específico não existir/der erro nesse tenant).
 */
async function fetchDemTotal(baseUrl, apiToken, from = '-30d') {
    let total = 0;
    const breakdown = [];

    for (const comp of DEM_COMPONENTS) {
        try {
            const json = await apiFetch(baseUrl, apiToken, '/api/v2/metrics/query', {
                metricSelector: comp.metricId,
                from,
            });
            const raw = sumMetricResult(json);
            const weighted = raw * comp.weight;
            total += weighted;
            breakdown.push({ key: comp.key, label: comp.label, raw, weight: comp.weight, weighted: Math.round(weighted * 100) / 100 });
        } catch (err) {
            breakdown.push({ key: comp.key, label: comp.label, error: err.message });
        }
    }

    return { total: Math.round(total * 100) / 100, breakdown };
}

// 1 ASU = 16 GiB-hora — confirmado na documentação oficial (tabela de pesos:
// GiB ÷ 16 = ASU/hora para RVA, em todas as faixas de tamanho de host).
// A métrica bruta do Dynatrace vem em GiB-hora (mesmo padrão de
// Full-Stack/Infrastructure Monitoring), não em ASU — por isso precisa
// dessa conversão antes de comparar com a quota.
const APP_SECURITY_GIB_HOURS_PER_ASU = 16;

const APP_SECURITY_COMPONENTS = [
    { key: 'runtime_app_protection', label: 'Runtime application protection', metricId: 'builtin:billing.runtime_application_protection.usage' },
    { key: 'runtime_vuln_analytics', label: 'Runtime vulnerability analytics', metricId: 'builtin:billing.runtime_vulnerability_analytics.usage' },
];

async function fetchAppSecurityTotal(baseUrl, apiToken, from = '-30d') {
    let total = 0;
    const breakdown = [];

    for (const comp of APP_SECURITY_COMPONENTS) {
        try {
            const json = await apiFetch(baseUrl, apiToken, '/api/v2/metrics/query', {
                metricSelector: comp.metricId,
                from,
            });
            const gibHours = sumMetricResult(json);
            const asu = gibHours / APP_SECURITY_GIB_HOURS_PER_ASU;
            total += asu;
            breakdown.push({ key: comp.key, label: comp.label, gibHours: Math.round(gibHours * 100) / 100, asu: Math.round(asu * 100) / 100 });
        } catch (err) {
            breakdown.push({ key: comp.key, label: comp.label, error: err.message });
        }
    }

    return { total: Math.round(total * 100) / 100, breakdown };
}

module.exports = { fetchHostUnits, fetchDduTotal, fetchDemTotal, fetchAppSecurityTotal };