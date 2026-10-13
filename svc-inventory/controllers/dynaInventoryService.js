/**
 * dynaInventoryService.js
 * Inventário completo do tenant — cobre todos os escopos do token ReportAPI_v2.
 */
const { resolveBaseUrl } = require('../utils/dynaFetch');

// ---------------------------------------------------------------------------
// FILTROS DE RUÍDO K8S
// ---------------------------------------------------------------------------
const NOISE_FILTERS = {
  DISK: {
    prefixos: ['/var/lib/kubelet/pods/', '/var/lib/kubelet/plugins/', '/run/containerd/'],
  },
  CLOUD_APPLICATION: {
    prefixos: ['redhat-operators-', 'redhat-marketplace-', 'certified-operators-', 'community-operators-'],
    contem: ['openshift-', 'kube-', 'cluster-'],
  },
  CLOUD_APPLICATION_NAMESPACE: {
    prefixos: ['openshift-', 'kube-', 'cluster-', 'default'],
  },
};

function applyNoiseFilter(category, items) {
  const rules = NOISE_FILTERS[category];
  if (!rules) return { filtered: items, removed: 0 };
  const { prefixos = [], contem = [] } = rules;
  const filtered = items.filter((item) => {
    const name = (item.displayName || item.name || '').toLowerCase();
    return (
      !prefixos.some((p) => name.startsWith(p.toLowerCase())) &&
      !contem.some((c) => name.includes(c.toLowerCase()))
    );
  });
  return { filtered, removed: items.length - filtered.length };
}

// ---------------------------------------------------------------------------
// CRUZAMENTO COM MANAGEMENT ZONES
// ---------------------------------------------------------------------------
function buildManagementZoneCrossRef(inventory) {
  const ENTITY_CATEGORIES = [
    'HOST', 'PROCESS_GROUP', 'SERVICE', 'APPLICATION',
    'KUBERNETES_CLUSTER', 'KUBERNETES_NODE',
    'CLOUD_APPLICATION', 'CLOUD_APPLICATION_NAMESPACE',
    'DISK', 'NETWORK_INTERFACE', 'SYNTHETIC_TEST', 'CUSTOM_DEVICE',
    'DATABASE_SERVICE',
  ];
  const mzMap = new Map();
  for (const category of ENTITY_CATEGORIES) {
    const items = inventory[category] || [];
    for (const item of items) {
      const zones = item.managementZones || [];
      if (zones.length === 0) {
        const key = '(sem Management Zone)';
        if (!mzMap.has(key)) mzMap.set(key, {});
        const bucket = mzMap.get(key);
        if (!bucket[category]) bucket[category] = [];
        bucket[category].push(item);
        continue;
      }
      for (const mz of zones) {
        const key = mz.name || mz.id || 'desconhecida';
        if (!mzMap.has(key)) mzMap.set(key, {});
        const bucket = mzMap.get(key);
        if (!bucket[category]) bucket[category] = [];
        bucket[category].push(item);
      }
    }
  }
  return mzMap;
}

// ---------------------------------------------------------------------------
// CREDENCIAIS DE PLATAFORMA (Documents API)
// Delegado ao svc-platform-control via HTTP — não acessa o banco diretamente.
// ---------------------------------------------------------------------------
const { getBearerForTenant } = require('../services/platformControlClient');

// ---------------------------------------------------------------------------
// VALIDAÇÃO DE URL
// ---------------------------------------------------------------------------
function extractSuggestedUrl(message = '') {
  const match = message.match(/go to '(https?:\/\/[^']+)'/i);
  return match ? match[1].replace(/\/$/, '') : null;
}

