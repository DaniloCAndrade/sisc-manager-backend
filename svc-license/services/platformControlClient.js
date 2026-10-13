/**
 * platformControlClient.js
 * Cliente HTTP interno para o svc-platform-control — mesmo padrão usado
 * pelo svc-inventory (SERVICE_API_KEY, service-to-service).
 */

const BASE_URL = (process.env.PLATFORM_CONTROL_URL || 'http://localhost:3002').replace(/\/$/, '');
const SERVICE_KEY = process.env.SERVICE_API_KEY || '';

function serviceHeaders(extra = {}) {
    return {
        'Content-Type': 'application/json',
        'x-service-key': SERVICE_KEY,
        ...extra,
    };
}

/**
 * Lista todas as contas Dynatrace (uma por credencial de licenciamento
 * cadastrada) já com o bearer/auth header resolvido pelo svc-platform-control.
 * Retorna: [{ credentialId, nome, tenant: {id,nome,label}|null, accountUuid, authHeader }]
 */
async function listLicenseAccounts() {
    const res = await fetch(`${BASE_URL}/api/dynatrace/platform-credentials/license-accounts`, {
        headers: serviceHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] listLicenseAccounts HTTP ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.accounts ?? [];
}

/**
 * Lista todos os tenants (baseUrl + apiToken + quotas Classic) — usa o
 * endpoint já existente GET /api/dynaTenant, sem precisar de nada novo no
 * svc-platform-control.
 */
async function listTenants() {
    const res = await fetch(`${BASE_URL}/api/dynaTenant`, {
        headers: serviceHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] listTenants HTTP ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.data ?? [];
}

module.exports = { listLicenseAccounts, listTenants };