/**
 * reportDataService.js
 * Coleta todos os dados para um relatório APM.
 *
 * DQL          → POST /api/v2/dql/query (Api-Token)
 * Metrics v2   → GET  /api/v2/metrics/query (Api-Token, entitySelector para filtrar)
 * Problems v2  → GET  /api/v2/problems (Api-Token)
 * USQL v1      → GET  /api/v1/userSessionQueryLanguage/table (Api-Token)
 *
 * ── ALTERAÇÕES NESTA VERSÃO ────────────────────────────────────────────────
 * 1. Banco de Dados REMOVIDO do fluxo principal (vai virar relatório próprio,
 *    já que Portal/App/Getran compartilham os mesmos bancos). As funções de
 *    processamento (processDbCalls, processDbFailuresSummary) foram mantidas
 *    no arquivo para reaproveitamento no futuro relatório de BD.
 * 2. Latência: p90 → p95.
 * 3. Alertas: adicionado agrupamento por dia (para o gráfico de colunas).
 * 4. APDEX: adicionada série diária (para o gráfico de linha "classificação
 *    dia a dia"), além do valor agregado do período.
 * 5. Novo bloco "Dispositivos" e "Navegadores" via USQL, filtrado pelo app
 *    de cada seção (extraído do appEntitySelector do reportConfig).
 * 6. Infraestrutura de containers (Portal/App): trocado de Metrics API v2
 *    (builtin:kubernetes.container.* — não existe nesse tenant, retornava 404
 *    "No metric found") para DQL, usando dt.process.cpu.usage /
 *    dt.process.memory.usage agrupado por dt.entity.container_group, no
 *    mesmo padrão usado nos notebooks do Dynatrace. Depende de `k8sNamespace`
 *    configurado na seção (reportConfig.js) e de OAuth Bearer disponível —
 *    caso contrário cai no fallback antigo (Metrics API host-based).
 * 7. USQL: corrigido startTimestamp/endTimestamp para epoch ms (a API rejeitava
 *    string ISO com HTTP 404 "Invalid value for query parameter 'startTimestamp'").
 */

const { getBearerForTenant } = require('../platformControlClient');

