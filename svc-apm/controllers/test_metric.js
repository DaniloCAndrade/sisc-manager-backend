/**
 * test_metric.js
 * Testa diferentes variações de metricSelector para descobrir
 * a sintaxe correta de splitBy por Request Name (MDA).
 *
 * Uso: node test_metric.js <apiToken>
 */

const ENV_ID = 'tgp11329';
const BASE_URL = `https://${ENV_ID}.live.dynatrace.com`;
const API_TOKEN = process.argv[2];

if (!API_TOKEN) {
    console.error('Uso: node test_metric.js <apiToken>');
    process.exit(1);
}

const FROM = '2026-05-01T00:00:00.000-03:00';
const TO = '2026-05-31T23:59:59.999-03:00';

// Candidatos de sintaxe para splitBy por Request Name
const candidates = [
    'builtin:service.dbChildCallCount:splitBy("dt.entity.service"):sort(value(sum,descending)):limit(10)',
    'builtin:service.dbChildCallCount:splitBy("dt.entity.service","Request"):sort(value(sum,descending)):limit(10)',
    'builtin:service.dbChildCallCount:splitBy("dt.entity.service","request.name"):sort(value(sum,descending)):limit(10)',
    'builtin:service.dbChildCallCount:splitBy("dt.entity.service","dt.entity.service_method"):sort(value(sum,descending)):limit(10)',
    'builtin:service.keyRequest.dbChildCallCount:splitBy("dt.entity.service_method"):sort(value(sum,descending)):limit(10)',
];

async function testSelector(selector) {
    const qs = new URLSearchParams({
        metricSelector: selector,
        from: FROM,
        to: TO,
        resolution: 'Inf',
    });
    const url = `${BASE_URL}/api/v2/metrics/query?${qs}`;

    try {
        const res = await fetch(url, {
            headers: { Authorization: `Api-Token ${API_TOKEN}` },
        });
        const data = await res.json();

        if (!res.ok) {
            console.log(`✗ [${res.status}] ${selector.slice(0, 70)}`);
            console.log(`    ${data.error?.message?.slice(0, 150)}`);
            return;
        }

        const seriesCount = data.result?.[0]?.data?.length ?? 0;
        const sample = data.result?.[0]?.data?.[0];
        console.log(`✓ [200] ${selector.slice(0, 70)}`);
        console.log(`    ${seriesCount} séries | sample dimensionMap:`, JSON.stringify(sample?.dimensionMap));
    } catch (err) {
        console.log(`✗ ERRO ${selector.slice(0, 70)}: ${err.message}`);
    }
}

async function main() {
    console.log('Testando metricSelectors para builtin:service.dbChildCallCount...\n');
    for (const c of candidates) {
        await testSelector(c);
        console.log();
    }
}

main();