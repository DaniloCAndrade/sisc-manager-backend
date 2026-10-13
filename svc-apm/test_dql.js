/**
 * test_dql.js
 * Testa DQL via /platform/storage/query/v1 com Bearer OAuth
 * 
 * Uso: node test_dql.js <bearerToken>
 * Obtenha o bearer atual via: GET /api/dynatrace/platform-credentials/resolve-bearer/<tenantId>
 */

const axios = require('axios');

const ENV_ID = 'tgp11329';
const BASE_URL = `https://${ENV_ID}.apps.dynatrace.com`;
const API_TOKEN = process.argv[2]; // Bearer token como argumento

if (!API_TOKEN) {
    console.error('Uso: node test_dql.js <bearerToken>');
    process.exit(1);
}

const QUERY = [
    'fetch dt.davis.problems',
    '| filter matchesValue(k8s.namespace.name, { "portal-prod" })',
    '  OR matchesValue(entityAttr(dt.entity.application, "entity.name"), "portal.detran.df.gov.br")',
    '| filter resolved_problem_duration > duration(15, "min")',
    '| summarize by:{event.name}, count()',
    '| sort `count()` desc',
].join('\n');

async function pollResults(requestToken) {
    const pollUrl = `${BASE_URL}/platform/storage/query/v1/query:poll`;
    while (true) {
        const res = await axios.get(pollUrl, {
            params: { requestToken },
            headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' },
        });
        console.log('Poll state:', res.data.state);
        if (res.data.state === 'SUCCEEDED' || res.data.result?.records) {
            return res.data.result?.records ?? [];
        }
        if (res.data.state === 'FAILED') throw new Error('DQL query failed');
        await new Promise(r => setTimeout(r, 1500));
    }
}

async function main() {
    console.log('Testando DQL em:', BASE_URL);
    console.log('Bearer (primeiros 30 chars):', API_TOKEN.slice(0, 30) + '...');
    console.log('Query:', QUERY.slice(0, 100) + '...\n');

    try {
        const res = await axios.post(
            `${BASE_URL}/platform/storage/query/v1/query:execute`,
            {
                query: QUERY,
                defaultTimeframeStart: '2026-05-01T00:00:00.000-03:00',
                defaultTimeframeEnd: '2026-05-31T23:59:59.999-03:00',
                requestTimeoutMilliseconds: 60000,
            },
            {
                headers: {
                    Authorization: `Bearer ${API_TOKEN}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            }
        );

        console.log('HTTP Status:', res.status);
        console.log('Response state:', res.data.state);

        let records = res.data.result?.records ?? res.data.records;

        if (!records && res.data.requestToken) {
            console.log('Polling com requestToken:', res.data.requestToken);
            records = await pollResults(res.data.requestToken);
        }

        if (records) {
            console.log(`\n✓ ${records.length} registros retornados:`);
            records.forEach(r => console.log(' -', r['event.name'], '→', r['count()']));
        } else {
            console.log('Resposta completa:', JSON.stringify(res.data, null, 2));
        }

    } catch (err) {
        console.error('ERRO HTTP:', err.response?.status);
        console.error('Body:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    }
}

main();