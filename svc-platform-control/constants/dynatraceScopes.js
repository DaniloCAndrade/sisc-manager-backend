/**
 * dynatraceScopes.js
 * Constantes centralizadas de scopes OAuth2 do Dynatrace.
 *
 * Uso:
 *   const { SCOPES_GRAIL, SCOPES_PLATFORM, SCOPES_ALL } = require('./dynatraceScopes');
 *   const scope = SCOPES_ALL.join(' ');
 */

// ── Grail / DQL ───────────────────────────────────────────────────
// Necessários para executar queries DQL via /platform/storage/query/v1
const SCOPES_GRAIL = [
    'storage:logs:read',
    'storage:events:read',
    'storage:metrics:read',
    'storage:bizevents:read',
    'storage:system:read',
    'storage:buckets:read',
    'storage:bucket-definitions:read',
    'storage:fieldset-definitions:read',
    'storage:spans:read',
    'storage:entities:read',
    'storage:smartscape:read',
    'storage:fieldsets:read',
    'storage:user.events:read',
    'storage:user.sessions:read',
    'storage:user.replays:read',
    'storage:security.events:read',
    'storage:filter-segments:read',
];

// ── Documents API ─────────────────────────────────────────────────
// Necessários para acessar notebooks, dashboards e documentos
const SCOPES_DOCUMENTS = [
    'document:documents:read',
    'document:environment-shares:read',
    'document:direct-shares:read',
    'document:trash.documents:read',
];

// ── Automation ────────────────────────────────────────────────────
const SCOPES_AUTOMATION = [
    'automation:workflows:read',
    'automation:rules:read',
    'automation:calendars:read',
];

// ── Settings / Extensions ─────────────────────────────────────────
const SCOPES_SETTINGS = [
    'settings:objects:read',
    'settings:schemas:read',
    'extensions:definitions:read',
    'extensions:configurations:read',
];

// ── Davis / AI ────────────────────────────────────────────────────
const SCOPES_DAVIS = [
    'davis:analyzers:read',
    'davis-copilot:nl2dql:execute',
    'davis-copilot:dql2nl:execute',
    'davis-copilot:document-search:execute',
];

// ── Platform / State ──────────────────────────────────────────────
const SCOPES_PLATFORM = [
    'state:app-states:read',
    'state:user-app-states:read',
    'platform-management:environments:read',
    'hub:catalog:read',
    'notification:notifications:read',
    'slo:slos:read',
    'slo:objective-templates:read',
    'vulnerability-service:vulnerabilities:read',
    'mcp-gateway:servers:read',
];

// ── Account ───────────────────────────────────────────────────────
const SCOPES_ACCOUNT = [
    'account-env-read',
    'account-uac-read',
    'account-audit-logs-read',
];

// ── Account Management API — Licenciamento (svc-license) ──────────
// Escopo mínimo confirmado manualmente via curl para a Dynatrace
// Platform Subscription API (/sub/v2/accounts/.../subscriptions/...)
const SCOPES_LICENSE = [
    'account-uac-read',
];

// ── Conjuntos compostos ───────────────────────────────────────────

/** Apenas o mínimo para inventário (Documents + Grail) */
const SCOPES_INVENTORY = [
    ...SCOPES_DOCUMENTS,
    ...SCOPES_GRAIL,
];

/** Usado pelos relatórios APM (Grail DQL + métricas) */
const SCOPES_REPORTS = [
    ...SCOPES_GRAIL,
    ...SCOPES_DOCUMENTS,
    ...SCOPES_AUTOMATION,
];

/** Todos os scopes de environment — usado para gerar o bearer token */
const SCOPES_ALL = [
    ...SCOPES_GRAIL,
    ...SCOPES_DOCUMENTS,
    ...SCOPES_AUTOMATION,
    ...SCOPES_SETTINGS,
    ...SCOPES_DAVIS,
    ...SCOPES_PLATFORM,
];

/**
 * Scopes mínimos para relatórios APM — subconjunto seguro.
 * Use este se SCOPES_ALL causar invalid_request no OAuth.
 */
const SCOPES_REPORTS_MINIMAL = [
    // Grail / DQL — essencial para queries
    'storage:logs:read',
    'storage:events:read',
    'storage:metrics:read',
    'storage:entities:read',
    'storage:user.sessions:read',
    'storage:user.events:read',
    'storage:smartscape:read',
    'storage:buckets:read',
    'storage:filter-segments:read',
    // Documents
    'document:documents:read',
    // Automation
    'automation:workflows:read',
    'automation:rules:read',
    'automation:calendars:read',
    // Settings
    'settings:objects:read',
    'settings:schemas:read',
];

module.exports = {
    // Grupos individuais
    SCOPES_GRAIL,
    SCOPES_DOCUMENTS,
    SCOPES_AUTOMATION,
    SCOPES_SETTINGS,
    SCOPES_DAVIS,
    SCOPES_PLATFORM,
    SCOPES_ACCOUNT,
    SCOPES_LICENSE,
    // Conjuntos compostos
    SCOPES_INVENTORY,
    SCOPES_REPORTS,
    SCOPES_REPORTS_MINIMAL,
    SCOPES_ALL,
};