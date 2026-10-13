/**
 * dynaFetch.js
 * Helper centralizado para chamadas à API Dynatrace.
 *
 * Tenta .live.dynatrace.com primeiro. Se der erro de REDE (não de auth),
 * faz fallback para .apps.dynatrace.com.
 *
 * Cache em memória por 5 minutos por baseUrl.
 */

const DNS_ERROR_CODES = new Set([
    'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ERR_NETWORK', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function isNetworkError(err) {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    const code = err.cause?.code || err.code || '';
    return (
        DNS_ERROR_CODES.has(code) ||
        err.name === 'AbortError' ||                    // AbortSignal.timeout()
        msg.includes('aborted') ||                      // "The operation was aborted due to timeout"
        msg.includes('timed out') ||
        msg.includes('timeout') ||
        msg.includes('fetch failed') ||
        msg.includes('enotfound') ||
        msg.includes('econnrefused') ||
        msg.includes('network error') ||
        msg.includes('failed to fetch') ||
        (err instanceof TypeError && msg === 'fetch failed')
    );
}

function toAppsUrl(url) {
    return url.replace('.live.dynatrace.com', '.apps.dynatrace.com');
}

function toLiveUrl(url) {
    return url.replace('.apps.dynatrace.com', '.live.dynatrace.com');
}

const _cache = new Map(); // baseUrl → { url, expiresAt }

/**
 * Resolve qual variante da URL funciona na rede atual.
 * Usa /api/v2/time como probe — endpoint que retorna 200 sem auth,
 * perfeito para testar conectividade sem depender do token.
 */
async function resolveBaseUrl(baseUrl, _apiToken) {
    const normalized = baseUrl.replace(/\/$/, '');

    const cached = _cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.url;
    }

    const candidates = [
        toLiveUrl(normalized),   // tenta .live. primeiro
        toAppsUrl(normalized),   // fallback .apps.
    ];

    for (const candidate of candidates) {
        try {
            // /api/v2/time retorna 200 sem precisar de token — ideal para probe de rede
            const res = await fetch(`${candidate}/api/v2/time`, {
                method: 'GET',
                signal: AbortSignal.timeout(6000),
            });

            // Qualquer resposta HTTP (mesmo 401/403/404) = servidor acessível
            console.log(`[dynaFetch] ${candidate} acessível (HTTP ${res.status})`);
            _cache.set(normalized, { url: candidate, expiresAt: Date.now() + 5 * 60_000 });
            return candidate;

        } catch (err) {
            if (isNetworkError(err)) {
                console.warn(`[dynaFetch] ${candidate} inacessível via rede (${err.cause?.code || err.message}) — tentando alternativa`);
                continue;
            }
            // Erro inesperado não-rede: tratar como acessível
            console.warn(`[dynaFetch] ${candidate} erro inesperado (${err.message}) — assumindo acessível`);
            _cache.set(normalized, { url: candidate, expiresAt: Date.now() + 5 * 60_000 });
            return candidate;
        }
    }

    console.error(`[dynaFetch] Nenhuma URL acessível para ${normalized} — usando original`);
    return normalized;
}

/**
 * Wrapper de fetch com resolução automática de URL.
 */
async function dynaFetch(baseUrl, path, options = {}, apiToken = null) {
    const resolvedBase = await resolveBaseUrl(baseUrl, apiToken);
    return fetch(`${resolvedBase}${path}`, options);
}

/**
 * Invalida o cache de um tenant (útil quando baseUrl muda).
 */
function invalidateCache(baseUrl) {
    _cache.delete(baseUrl.replace(/\/$/, ''));
}

module.exports = { dynaFetch, resolveBaseUrl, invalidateCache };