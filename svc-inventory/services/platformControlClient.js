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

/**
 * Busca a lista simplificada de todos os tenants cadastrados
 * (usa GET /api/dynaTenant/simples, já existente no svc-platform-control).
 */
async function listTenants() {
    const res = await fetch(`${BASE_URL}/api/dynaTenant/simples`, {
        headers: serviceHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] listTenants HTTP ${res.status}: ${body}`);
    }

    const json = await res.json();
    return json.data ?? json; // [{ _id, nome, tenantId }, ...]
}

// ---------------------------------------------------------------------------
// Estado/cache do inventário — persistido no svc-platform-control (Mongo)
// em vez de Map() em memória, pra ficar consistente entre réplicas do
// svc-inventory.
// ---------------------------------------------------------------------------

const INVENTORY_STATE_BASE = `${BASE_URL}/api/dynatrace/inventory-state`;

/**
 * Inicia (ou reinicia) o job de inventário de um tenant. Crítico — se isso
 * falhar, o controller deve considerar a operação como não iniciada.
 */
async function startInventoryJob(tenantId) {
    const res = await fetch(`${INVENTORY_STATE_BASE}/${tenantId}/start`, {
        method: 'POST',
        headers: serviceHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] startInventoryJob HTTP ${res.status}: ${body}`);
    }

    return res.json();
}

/**
 * Atualiza o progresso do job em andamento. NÃO crítico — uma falha aqui
 * não deve interromper a coleta em si, só loga e segue.
 */
async function updateInventoryProgress(tenantId, progress) {
    try {
        const res = await fetch(`${INVENTORY_STATE_BASE}/${tenantId}/progress`, {
            method: 'PATCH',
            headers: serviceHeaders(),
            body: JSON.stringify(progress),
        });

        if (!res.ok) {
            const body = await res.text();
            console.error(`[platformControlClient] updateInventoryProgress HTTP ${res.status}: ${body}`);
        }
    } catch (err) {
        console.error('[platformControlClient] updateInventoryProgress erro:', err.message);
    }
}

/**
 * Marca o job como concluído e persiste o resultado completo (o
 * svc-platform-control se encarrega de comprimir antes de salvar). Crítico
 * — se isso falhar (ex: 413 payload grande demais mesmo comprimido), o
 * controller precisa saber, pra não reportar sucesso ao frontend sem o
 * resultado de fato ter sido salvo em algum lugar consistente.
 */
async function completeInventoryJob(tenantId, result) {
    const res = await fetch(`${INVENTORY_STATE_BASE}/${tenantId}/complete`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify({ result }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] completeInventoryJob HTTP ${res.status}: ${body}`);
    }

    return res.json();
}

/**
 * Marca o job como erro (ex: falha de validação do tenant, exceção não
 * tratada durante a coleta). Não relança — se até isso falhar, só loga;
 * já estamos dentro de um caminho de tratamento de erro.
 */
async function failInventoryJob(tenantId, message, validation = null) {
    try {
        const res = await fetch(`${INVENTORY_STATE_BASE}/${tenantId}/fail`, {
            method: 'POST',
            headers: serviceHeaders(),
            body: JSON.stringify({ message, validation }),
        });

        if (!res.ok) {
            const body = await res.text();
            console.error(`[platformControlClient] failInventoryJob HTTP ${res.status}: ${body}`);
        }
    } catch (err) {
        console.error('[platformControlClient] failInventoryJob erro:', err.message);
    }
}

/**
 * Status/progresso atual do job (leve — não inclui o resultado completo).
 * Retorna { status: 'idle' } por padrão em caso de falha de rede, pra o
 * polling do frontend não travar numa exceção — ele já sabe lidar com
 * 'idle' tentando de novo.
 */
async function getInventoryState(tenantId) {
    try {
        const res = await fetch(`${INVENTORY_STATE_BASE}/${tenantId}/status`, {
            headers: serviceHeaders(),
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`HTTP ${res.status}: ${body}`);
        }

        return res.json();
    } catch (err) {
        console.error('[platformControlClient] getInventoryState erro:', err.message);
        throw err; // deixa o controller decidir (ele tem contexto pra responder 5xx corretamente)
    }
}

/**
 * Resultado completo do último inventário em cache (descomprimido pelo
 * svc-platform-control antes de devolver). Retorna null se não houver
 * cache — mesmo padrão de getTenantById/getBearerForTenant.
 */
async function getInventoryResult(tenantId) {
    const res = await fetch(`${INVENTORY_STATE_BASE}/${tenantId}/result`, {
        headers: serviceHeaders(),
    });

    if (res.status === 404) return null;

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] getInventoryResult HTTP ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data; // { success, cachedAt, result }
}

/**
 * Invalida o job/cache de um tenant.
 */
async function clearInventoryState(tenantId) {
    const res = await fetch(`${INVENTORY_STATE_BASE}/${tenantId}`, {
        method: 'DELETE',
        headers: serviceHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[platformControlClient] clearInventoryState HTTP ${res.status}: ${body}`);
    }
}

module.exports = {
    getTenantById,
    getBearerForTenant,
    updateTenantBaseUrl,
    listTenants,
    startInventoryJob,
    updateInventoryProgress,
    completeInventoryJob,
    failInventoryJob,
    getInventoryState,
    getInventoryResult,
    clearInventoryState,
};