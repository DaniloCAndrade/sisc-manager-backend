/**
 * dynaLicenseService.js
 *
 * Cliente para a Account Management API do Dynatrace (Dynatrace Platform
 * Subscription API). Diferente da versão anterior: NÃO gera mais o próprio
 * token OAuth2 — o svc-platform-control já resolve e cacheia o bearer por
 * credencial (mesmo padrão usado pro Documents API). Aqui só recebemos
 * { accountUuid, authHeader } prontos e fazemos as chamadas.
 *
 * Endpoints confirmados manualmente (via curl) antes de implementar:
 *   GET /sub/v2/accounts/{uuid}/subscriptions                 → lista de subscriptions (projetos)
 *   GET /sub/v2/accounts/{uuid}/subscriptions/{uuid}           → detalhe: budget.total/used, período
 *   GET /sub/v3/accounts/{uuid}/subscriptions/{uuid}/environments/cost  → custo por ambiente/dia
 *   GET /sub/v3/accounts/{uuid}/subscriptions/{uuid}/environments/usage → uso por ambiente/dia
 *
 * ⚠️ v2 de .../environments/cost e .../environments/usage estão DEPRECIADOS
 * no Swagger oficial — por isso usamos v3 para esses dois especificamente,
 * mantendo v2 para /subscriptions e /subscriptions/{uuid} (não têm v3).
 */

const BASE_URL = 'https://api.dynatrace.com';

async function apiFetch(accountUuid, authHeader, path, params = {}) {
    const url = new URL(`${BASE_URL}${path.replace('{accountUuid}', accountUuid)}`);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    const res = await fetch(url.toString(), {
        headers: { Authorization: authHeader },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} em ${path}: ${body}`);
    }

    return res.json();
}

/** Lista todas as subscriptions (projetos) de UMA conta. */
function listSubscriptions(accountUuid, authHeader) {
    return apiFetch(accountUuid, authHeader, `/sub/v2/accounts/{accountUuid}/subscriptions`);
}

/** Detalhe de uma subscription — inclui budget.total/used, período, capabilities. */
function getSubscription(accountUuid, authHeader, subscriptionUuid) {
    return apiFetch(accountUuid, authHeader, `/sub/v2/accounts/{accountUuid}/subscriptions/${subscriptionUuid}`);
}

/** Custo por ambiente/dia dentro de uma subscription — usado no detalhamento diário. */
function getEnvironmentCost(accountUuid, authHeader, subscriptionUuid, startTime, endTime) {
    return apiFetch(
        accountUuid, authHeader,
        `/sub/v3/accounts/{accountUuid}/subscriptions/${subscriptionUuid}/environments/cost`,
        { startTime, endTime }
    );
}

/** Uso (não-monetário) por ambiente/dia — útil para capacidades não medidas em R$. */
function getEnvironmentUsage(accountUuid, authHeader, subscriptionUuid, startTime, endTime) {
    return apiFetch(
        accountUuid, authHeader,
        `/sub/v3/accounts/{accountUuid}/subscriptions/${subscriptionUuid}/environments/usage`,
        { startTime, endTime }
    );
}

module.exports = {
    listSubscriptions,
    getSubscription,
    getEnvironmentCost,
    getEnvironmentUsage,
};