// ── Encoding mínimo para Dynatrace ────────────────────────────────
function encodeDt(v) {
    return String(v)
        .replace(/&/g, '%26')
        .replace(/#/g, '%23')
        .replace(/\+/g, '%2B');
}

// ── Fetch genérico ────────────────────────────────────────────────
async function dynaGet(baseUrl, apiToken, path, params = {}) {
    try {
        const qs = Object.entries(params)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}=${encodeDt(v)}`)
            .join('&');
        const url = `${baseUrl}${path}${qs ? '?' + qs : ''}`;
        console.log(`[reportDataService] GET ${url.slice(0, 180)}`);

        const res = await fetch(url, {
            headers: { Authorization: `Api-Token ${apiToken}`, Accept: 'application/json' },
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            console.error(`[reportDataService] HTTP ${res.status}`, JSON.stringify(data).slice(0, 200));
            return null;
        }
        return data;
    } catch (err) {
        console.error(`[reportDataService] GET error ${path}:`, err.message);
        return null;
    }
}

// ── USQL (Api-Token) ──────────────────────────────────────────────
async function runUsql(baseUrl, apiToken, usql, from, to) {
    const params = { query: usql };
    // A API USQL (/api/v1/userSessionQueryLanguage/table) espera startTimestamp/
    // endTimestamp em epoch milissegundos — não em string ISO. `from`/`to` chegam
    // aqui como ISO (ex: "2026-06-01T00:00:00.000-03:00"), então convertemos.
    if (from) {
        const fromMs = new Date(from).getTime();
        if (!Number.isNaN(fromMs)) params.startTimestamp = fromMs;
    }
    if (to) {
        const toMs = new Date(to).getTime();
        if (!Number.isNaN(toMs)) params.endTimestamp = toMs;
    }
    const data = await dynaGet(baseUrl, apiToken, '/api/v1/userSessionQueryLanguage/table', params);
    return data?.values ?? [];
}

// ── DQL via OAuth Bearer → /platform/storage/query/v1/query:execute ──────
async function runDql(baseUrl, bearerHeader, query, from, to) {
    if (!bearerHeader) {
        console.warn('[reportDataService] DQL ignorado — sem OAuth Bearer');
        return [];
    }
    try {
        const appsUrl = baseUrl.replace('.live.dynatrace.com', '.apps.dynatrace.com');
        const url = `${appsUrl}/platform/storage/query/v1/query:execute`;
        console.log(`[reportDataService] DQL: ${query.slice(0, 80)}`);

        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: bearerHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                query,
                defaultTimeframeStart: from,
                defaultTimeframeEnd: to,
                requestTimeoutMilliseconds: 60000,
                fetchTimeoutSeconds: 60,
            }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            console.error(`[reportDataService] DQL HTTP ${res.status}`, JSON.stringify(data).slice(0, 200));
            return [];
        }

        if (data.state === 'RUNNING' && data.requestToken) {
            await new Promise(r => setTimeout(r, 2000));
            const poll = await fetch(
                `${appsUrl}/platform/storage/query/v1/query:poll?requestToken=${data.requestToken}`,
                { headers: { Authorization: bearerHeader, Accept: 'application/json' } }
            );
            return (await poll.json().catch(() => ({})))?.result?.records ?? [];
        }

        return data?.result?.records ?? [];
    } catch (err) {
        console.error('[reportDataService] DQL error:', err.message);
        return [];
    }
}

async function fetchMetric(baseUrl, apiToken, metricSelector, entitySelector, from, to, resolution = 'Inf') {
    const selectorWithNames = metricSelector.endsWith(':names')
        ? metricSelector
        : metricSelector + ':names';

    const params = { metricSelector: selectorWithNames, from, to, resolution };
    if (entitySelector) params.entitySelector = entitySelector;
    const data = await dynaGet(baseUrl, apiToken, '/api/v2/metrics/query', params);
    return data?.result ?? [];
}

// ── Helpers de extração ───────────────────────────────────────────

function sumTimeseries(result) {
    if (!result?.[0]?.data) return 0;
    return result[0].data.reduce((total, series) => {
        return total + (series.values?.filter(v => v !== null) ?? []).reduce((s, v) => s + v, 0);
    }, 0);
}

function extractApdex(result) {
    const vals = result?.[0]?.data?.[0]?.values?.filter(v => v !== null) ?? [];
    if (!vals.length) return null;
    return Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
}

// Série diária única (ex: APDEX dia a dia) → { timestamps: [...], values: [...] }
function extractSingleSeriesTimeseries(result) {
    const series = result?.[0]?.data?.[0];
    if (!series) return { timestamps: [], values: [] };
    return {
        timestamps: series.timestamps ?? [],
        values: series.values ?? [],
    };
}

function extractSeasonality(result) {
    const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const buckets = [];
    for (const series of (result?.[0]?.data ?? [])) {
        for (let i = 0; i < (series.timestamps?.length ?? 0); i++) {
            const ts = series.timestamps[i];
            const val = series.values?.[i];
            if (!ts || val == null) continue;
            const d = new Date(ts);
            buckets.push({ label: `${DAYS[d.getUTCDay()]} - ${String(d.getUTCHours()).padStart(2, '0')}:00`, value: val });
        }
    }
    return buckets.sort((a, b) => b.value - a.value).slice(0, 3);
}

function extractGeo(result, topN = 10) {
    return (result?.[0]?.data ?? [])
        .map(item => ({
            estado: item.dimensionMap?.['dt.entity.geolocation.name'] ?? 'Desconhecido',
            acoes: item.values?.[0] ?? 0,
        }))
        .sort((a, b) => b.acoes - a.acoes)
        .slice(0, topN);
}

function extractCrashes(result) {
    return (result?.[0]?.data ?? []).map(item => ({
        os: item.dimensionMap?.['dt.entity.os.name'] ?? 'Desconhecido',
        versao: item.dimensionMap?.['App Version'] ?? 'Desconhecido',
        crashes: Math.round(item.values?.[0] ?? 0),
    }));
}

function processAlerts(records) {
    if (!records?.length) return { total: 0, byType: [] };

    console.log('[reportDataService] processAlerts sample record:', JSON.stringify(records[0]));

    const byType = records.map(r => {
        const name = r['event.name'] ?? r['title'] ?? 'Unknown';
        const count = Number(
            r['count()'] ?? r['count'] ?? r['`count()`'] ?? r['COUNT'] ?? 1
        );
        return { name, count };
    });

    const allOnes = byType.every(r => r.count === 1);
    if (allOnes) {
        const summary = {};
        for (const r of byType) summary[r.name] = (summary[r.name] ?? 0) + 1;
        const total2 = Object.values(summary).reduce((s, v) => s + v, 0);
        return {
            total: total2,
            byType: Object.entries(summary)
                .map(([name, count]) => ({ name, count, pct: total2 ? Math.round((count / total2) * 100) : 0 }))
                .sort((a, b) => b.count - a.count),
        };
    }

    const total = byType.reduce((s, r) => s + r.count, 0);
    return {
        total,
        byType: byType
            .map(r => ({ ...r, pct: total ? Math.round((r.count / total) * 100) : 0 }))
            .sort((a, b) => b.count - a.count),
    };
}

// Agrupa a timeline de alertas (timestamp, event.name, duracao) por dia,
// para o gráfico de colunas "total de alertas ao longo do mês, por dia".
function processAlertsByDay(timelineRaw) {
    if (!timelineRaw?.length) return [];

    const byDay = {};
    for (const r of timelineRaw) {
        const ts = r.timestamp;
        if (!ts) continue;
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) continue;
        const dayKey = d.toISOString().slice(0, 10); // YYYY-MM-DD
        byDay[dayKey] = (byDay[dayKey] ?? 0) + 1;
    }

    return Object.entries(byDay)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, count]) => {
            const [, m, dd] = day.split('-');
            return { day, label: `${dd}/${m}`, count };
        });
}

function processMetricTimeseries(result, topN = 10) {
    const services = {};
    if (result?.[0]?.data?.[0]) {
        console.log('[reportDataService] metric sample dimensionMap:', JSON.stringify(result[0].data[0].dimensionMap));
    }
    for (const series of (result?.[0]?.data ?? [])) {
        const dim = series.dimensionMap ?? {};
        const name = dim['dt.entity.service.name']
            ?? dim['dt.entity.host.name']
            ?? dim['dt.entity.cloud_application_instance.name']
            ?? dim['dt.entity.cloud_application.name']
            ?? dim['dt.entity.geolocation.name']
            ?? Object.values(dim).find(v => v && !/^[A-Z_]+-[A-F0-9]{16}$/.test(v))
            ?? (Object.values(dim).join(' / ') || 'Unknown');
        const vals = series.values?.filter(v => v !== null) ?? [];
        const total = vals.reduce((s, v) => s + v, 0);
        services[name] = (services[name] ?? 0) + total;
    }
    return Object.entries(services)
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, topN);
}

// Variante que tira a MÉDIA em vez de somar — usada para métricas onde a soma
// não faz sentido (ex: latência p95: somar o p95 de cada bucket de 6h ao
// longo do mês não representa nada; o que se quer é a média do período).
function processMetricTimeseriesAvg(result, topN = 10) {
    const sums = {};
    const counts = {};
    for (const series of (result?.[0]?.data ?? [])) {
        const dim = series.dimensionMap ?? {};
        const name = dim['dt.entity.service.name']
            ?? dim['dt.entity.host.name']
            ?? dim['dt.entity.cloud_application_instance.name']
            ?? dim['dt.entity.cloud_application.name']
            ?? dim['dt.entity.geolocation.name']
            ?? Object.values(dim).find(v => v && !/^[A-Z_]+-[A-F0-9]{16}$/.test(v))
            ?? (Object.values(dim).join(' / ') || 'Unknown');
        const vals = series.values?.filter(v => v !== null) ?? [];
        if (!vals.length) continue;
        const sum = vals.reduce((s, v) => s + v, 0);
        sums[name] = (sums[name] ?? 0) + sum;
        counts[name] = (counts[name] ?? 0) + vals.length;
    }
    return Object.entries(sums)
        .map(([name, sum]) => ({ name, total: sum / (counts[name] || 1) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, topN);
}

async function fetchAllProblems(baseUrl, apiToken, from, to, entitySelector) {
    const all = [];
    let nextPageKey = null;

    do {
        const params = { from, to, pageSize: 50, status: 'CLOSED' };
        if (entitySelector) params.entitySelector = entitySelector;
        if (nextPageKey) params.nextPageKey = nextPageKey;

        const data = await dynaGet(baseUrl, apiToken, '/api/v2/problems', params);
        if (!data) break;

        all.push(...(data.problems ?? []));
        nextPageKey = data.nextPageKey ?? null;
    } while (nextPageKey);

    let nextPageKeyOpen = null;
    do {
        const params = { from, to, pageSize: 50, status: 'OPEN' };
        if (entitySelector) params.entitySelector = entitySelector;
        if (nextPageKeyOpen) params.nextPageKey = nextPageKeyOpen;

        const data = await dynaGet(baseUrl, apiToken, '/api/v2/problems', params);
        if (!data) break;

        all.push(...(data.problems ?? []));
        nextPageKeyOpen = data.nextPageKey ?? null;
    } while (nextPageKeyOpen);

    console.log(`[reportDataService] Problems API: ${all.length} problemas encontrados`);
    return all;
}

function processTimeseriesDql(records, topN = 10) {
    if (!records?.length) return [];

    const services = {};
    for (const r of records) {
        const name = r['dt.entity.service.name'] ?? r['name'] ?? r['host.name'] ?? 'Unknown';
        let total;
        const valueA = r['value.A'];
        if (valueA != null && !Array.isArray(valueA)) {
            total = Number(valueA);
        } else {
            const vals = Object.values(r).find(v => Array.isArray(v)) ?? [];
            total = vals.filter(v => v !== null).reduce((s, v) => s + v, 0);
        }
        if (total > 0) services[name] = (services[name] ?? 0) + total;
    }

    return Object.entries(services)
        .map(([name, total]) => ({ name, total: Math.round(total) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, topN);
}

function extractMultiSeriesTimeseries(result, topN = 20) {
    const data = result?.[0]?.data ?? [];
    if (!data.length) return { timestamps: [], series: [] };

    let timestamps = null;
    const allSeries = [];

    for (const s of data) {
        if (!timestamps && s.timestamps) timestamps = s.timestamps;
        const dim = s.dimensionMap ?? {};
        const name = dim['dt.entity.service.name']
            ?? dim['dt.entity.service_method.name']
            ?? dim['dt.entity.cloud_application_instance.name']
            ?? dim['dt.entity.cloud_application.name']
            ?? dim['name']
            ?? Object.values(dim).find(v => v && !/^[A-Z_]+-[A-F0-9]{8,}$/.test(v))
            ?? 'Unknown';
        if (name === '<default>' || name === 'default') continue;
        const values = s.values ?? [];
        const total = values.filter(v => v !== null).reduce((a, b) => a + b, 0);
        allSeries.push({ name, values, total });
    }

    const top = allSeries.sort((a, b) => b.total - a.total).slice(0, topN);
    return { timestamps: timestamps ?? [], series: top.map(s => ({ name: s.name, values: s.values })) };
}

function extractMultiSeriesTimeseriesDql(records, topN = 20) {
    if (!records?.length) return { timestamps: [], series: [] };

    let timestamps = null;
    const allSeries = [];

    for (const r of records) {
        const name = r['dt.entity.service.name'] ?? r['name'] ?? 'Unknown';
        const arrEntry = Object.entries(r).find(([k, v]) => Array.isArray(v));
        if (!arrEntry) continue;
        const [, values] = arrEntry;

        if (!timestamps && r.timeframe) {
            const start = new Date(r.timeframe.start).getTime();
            const intervalMs = Number(r.interval ?? 0) / 1e6;
            timestamps = values.map((_, i) => start + i * intervalMs);
        }

        const total = values.filter(v => v !== null).reduce((a, b) => a + b, 0);
        allSeries.push({ name, values, total });
    }

    const top = allSeries.sort((a, b) => b.total - a.total).slice(0, topN);
    return { timestamps: timestamps ?? [], series: top.map(s => ({ name: s.name, values: s.values })) };
}

// Monta o DQL de CPU/Memória por container_group, no mesmo padrão usado
// nos notebooks do Dynatrace (dt.process.cpu.usage / dt.process.memory.usage,
// agrupado por dt.entity.container_group, filtrado por namespace k8s).
//
// NOTA: no notebook original, o value.A do "CPU Max" também usava avg(...) —
// ali isso só serve de apoio/ordenação ao lado da série max real. Aqui o
// value.A É o número usado na tabela/gráfico, então ele precisa usar a MESMA
// agregação (agg) pedida, senão "CPU Máxima" sai idêntico a "CPU Média".
function buildContainerGroupDql(metric, agg, namespace) {
    return [
        `timeseries { ${agg}(${metric}), value.A = ${agg}(${metric}, scalar: true) }, by: { dt.entity.container_group }, filter: { matchesValue(k8s.namespace.name, "${namespace}") }`,
        '| fieldsAdd dt.entity.container_group.name = entityName(dt.entity.container_group)',
        '| limit 70',
    ].join('\n');
}

// Processa o resultado DQL acima → [{ name, total }], no mesmo formato usado
// pelo docxBuilder para desenhar o gráfico/tabela de infraestrutura.
function processContainerGroupDql(records, topN = 20) {
    if (!records?.length) return [];
    const byGroup = {};
    for (const r of records) {
        const name = r['dt.entity.container_group.name'] ?? 'Unknown';
        if (name === '<default>' || !name) continue;
        const valueA = r['value.A'];
        const total = typeof valueA === 'number' ? valueA : Number(valueA) || 0;
        byGroup[name] = total;
    }
    return Object.entries(byGroup)
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, topN);
}

// Extrai a série temporal (por dia/bucket) de cada container_group, pro
// gráfico de linha de infraestrutura — mesmo padrão do
// extractMultiSeriesTimeseriesDql (usado em tráfego/latência/erros), só que
// agrupando por dt.entity.container_group.name em vez de service.name.
function extractContainerGroupSeriesDql(records, topN = 20) {
    if (!records?.length) return { timestamps: [], series: [] };

    let timestamps = null;
    const allSeries = [];

    for (const r of records) {
        const name = r['dt.entity.container_group.name'] ?? 'Unknown';
        if (name === '<default>' || !name) continue;

        // A série temporal vem no campo array cujo nome é a métrica em si
        // (ex: "avg(dt.process.cpu.usage)" ou "max(dt.process.cpu.usage)").
        // value.A também é numérico/escalar, então excluímos explicitamente.
        const arrEntry = Object.entries(r).find(([k, v]) => Array.isArray(v) && k !== 'value.A');
        if (!arrEntry) continue;
        const [, values] = arrEntry;

        if (!timestamps && r.timeframe) {
            const start = new Date(r.timeframe.start).getTime();
            const intervalMs = Number(r.interval ?? 0) / 1e6;
            timestamps = values.map((_, i) => start + i * intervalMs);
        }

        // Ranking pelo value.A (mesmo critério usado na tabela/processContainerGroupDql)
        // — NÃO pela soma da série temporal. Containers que rodam pouco tempo no mês
        // (ex: pods de build/batch) têm poucos pontos de dado, então a SOMA da série
        // sai artificialmente baixa mesmo quando o uso real (value.A) é alto — isso
        // fazia esses containers saírem do gráfico mesmo estando corretos na tabela.
        const valueA = r['value.A'];
        const rank = typeof valueA === 'number' ? valueA : Number(valueA) || 0;
        allSeries.push({ name, values, rank });
    }

    const top = allSeries.sort((a, b) => b.rank - a.rank).slice(0, topN);
    return { timestamps: timestamps ?? [], series: top.map(s => ({ name: s.name, values: s.values })) };
}

// ── Reservado para o futuro relatório de Banco de Dados ───────────
// (Não é chamado no fluxo principal — mantido para reaproveitamento.)
function processDbCalls(result, topN = 15) {
    const requests = {};
    for (const series of (result?.[0]?.data ?? [])) {
        const dim = series.dimensionMap ?? {};
        const name = dim['dt.entity.service_method.name'] ?? dim['name'] ?? 'Unknown';
        const vals = series.values?.filter(v => v !== null) ?? [];
        const total = vals.reduce((s, v) => s + v, 0);
        if (total > 0) requests[name] = (requests[name] ?? 0) + total;
    }
    return Object.entries(requests)
        .map(([name, total]) => ({ name, total: Math.round(total) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, topN);
}

function processDbFailuresSummary(failureRateResult, failureCountResult, topN = 15) {
    const byService = {};

    for (const series of (failureRateResult?.[0]?.data ?? [])) {
        const dim = series.dimensionMap ?? {};
        const name = dim['dt.entity.service.name'] ?? dim['name'] ?? 'Unknown';
        if (name === '<default>' || name === 'default') continue;
        const vals = series.values?.filter(v => v !== null) ?? [];
        if (!vals.length) continue;
        const media = vals.reduce((s, v) => s + v, 0) / vals.length;
        byService[name] = byService[name] ?? {};
        byService[name].taxaMediaFalha = media;
    }

    for (const series of (failureCountResult?.[0]?.data ?? [])) {
        const dim = series.dimensionMap ?? {};
        const name = dim['dt.entity.service.name'] ?? dim['name'] ?? 'Unknown';
        if (name === '<default>' || name === 'default') continue;
        const vals = series.values?.filter(v => v !== null) ?? [];
        const total = vals.reduce((s, v) => s + v, 0);
        byService[name] = byService[name] ?? {};
        byService[name].totalFalhas = Math.round(total);
    }

    return Object.entries(byService)
        .map(([name, v]) => ({
            name,
            taxaMediaFalha: v.taxaMediaFalha ?? 0,
            totalFalhas: v.totalFalhas ?? 0,
        }))
        .filter(r => r.totalFalhas > 0 || r.taxaMediaFalha > 0)
        .sort((a, b) => b.totalFalhas - a.totalFalhas)
        .slice(0, topN);
}

// ── Dispositivos e Navegadores (USQL) ──────────────────────────────

// Extrai o valor entre aspas de entityName.equals("...") do appEntitySelector,
// para poder filtrar o USQL pela aplicação certa (mesmo tenant hospeda várias apps).
function extractAppNameFromSelector(selector) {
    if (!selector) return null;
    const m = selector.match(/entityName\.equals\("([^"]+)"\)/);
    return m ? m[1] : null;
}

// Clausula de filtro por aplicação, reaproveitada em todas as queries USQL
// sobre `usersession` — mesmo padrão validado no fetchTotalSessionsUsql
// (o campo usersession.applicationId NÃO existe; o filtro tem que ser feito
// via useraction/userevent/usererror.application).
function buildAppFilterClause(appName) {
    if (!appName) return null;
    return `(useraction.application='${appName}' OR userevent.application='${appName}' OR usererror.application='${appName}')`;
}

async function fetchTotalSessionsUsql(base, apiToken, appName, from, to) {
    if (!appName) {
        console.warn('[reportDataService] fetchTotalSessionsUsql: appName vazio (appEntitySelector sem entityName.equals?) — pulando USQL');
        return null;
    }
    const clause = buildAppFilterClause(appName);
    const usql = `SELECT COUNT(*) FROM usersession WHERE ${clause}`;
    const rows = await runUsql(base, apiToken, usql, from, to);
    console.log('[reportDataService] fetchTotalSessionsUsql rows:', JSON.stringify(rows));
    const val = rows?.[0]?.[0];
    if (typeof val !== 'number') {
        console.warn('[reportDataService] fetchTotalSessionsUsql: resposta sem valor numérico — caindo no fallback (activeSessions somado)');
        return null;
    }
    return val;
}

async function fetchDeviceBreakdown(base, apiToken, appName, from, to) {
    const clause = buildAppFilterClause(appName);
    const usql =
        'SELECT browserType, count(*) FROM usersession WHERE ' +
        (clause ? `${clause} AND ` : '') +
        'userType = "REAL_USER" GROUP BY browserType';

    const rows = await runUsql(base, apiToken, usql, from, to);
    const parsed = (rows || []).map(row => ({ label: row[0] || 'Desconhecido', count: row[1] || 0 }));
    const total = parsed.reduce((s, r) => s + r.count, 0);
    return parsed
        .map(r => ({ ...r, pct: total ? Number(((r.count / total) * 100).toFixed(1)) : 0 }))
        .sort((a, b) => b.count - a.count);
}

async function fetchBrowserBreakdown(base, apiToken, appName, from, to, topN = 5) {
    // Aqui a query é sobre `useraction` (mesmo padrão do dynaServicesController),
    // então o filtro de app é direto por useraction.application, sem OR.
    const usql =
        'SELECT usersession.browserFamily, count(*) FROM useraction WHERE ' +
        (appName ? `useraction.application='${appName}' AND ` : '') +
        'usersession.userType = "REAL_USER" GROUP BY usersession.browserFamily';

    const rows = await runUsql(base, apiToken, usql, from, to);
    const parsed = (rows || [])
        .map(row => ({ label: row[0] || 'Unknown', count: row[1] || 0 }))
        .sort((a, b) => b.count - a.count);

    const total = parsed.reduce((s, r) => s + r.count, 0);
    const top = parsed.slice(0, topN);
    const othersTotal = total - top.reduce((s, r) => s + r.count, 0);
    if (othersTotal > 0) top.push({ label: 'Outros', count: othersTotal });

    return top.map(r => ({ ...r, pct: total ? Number(((r.count / total) * 100).toFixed(1)) : 0 }));
}

// Taxa de rejeição via USQL — mesmo padrão do dynaBounceRate (dynaUserSessionsController.js),
// mas com o filtro de app corrigido (useraction/userevent/usererror.application).
async function fetchBounceRateUsql(base, apiToken, appName, from, to) {
    const clause = buildAppFilterClause(appName);
    const usql =
        'SELECT bounce, count(*) FROM usersession WHERE ' +
        (clause ? `${clause} AND ` : '') +
        'userType = "REAL_USER" GROUP BY bounce';

    const rows = await runUsql(base, apiToken, usql, from, to);
    console.log('[reportDataService] fetchBounceRateUsql rows:', JSON.stringify(rows));
    let bounceCount = 0;
    let total = 0;
    for (const row of rows || []) {
        const isBounce = row[0] === true || row[0] === 'true' || row[0] === 1 || row[0] === '1';
        const count = row[1] || 0;
        total += count;
        if (isBounce) bounceCount += count;
    }
    if (!total) return null;
    return bounceCount / total;
}

// Total de Rage Clicks via USQL — mesmo padrão do dynaRageClicks
// (dynaUserSessionsController.js), mas somando clicks × sessões (o controller
// original só devolve a distribuição, não o total agregado que o relatório precisa).
// Total de Rage Clicks via USQL — SUM direto é mais simples e direto que
// GROUP BY + multiplicação manual, e evita a confusão entre COUNT (nº de
// sessões com rage click) e o total de cliques de fato.
async function fetchRageClicksUsql(base, apiToken, appName, from, to) {
    const clause = buildAppFilterClause(appName);
    const usql =
        'SELECT SUM(numberOfRageClicks) FROM usersession WHERE ' +
        (clause ? `${clause} AND ` : '') +
        'userType = "REAL_USER"';

    const rows = await runUsql(base, apiToken, usql, from, to);
    console.log('[reportDataService] fetchRageClicksUsql rows:', JSON.stringify(rows));
    const val = rows?.[0]?.[0];
    return typeof val === 'number' ? val : null;
}

// Geolocalização apenas por estado (region) via USQL — a métrica builtin
// (dt.entity.geolocation) retorna a hierarquia inteira (*, continente, país,
// estado), o que polui o Top 10 já que a maior parte do tráfego é do DF.
async function fetchGeoByRegionUsql(base, apiToken, appName, from, to, topN = 10) {
    const clause = buildAppFilterClause(appName);
    const usql =
        'SELECT count(*), region FROM usersession WHERE ' +
        (clause ? `${clause} AND ` : '') +
        `userType="REAL_USER" AND region IS NOT NULL GROUP BY region LIMIT ${topN}`;

    const rows = await runUsql(base, apiToken, usql, from, to);
    console.log('[reportDataService] fetchGeoByRegionUsql rows:', JSON.stringify(rows));
    return (rows || [])
        .map(row => ({ estado: row[1] || 'Desconhecido', acoes: row[0] || 0 }))
        .sort((a, b) => b.acoes - a.acoes);
}

// ── Coleta principal ──────────────────────────────────────────────

async function collectSectionData(tenant, tenantMongoId, section, from, to) {
    const base = tenant.baseUrl.replace(/\/$/, '');
    const apiToken = tenant.apiToken;

    const platformAuth = await getBearerForTenant(tenantMongoId);
    const bearer = platformAuth?.header ?? null;
    console.log(`[reportDataService] Coletando dados: ${section.label} | ${from} → ${to}`);
    console.log(`[reportDataService] OAuth disponível: ${!!bearer}`);

    const dql = (query) => runDql(base, bearer, query, from, to);

    // Alertas
    let alertsRaw = [];
    let alertsTimelineRaw = [];

    if (bearer && section.alertsDql) {
        const appsBase = base.replace('.live.dynatrace.com', '.apps.dynatrace.com');
        const alertsSummaryQuery = section.alertsDql
            + '\n| summarize by:{event.name}, count()'
            + '\n| sort `count()` desc';
        const alertsTimelineQuery = section.alertsDql
            + '\n| fields timestamp, event.name, resolved_problem_duration';

        console.log('[reportDataService] Coletando alertas via DQL...');
        [alertsRaw, alertsTimelineRaw] = await Promise.all([
            runDql(appsBase, bearer, alertsSummaryQuery, from, to),
            runDql(appsBase, bearer, alertsTimelineQuery, from, to),
        ]);
        console.log(`[reportDataService] DQL alertas: ${alertsRaw.length} tipos encontrados`);
    }

    if (!alertsRaw.length) {
        console.log('[reportDataService] Fallback para Problems API...');
        const allProblems = await fetchAllProblems(base, apiToken, from, to, section.problemEntitySelector);
        const summary = {};
        for (const p of allProblems) {
            const name = p.title ?? p.problemType ?? 'Unknown';
            summary[name] = (summary[name] || 0) + 1;
        }
        alertsRaw = Object.entries(summary).map(([name, count]) => ({ 'event.name': name, 'count()': count }));
        alertsTimelineRaw = allProblems.map(p => ({
            timestamp: p.startTime, 'event.name': p.title ?? p.problemType, status: p.status,
        }));
    }

    const svcEntity = section.serviceEntitySelector ?? null;
    const infraEntity = section.infraEntitySelector ?? null;
    const appEntity = section.appEntitySelector ?? null;
    const geoEntity = section.geoEntitySelector ?? null;
    const appNameForUsql = extractAppNameFromSelector(appEntity);

    // Infra de containers K8s: builtin:kubernetes.container.* não existe nesse
    // tenant (404 "No metric found") — usar DQL (dt.process.cpu/memory.usage
    // por dt.entity.container_group), igual ao notebook, exige seção com
    // k8sNamespace configurado e OAuth Bearer disponível.
    const useContainerDql = section.infraType === 'container' && !!section.k8sNamespace && !!bearer;

    const fm = (selector, entity, res = 'Inf') =>
        fetchMetric(base, apiToken, selector, entity, from, to, res);

    const [
        trafficResult,
        latencyResult,
        err4xxResult,
        err5xxResult,
        cpuAvgResult,
        cpuMaxResult,
        memoryResult,
        apdexResult,
        apdexSerieResult,
        sessionsResult,
        rageResult,
        bounceResult,
        startedResult,
        activeResult,
        geoResult,
        crashResult,
        deviceRows,
        browserRows,
        totalSessionsUsql,
        rageClicksUsql,
        bounceRateUsql,
        geoRegionRows,
    ] = await Promise.all([
        fm('builtin:service.requestCount.total:splitBy("dt.entity.service"):sum', svcEntity, '6h'),
        // p90 → p95, conforme novo padrão do relatório
        fm('builtin:service.response.time:splitBy("dt.entity.service"):percentile(95)', svcEntity, '6h'),
        section.err4xxMetric
            ? fm(section.err4xxMetric, null, '6h')
            : section.err4xxDql
                ? runDql(base, bearer, section.err4xxDql, from, to)
                : fm('builtin:service.errors.total.count:splitBy("dt.entity.service"):sum', svcEntity, '6h'),
        section.err5xxMetric
            ? fm(section.err5xxMetric, null, '6h')
            : section.err5xxDql
                ? runDql(base, bearer, section.err5xxDql, from, to)
                : fm('builtin:service.errors.total.count:splitBy("dt.entity.service"):sum', svcEntity, '6h'),
        // Infra: para Portal/App (container), usa DQL por container_group
        // (dt.process.cpu.usage / dt.process.memory.usage) — a Metrics API v2
        // não tem builtin:kubernetes.container.* nesse tenant. Para Getran
        // (infraType: 'host'), continua na Metrics API normal.
        useContainerDql
            ? runDql(base, bearer, buildContainerGroupDql('dt.process.cpu.usage', 'avg', section.k8sNamespace), from, to)
            : fm(
                section.cpuMetric ?? 'builtin:host.cpu.usage:splitBy("dt.entity.host"):avg',
                section.infraType === 'host' ? infraEntity : null
            ),
        useContainerDql
            ? runDql(base, bearer, buildContainerGroupDql('dt.process.cpu.usage', 'max', section.k8sNamespace), from, to)
            : fm(
                section.cpuMaxMetric ?? 'builtin:host.cpu.usage:splitBy("dt.entity.host"):max',
                section.infraType === 'host' ? infraEntity : null
            ),
        useContainerDql
            ? runDql(base, bearer, buildContainerGroupDql('dt.process.memory.usage', 'avg', section.k8sNamespace), from, to)
            : fm(
                section.memMetric ?? 'builtin:host.mem.usage:splitBy("dt.entity.host"):avg',
                section.infraType === 'host' ? infraEntity : null
            ),
        section.apdexMetric ? fm(section.apdexMetric, appEntity) : Promise.resolve([]),
        // Série diária do APDEX para o gráfico de linha "classificação dia a dia"
        section.apdexMetric ? fm(section.apdexMetric, appEntity, '1d') : Promise.resolve([]),
        section.sessionsMetric ? fm(section.sessionsMetric, appEntity, '1h') : Promise.resolve([]),
        section.rageMetric ? fm(section.rageMetric, appEntity, '1h') : Promise.resolve([]),
        section.bounceMetric ? fm(section.bounceMetric, appEntity) : Promise.resolve([]),
        section.startedSessionsMetric ? fm(section.startedSessionsMetric, appEntity, '1h') : Promise.resolve([]),
        section.activeSessionsMetric ? fm(section.activeSessionsMetric, appEntity, '1h') : Promise.resolve([]),
        section.geoMetric ? fm(section.geoMetric, geoEntity) : Promise.resolve([]),
        section.crashMetric ? fm(section.crashMetric, appEntity) : Promise.resolve([]),
        fetchDeviceBreakdown(base, apiToken, appNameForUsql, from, to),
        fetchBrowserBreakdown(base, apiToken, appNameForUsql, from, to),
        fetchTotalSessionsUsql(base, apiToken, appNameForUsql, from, to),
        section.rageMetric ? fetchRageClicksUsql(base, apiToken, appNameForUsql, from, to) : Promise.resolve(null),
        section.bounceMetric ? fetchBounceRateUsql(base, apiToken, appNameForUsql, from, to) : Promise.resolve(null),
        fetchGeoByRegionUsql(base, apiToken, appNameForUsql, from, to, 10),
    ]);

    // NOTA: as chamadas de Banco de Dados (dbMetric, dbTimeMetric, dbFailureMetric,
    // dbFailureRateMetric) foram removidas deste fluxo — ver cabeçalho do arquivo.

    return {
        key: section.key,
        label: section.label,

        alertas: {
            ...processAlerts(alertsRaw),
            byDay: processAlertsByDay(alertsTimelineRaw),
            timeline: (alertsTimelineRaw ?? []).map(r => ({
                timestamp: r.timestamp,
                tipo: r['event.name'],
                duracao: r['resolved_problem_duration'],
            })),
        },

        performance: {
            trafico: processMetricTimeseries(trafficResult),
            latencia: processMetricTimeseriesAvg(latencyResult),
            erros4xx: section.err4xxMetric || !section.err4xxDql
                ? processMetricTimeseries(err4xxResult)
                : processTimeseriesDql(err4xxResult),
            erros5xx: section.err5xxMetric || !section.err5xxDql
                ? processMetricTimeseries(err5xxResult)
                : processTimeseriesDql(err5xxResult),
            traficoSerie: extractMultiSeriesTimeseries(trafficResult),
            latenciaSerie: extractMultiSeriesTimeseries(latencyResult),
            erros4xxSerie: section.err4xxMetric || !section.err4xxDql
                ? extractMultiSeriesTimeseries(err4xxResult)
                : extractMultiSeriesTimeseriesDql(err4xxResult),
            erros5xxSerie: section.err5xxMetric || !section.err5xxDql
                ? extractMultiSeriesTimeseries(err5xxResult)
                : extractMultiSeriesTimeseriesDql(err5xxResult),
        },

        infra: {
            cpuAvg: useContainerDql ? processContainerGroupDql(cpuAvgResult) : processMetricTimeseries(cpuAvgResult),
            cpuMax: useContainerDql ? processContainerGroupDql(cpuMaxResult) : processMetricTimeseries(cpuMaxResult),
            memory: useContainerDql ? processContainerGroupDql(memoryResult) : processMetricTimeseries(memoryResult),
            cpuAvgSerie: useContainerDql ? extractContainerGroupSeriesDql(cpuAvgResult) : extractMultiSeriesTimeseries(cpuAvgResult),
            cpuMaxSerie: useContainerDql ? extractContainerGroupSeriesDql(cpuMaxResult) : extractMultiSeriesTimeseries(cpuMaxResult),
            memorySerie: useContainerDql ? extractContainerGroupSeriesDql(memoryResult) : extractMultiSeriesTimeseries(memoryResult),
        },

        ux: {
            apdex: extractApdex(apdexResult),
            apdexSerie: extractSingleSeriesTimeseries(apdexSerieResult),
            // Fonte principal: USQL (COUNT(*) real de usersession).
            // Fallback: soma da métrica builtin, caso o USQL falhe (menos preciso —
            // activeSessions é gauge e pode contar a mesma sessão mais de uma vez).
            sessoes: totalSessionsUsql !== null ? totalSessionsUsql : Math.round(sumTimeseries(sessionsResult)),
            // Rage Clicks e Bounce Rate: fonte principal USQL (mesmo padrão do
            // dynaUserSessionsController.js já usado no relatório geral).
            // Fallback: métrica builtin, caso o USQL falhe.
            rageClicks: section.rageMetric
                ? (rageClicksUsql !== null ? rageClicksUsql : Math.round(sumTimeseries(rageResult)))
                : null,
            bounceRate: section.bounceMetric
                ? (bounceRateUsql !== null ? bounceRateUsql : (() => {
                    const raw = bounceResult?.[0]?.data?.[0]?.values?.find(v => v !== null) ?? null;
                    if (raw === null) return null;
                    return raw > 1 ? raw / 100 : raw;
                })())
                : null,
            sazonalidade: {
                iniciadas: extractSeasonality(startedResult),
                ativas: extractSeasonality(activeResult),
            },
            geolocalizacao: geoRegionRows?.length ? geoRegionRows : extractGeo(geoResult, 10),
            crashes: section.hasCrashes ? extractCrashes(crashResult) : null,
            devices: deviceRows,
            browsers: browserRows,
        },
    };
}

module.exports = { collectSectionData };