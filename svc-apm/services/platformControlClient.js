/**
 * platformControlClient.js
 * Cliente HTTP interno para o svc-platform-control.
 * Usa SERVICE_API_KEY para autenticação service-to-service.
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
 * Busca um tenant pelo _id do MongoDB.
 */
async function getTenantById(tenantId) {
    const res = await fetch(`${BASE_URL}/api/dynaTenant/${tenantId}`, {
        headers: serviceHeaders(),
    });

    if (res.status === 404) return null;

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] getTenantById HTTP ${res.status}: ${body}`);
    }

    const json = await res.json();
    return json.data ?? json;
}

/**
 * Obtém o Bearer token OAuth2 para um tenant via svc-platform-control.
 */
async function getBearerForTenant(tenantId) {
    try {
        const res = await fetch(
            `${BASE_URL}/api/dynatrace/platform-credentials/resolve-bearer/${tenantId}`,
            { headers: serviceHeaders() }
        );

        if (res.status === 404) {
            console.log(`[platformControlClient] Nenhuma credencial de plataforma para tenant ${tenantId}.`);
            return null;
        }

        if (!res.ok) {
            const body = await res.text();
            console.error(`[platformControlClient] getBearerForTenant HTTP ${res.status}: ${body}`);
            return null;
        }

        const data = await res.json();
        if (!data.header) return null;

        return { header: data.header };
    } catch (err) {
        console.error('[platformControlClient] getBearerForTenant erro:', err.message);
        return null;
    }
}

/**
 * Atualiza o baseUrl de um tenant.
 */
async function updateTenantBaseUrl(tenantId, newBaseUrl) {
    const res = await fetch(`${BASE_URL}/api/dynaTenant/${tenantId}/baseUrl`, {
        method: 'PATCH',
        headers: serviceHeaders(),
        body: JSON.stringify({ baseUrl: newBaseUrl }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] updateTenantBaseUrl HTTP ${res.status}: ${body}`);
    }
}

module.exports = { getTenantById, getBearerForTenant, updateTenantBaseUrl };