async function validateTenant(baseUrl, apiToken) {
  const tenant = baseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Api-Token ${apiToken}`, 'Content-Type': 'application/json' };
  const testPath = '/api/v2/entities?entitySelector=type("HOST")&pageSize=1';

  // Resolve automaticamente entre .live. e .apps. dependendo da rede
  const resolvedBase = await resolveBaseUrl(tenant, apiToken);

  async function probe(url) {
    const res = await fetch(`${url}${testPath}`, { headers });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }

  try {
    const { res, body } = await probe(resolvedBase);
    if (res.ok) return { ok: true, baseUrlUsed: tenant, suggestedUrl: null, tokenValid: true, error: null };

    if (res.status === 404) {
      const suggestedUrl = extractSuggestedUrl(body?.error?.message || '');
      if (suggestedUrl && suggestedUrl !== tenant) {
        const { res: res2, body: body2 } = await probe(suggestedUrl);
        if (res2.ok) return { ok: true, baseUrlUsed: suggestedUrl, suggestedUrl, tokenValid: true, error: null };
        if (res2.status === 401 || res2.status === 403)
          return {
            ok: false, baseUrlUsed: suggestedUrl, suggestedUrl, tokenValid: false,
            error: `URL correta detectada (${suggestedUrl}), mas o token é inválido (HTTP ${res2.status}).`
          };
        return {
          ok: false, baseUrlUsed: suggestedUrl, suggestedUrl, tokenValid: false,
          error: `URL sugerida retornou HTTP ${res2.status}: ${body2?.error?.message || ''}`
        };
      }
      return {
        ok: false, baseUrlUsed: tenant, suggestedUrl: null, tokenValid: false,
        error: `404 — baseUrl incorreto. Mensagem: "${body?.error?.message || ''}"`
      };
    }
    if (res.status === 401 || res.status === 403)
      return {
        ok: false, baseUrlUsed: tenant, suggestedUrl: null, tokenValid: false,
        error: `Token inválido ou sem permissão (HTTP ${res.status}).`
      };

    return {
      ok: false, baseUrlUsed: tenant, suggestedUrl: null, tokenValid: false,
      error: `HTTP ${res.status}: ${body?.error?.message || 'Erro desconhecido'}`
    };
  } catch (err) {
    return {
      ok: false, baseUrlUsed: tenant, suggestedUrl: null, tokenValid: false,
      error: `Falha de rede: ${err.message}`
    };
  }
}

// ---------------------------------------------------------------------------
// API CLIENT
// ---------------------------------------------------------------------------
function createApiClient(baseUrl, apiToken, tenantMongoId = null) {
  const tenant = baseUrl.replace(/\/$/, '');
  // Platform API (.apps.) é diferente da Classic API (.live.)
  const platformTenant = tenant.includes('.live.')
    ? tenant.replace('.live.dynatrace.com', '.apps.dynatrace.com')
    : tenant;
  const headers = { Authorization: `Api-Token ${apiToken}`, 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function apiFetch(path, params = {}) {
    const url = new URL(`${tenant}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    console.log(`[DynaInventory] → ${url.toString()}`);
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} em ${path}: ${body}`);
    }
    return res.json();
  }

  // Paginação genérica — respeita o pageSize máximo por endpoint
  async function fetchAllPaged(path, baseParams, itemsKey, maxPageSize = 500) {
    const result = [];
    let nextPageKey = null;
    do {
      const params = nextPageKey
        ? { nextPageKey }
        : { ...baseParams, pageSize: maxPageSize };
      const data = await apiFetch(path, params);
      result.push(...(data[itemsKey] || []));
      nextPageKey = data.nextPageKey || null;
      if (nextPageKey) await sleep(200);
    } while (nextPageKey);
    return result;
  }

  // Wrapper para endpoints que podem não estar disponíveis no plano (403/404)
  // Retorna [] silenciosamente sem logar erro
  async function fetchOptional(fn, label) {
    try {
      return await fn();
    } catch (err) {
      const status = err.message.match(/HTTP (\d+)/)?.[1];
      if (status === '403' || status === '404') {
        console.log(`[DynaInventory] ${label} não disponível neste tenant (HTTP ${status}) — ignorado.`);
        return [];
      }
      throw err; // outros erros ainda propagam
    }
  }

  // ── Entidades v2 (entities.read) ──────────────────────────────────────────
  // ⚠️ MEMÓRIA: só pedimos "+properties" para os tipos que realmente usam esse
  // campo no código (hoje, só HOST — para osType/monitoringMode no export de
  // infraestrutura). Para os outros tipos, "properties" é um campo pesado
  // (principalmente em PROCESS_GROUP: command line, env vars etc.) que só
  // infla a memória e o tamanho da resposta sem necessidade. Em tenants
  // grandes (DETRAN, ~10k entidades) isso pode ser a diferença entre o
  // processo aguentar ou estourar o limite de memória do pod.
  const ENTITY_TYPES_NEEDING_PROPERTIES = new Set(['HOST']);

  async function fetchAllEntities(entityType) {
    const fields = ENTITY_TYPES_NEEDING_PROPERTIES.has(entityType)
      ? '+properties,+tags,+managementZones'
      : '+tags,+managementZones';
    return fetchAllPaged(
      '/api/v2/entities',
      { entitySelector: `type("${entityType}")`, fields },
      'entities',
      500
    );
  }

  // ── V1 Config (ReadConfig) ────────────────────────────────────────────────
  const v1Config = (path, key) => () => apiFetch(path).then((d) => d[key] || []);

  // ── V2 adicionais ─────────────────────────────────────────────────────────

  // activeGates.read
  const fetchActiveGates = () => fetchAllPaged('/api/v2/activeGates', {}, 'activeGates', 500);

  // activeGateTokenManagement.read
  const fetchActiveGateTokens = () => fetchAllPaged('/api/v2/activeGateTokens', {}, 'activeGateTokens', 500);

  // apiTokens.read
  const fetchApiTokens = () => fetchAllPaged(
    '/api/v2/apiTokens',
    { fields: 'id,name,enabled,owner,creationDate,expirationDate,lastUsedDate,scopes' },
    'apiTokens',
    500
  );

  // attacks.read — FIX: módulo opcional (403 se Application Protection não contratado)
  const fetchAttacks = () => fetchOptional(
    () => fetchAllPaged('/api/v2/attacks', { from: 'now-30d' }, 'attacks', 500),
    'ATTACKS'
  );

  // extensions.read — FIX: pageSize máximo = 100
  const fetchExtensions = () => fetchAllPaged('/api/v2/extensions', {}, 'extensions', 100);

  // networkZones.read
  const fetchNetworkZones = () => apiFetch('/api/v2/networkZones').then((d) => d.networkZones || []);

  // entities.read — Database Services NÃO são um tipo de entidade v2 próprio
  // (não existe type("DATABASE_SERVICE")) — são SERVICE com a propriedade
  // databaseName presente. entitySelector confirmado em fórum da comunidade
  // Dynatrace: type("SERVICE"),databaseName.exists()
  const fetchDatabaseServices = () => fetchAllPaged(
    '/api/v2/entities',
    { entitySelector: 'type("SERVICE"),databaseName.exists()', fields: '+tags,+managementZones' },
    'entities',
    500
  );

  // problems.read
  //const fetchProblems = () => fetchAllPaged('/api/v2/problems', { from: 'now-30d' }, 'problems', 500);

  // securityProblems.read — FIX: módulo opcional (403 se Vulnerability Assessment não contratado)
  const fetchSecurityProblems = () => fetchOptional(
    () => fetchAllPaged('/api/v2/securityProblems', {}, 'securityProblems', 500),
    'SECURITY_PROBLEMS'
  );

  // slo.read
  const fetchSlo = () => fetchAllPaged('/api/v2/slo', {}, 'slo', 500);

  // syntheticLocations.read
  const fetchSyntheticLocations = () => apiFetch('/api/v2/synthetic/locations').then((d) => d.locations || []);

  // releases.read
  const fetchReleases = () => fetchAllPaged('/api/v2/releases', {}, 'releases', 500);

  // credentialVault.read
  const fetchCredentials = () => fetchAllPaged('/api/v2/credentials', {}, 'credentials', 500);

  // oneAgents.read — FIX: era 'oneagents', o path correto é 'oneAgents' (camelCase)
  const fetchOneAgents = () => fetchOptional(
    () => fetchAllPaged('/api/v2/oneAgents', {}, 'hosts', 500),
    'ONE_AGENTS'
  );

  // events.read
  // const fetchEvents = () => fetchAllPaged('/api/v2/events', { from: 'now-24h' }, 'events', 500);

  // metrics.read
  const fetchMetricDescriptors = () => fetchAllPaged(
    '/api/v2/metrics',
    { writtenSince: 'now-7d', fields: 'displayName,unit,entityType' },
    'metrics',
    500
  );

  // ── V1 Config extras (ReadConfig) ─────────────────────────────────────────
  const fetchRequestAttributes = v1Config('/api/config/v1/service/requestAttributes', 'values');
  const fetchCalculatedMetrics = v1Config('/api/config/v1/calculatedMetrics/service', 'values');
  const fetchAnomalyMetricEvents = v1Config('/api/config/v1/anomalyDetection/metricEvents', 'values');
  const fetchConditionalNaming = v1Config('/api/config/v1/conditionalNaming/service', 'values');
  const fetchWebApplications = v1Config('/api/config/v1/applications/web', 'values');
  const fetchMobileApplications = v1Config('/api/config/v1/applications/mobile', 'values');

  return {
    sleep,
    fetchAllEntities,
    // V1 Config
    fetchAllDashboards: v1Config('/api/config/v1/dashboards', 'dashboards'),

    // Gen3 dashboards — Documents API (Platform)
    // Usa .apps.dynatrace.com + credencial de plataforma separada (Bearer)
    fetchDashboardsGen3: async () => {
      try {
        if (!tenantMongoId) {
          console.log('[DynaInventory] DASHBOARDS_GEN3 ignorado — tenantMongoId não disponível.');
          return [];
        }
        const platformAuth = await getBearerForTenant(tenantMongoId);
        if (!platformAuth) {
          console.log('[DynaInventory] DASHBOARDS_GEN3 ignorado — sem credencial de plataforma para este tenant.');
          return [];
        }
        const platformHeaders = { Authorization: platformAuth.header, Accept: 'application/json' };
        const result = [];
        let nextPage = null;
        do {
          const url = new URL(platformTenant + '/platform/document/v1/documents');
          url.searchParams.set('filter', "type='dashboard'");
          url.searchParams.set('page-size', '100');
          if (nextPage) url.searchParams.set('page-key', nextPage);
          const res = await fetch(url.toString(), { headers: platformHeaders });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error('HTTP ' + res.status + ' em platform/document');
          result.push(...(data.documents || []));
          nextPage = data.nextPageKey || null;
          if (nextPage) await sleep(200);
        } while (nextPage);
        return result;
      } catch (err) {
        const status = err.message.match(/HTTP (\d+)/)?.[1];
        if (status === '403' || status === '404') {
          console.log('[DynaInventory] DASHBOARDS_GEN3 nao disponivel (HTTP ' + status + ').');
          return [];
        }
        console.error('[DynaInventory] Erro em DASHBOARDS_GEN3:', err.message);
        return [];
      }
    },

    // Notebooks — mesma Documents API, tipo diferente
    fetchNotebooks: async () => {
      try {
        if (!tenantMongoId) {
          console.log('[DynaInventory] NOTEBOOKS ignorado — tenantMongoId não disponível.');
          return [];
        }
        const platformAuth = await getBearerForTenant(tenantMongoId);
        if (!platformAuth) {
          console.log('[DynaInventory] NOTEBOOKS ignorado — sem credencial de plataforma para este tenant.');
          return [];
        }
        const platformHeaders = { Authorization: platformAuth.header, Accept: 'application/json' };
        const result = [];
        let nextPage = null;
        do {
          const url = new URL(platformTenant + '/platform/document/v1/documents');
          url.searchParams.set('filter', "type='notebook'");
          url.searchParams.set('page-size', '100');
          if (nextPage) url.searchParams.set('page-key', nextPage);
          const res = await fetch(url.toString(), { headers: platformHeaders });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error('HTTP ' + res.status + ' em platform/document');
          result.push(...(data.documents || []));
          nextPage = data.nextPageKey || null;
          if (nextPage) await sleep(200);
        } while (nextPage);
        return result;
      } catch (err) {
        const status = err.message.match(/HTTP (\d+)/)?.[1];
        if (status === '403' || status === '404') {
          console.log('[DynaInventory] NOTEBOOKS nao disponivel (HTTP ' + status + ').');
          return [];
        }
        console.error('[DynaInventory] Erro em NOTEBOOKS:', err.message);
        return [];
      }
    },
    // ── Platform API — Automation (Bearer) ────────────────────────────────
    // Requer: automation:workflows:read / automation:rules:read / automation:calendars:read

    fetchAutomationWorkflows: async () => {
      try {
        if (!tenantMongoId) return [];
        const platformAuth = await getBearerForTenant(tenantMongoId);
        if (!platformAuth) return [];
        const platformHeaders = { Authorization: platformAuth.header, Accept: 'application/json' };
        const result = [];
        let nextPage = null;
        do {
          const url = new URL(platformTenant + '/platform/automation/v1/workflows');
          url.searchParams.set('page-size', '100');
          if (nextPage) url.searchParams.set('page-key', nextPage);
          const res = await fetch(url.toString(), { headers: platformHeaders });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error('HTTP ' + res.status + ' em automation/workflows');
          result.push(...(data.results || data.workflows || []));
          nextPage = data.nextPageKey || null;
          if (nextPage) await sleep(200);
        } while (nextPage);
        return result;
      } catch (err) {
        const status = err.message.match(/HTTP (\d+)/)?.[1];
        if (status === '403' || status === '404') {
          console.log('[DynaInventory] AUTOMATION_WORKFLOWS nao disponivel (HTTP ' + status + ').');
          return [];
        }
        console.error('[DynaInventory] Erro em AUTOMATION_WORKFLOWS:', err.message);
        return [];
      }
    },

    fetchAutomationRules: async () => {
      try {
        if (!tenantMongoId) return [];
        const platformAuth = await getBearerForTenant(tenantMongoId);
        if (!platformAuth) return [];
        const platformHeaders = { Authorization: platformAuth.header, Accept: 'application/json' };
        const result = [];
        let nextPage = null;
        do {
          const url = new URL(platformTenant + '/platform/automation/v1/rules');
          url.searchParams.set('page-size', '100');
          if (nextPage) url.searchParams.set('page-key', nextPage);
          const res = await fetch(url.toString(), { headers: platformHeaders });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error('HTTP ' + res.status + ' em automation/rules');
          result.push(...(data.results || data.rules || []));
          nextPage = data.nextPageKey || null;
          if (nextPage) await sleep(200);
        } while (nextPage);
        return result;
      } catch (err) {
        const status = err.message.match(/HTTP (\d+)/)?.[1];
        if (status === '403' || status === '404') {
          console.log('[DynaInventory] AUTOMATION_RULES nao disponivel (HTTP ' + status + ').');
          return [];
        }
        console.error('[DynaInventory] Erro em AUTOMATION_RULES:', err.message);
        return [];
      }
    },

    fetchAutomationCalendars: async () => {
      try {
        if (!tenantMongoId) return [];
        const platformAuth = await getBearerForTenant(tenantMongoId);
        if (!platformAuth) return [];
        const platformHeaders = { Authorization: platformAuth.header, Accept: 'application/json' };
        const result = [];
        let nextPage = null;
        do {
          const url = new URL(platformTenant + '/platform/automation/v1/calendars');
          url.searchParams.set('page-size', '100');
          if (nextPage) url.searchParams.set('page-key', nextPage);
          const res = await fetch(url.toString(), { headers: platformHeaders });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error('HTTP ' + res.status + ' em automation/calendars');
          result.push(...(data.results || data.calendars || []));
          nextPage = data.nextPageKey || null;
          if (nextPage) await sleep(200);
        } while (nextPage);
        return result;
      } catch (err) {
        const status = err.message.match(/HTTP (\d+)/)?.[1];
        if (status === '403' || status === '404') {
          console.log('[DynaInventory] AUTOMATION_CALENDARS nao disponivel (HTTP ' + status + ').');
          return [];
        }
        console.error('[DynaInventory] Erro em AUTOMATION_CALENDARS:', err.message);
        return [];
      }
    },

    fetchSyntheticMonitors: () => apiFetch('/api/v1/synthetic/monitors').then((d) => d.monitors || []),
    fetchAlertingProfiles: v1Config('/api/config/v1/alertingProfiles', 'values'),
    fetchAutoTagRules: v1Config('/api/config/v1/autoTags', 'values'),
    fetchManagementZones: v1Config('/api/config/v1/managementZones', 'values'),
    fetchMaintenanceWindows: v1Config('/api/config/v1/maintenanceWindows', 'values'),
    fetchNotifications: v1Config('/api/config/v1/notifications', 'values'),
    fetchRequestAttributes,
    fetchCalculatedMetrics,
    fetchAnomalyMetricEvents,
    fetchConditionalNaming,
    fetchWebApplications,
    fetchMobileApplications,
    // V2
    fetchActiveGates,
    fetchActiveGateTokens,
    fetchApiTokens,
    fetchAttacks,
    fetchExtensions,
    fetchNetworkZones,
    fetchDatabaseServices,
    //fetchProblems,
    fetchSecurityProblems,
    fetchSlo,
    fetchSyntheticLocations,
    fetchReleases,
    fetchCredentials,
    fetchOneAgents,
    //fetchEvents,
    fetchMetricDescriptors,
  };
}

// ---------------------------------------------------------------------------
// ENTITY TYPES
// ---------------------------------------------------------------------------
const ENTITY_TYPES = [
  'HOST', 'PROCESS_GROUP', 'SERVICE', 'APPLICATION',
  'KUBERNETES_CLUSTER', 'KUBERNETES_NODE',
  'CLOUD_APPLICATION', 'CLOUD_APPLICATION_NAMESPACE',
  'DISK', 'NETWORK_INTERFACE', 'SYNTHETIC_TEST', 'CUSTOM_DEVICE',
];

// ---------------------------------------------------------------------------
// CONFIG FETCHERS
// ---------------------------------------------------------------------------
const CONFIG_FETCHERS = [
  { key: 'DATABASE_SERVICE', fnName: 'fetchDatabaseServices' },
  { key: 'DASHBOARDS_CLASSIC', fnName: 'fetchAllDashboards' },
  { key: 'DASHBOARDS_GEN3', fnName: 'fetchDashboardsGen3' },
  { key: 'NOTEBOOKS', fnName: 'fetchNotebooks' },
  { key: 'AUTOMATION_WORKFLOWS', fnName: 'fetchAutomationWorkflows' },
  { key: 'AUTOMATION_RULES', fnName: 'fetchAutomationRules' },
  { key: 'AUTOMATION_CALENDARS', fnName: 'fetchAutomationCalendars' },
  { key: 'ALERTING_PROFILES', fnName: 'fetchAlertingProfiles' },
  { key: 'AUTO_TAG_RULES', fnName: 'fetchAutoTagRules' },
  { key: 'MANAGEMENT_ZONES', fnName: 'fetchManagementZones' },
  { key: 'MAINTENANCE_WINDOWS', fnName: 'fetchMaintenanceWindows' },
  { key: 'NOTIFICATIONS', fnName: 'fetchNotifications' },
  { key: 'REQUEST_ATTRIBUTES', fnName: 'fetchRequestAttributes' },
  { key: 'CALCULATED_METRICS', fnName: 'fetchCalculatedMetrics' },
  { key: 'ANOMALY_METRIC_EVENTS', fnName: 'fetchAnomalyMetricEvents' },
  { key: 'CONDITIONAL_NAMING', fnName: 'fetchConditionalNaming' },
  { key: 'WEB_APPLICATIONS', fnName: 'fetchWebApplications' },
  { key: 'MOBILE_APPLICATIONS', fnName: 'fetchMobileApplications' },
  { key: 'SYNTHETIC_MONITORS', fnName: 'fetchSyntheticMonitors' },
  { key: 'SYNTHETIC_LOCATIONS', fnName: 'fetchSyntheticLocations' },
  { key: 'ACTIVE_GATES', fnName: 'fetchActiveGates' },
  { key: 'ACTIVE_GATE_TOKENS', fnName: 'fetchActiveGateTokens' },
  { key: 'NETWORK_ZONES', fnName: 'fetchNetworkZones' },
  { key: 'ONE_AGENTS', fnName: 'fetchOneAgents' },
  { key: 'SLO', fnName: 'fetchSlo' },
  { key: 'SECURITY_PROBLEMS', fnName: 'fetchSecurityProblems' },
  { key: 'RELEASES', fnName: 'fetchReleases' },
  { key: 'ATTACKS', fnName: 'fetchAttacks' },
  { key: 'EXTENSIONS', fnName: 'fetchExtensions' },
  { key: 'METRIC_DESCRIPTORS', fnName: 'fetchMetricDescriptors' },
  { key: 'API_TOKENS', fnName: 'fetchApiTokens' },
  { key: 'CREDENTIALS', fnName: 'fetchCredentials' },
];

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
function buildSummary(inventory, noiseLog) {
  let total = 0, totalNoise = 0;
  const rows = [];
  for (const [category, items] of Object.entries(inventory)) {
    const count = Array.isArray(items) ? items.length : 0;
    const noise = noiseLog[category] || 0;
    total += count;
    totalNoise += noise;
    rows.push({ category, count, filtered: noise });
  }
  return { rows, total, totalFiltered: totalNoise };
}

// ---------------------------------------------------------------------------
// FUNÇÃO PRINCIPAL
// ---------------------------------------------------------------------------
async function runInventory(tenantDoc, onProgress = null) {
  const validation = await validateTenant(tenantDoc.baseUrl, tenantDoc.apiToken);
  if (!validation.ok) {
    const err = new Error(validation.error || 'Falha na validação do tenant.');
    err.code = 'TENANT_VALIDATION_FAILED';
    err.validation = validation;
    throw err;
  }

  const resolvedUrl = validation.baseUrlUsed;
  const urlWasCorrected = resolvedUrl !== tenantDoc.baseUrl.replace(/\/$/, '');
  const api = createApiClient(resolvedUrl, tenantDoc.apiToken, String(tenantDoc._id));

  const inventory = {};
  const noiseLog = {};
  const totalSteps = ENTITY_TYPES.length + CONFIG_FETCHERS.length;
  let step = 0;

  const notify = (label) => {
    step++;
    if (onProgress) onProgress({ step, label, done: step, total: totalSteps });
  };

  for (const type of ENTITY_TYPES) {
    try {
      const raw = await api.fetchAllEntities(type);
      const { filtered, removed } = applyNoiseFilter(type, raw);
      inventory[type] = filtered;
      noiseLog[type] = removed;
    } catch (err) {
      inventory[type] = [];
      noiseLog[type] = 0;
      console.error(`[DynaInventory] Erro em ${type}: ${err.message}`);
    }
    notify(type);
    await api.sleep(150);
  }

  for (const { key, fnName } of CONFIG_FETCHERS) {
    try {
      inventory[key] = await api[fnName]();
    } catch (err) {
      inventory[key] = [];
      console.error(`[DynaInventory] Erro em ${key}: ${err.message}`);
    }
    notify(key);
    await api.sleep(150);
  }

  const mzMap = buildManagementZoneCrossRef(inventory);
  const managementZones = {};
  for (const [zone, cats] of mzMap.entries()) managementZones[zone] = cats;

  return {
    inventory,
    noiseLog,
    managementZones,
    summary: buildSummary(inventory, noiseLog),
    executedAt: new Date().toISOString(),
    resolvedUrl,
    urlWasCorrected,
  };
}

module.exports = { runInventory, validateTenant };