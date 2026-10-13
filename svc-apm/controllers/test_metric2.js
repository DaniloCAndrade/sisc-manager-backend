/**
 * test_metric2.js
 * Testa :names e entitySelector para builtin:service.keyRequest.dbChildCallCount
 */

const ENV_ID = 'tgp11329';
const BASE_URL = `https://${ENV_ID}.live.dynatrace.com`;
const API_TOKEN = process.argv[2];

if (!API_TOKEN) {
    console.error('Uso: node test_metric2.js <apiToken>');
    process.exit(1);
}

const FROM = '2026-05-01T00:00:00.000-03:00';
const TO = '2026-05-31T23:59:59.999-03:00';

const candidates = [
    // Com :names para resolver nome legível
    'builtin:service.keyRequest.dbChildCallCount:splitBy("dt.entity.service_method"):sort(value(sum,descending)):limit(15):names',
    // Filtrado por serviço portal via entitySelector
    'builtin:service.keyRequest.dbChildCallCount:filter(in("dt.entity.service",entitySelector("type(service),tag(~"portal:~")"))):splitBy("dt.entity.service_method"):sort(value(sum,descending)):limit(15):names',
    // Split por service E service_method juntos (para saber qual serviço cada request pertence)
    'builtin:service.keyRequest.dbChildCallCount:splitBy("dt.entity.service","dt.entity.service_method"):sort(value(sum,descending)):limit(15):names',
];

async function testSelector(selector) {
    const qs = new URLSearchParams({ metricSelector: selector, from: FROM, to: TO, resolution: 'Inf' });
    const url = `${BASE_URL}/api/v2/metrics/query?${qs}`;

    try {
        const res = await fetch(url, { headers: { Authorization: `Api-Token ${API_TOKEN}` } });
        const data = await res.json();

        if (!res.ok) {
            console.log(`✗ [${res.status}] ${selector.slice(0, 90)}`);
            console.log(`    ${data.error?.message?.slice(0, 200)}`);
            return;
        }

        const series = data.result?.[0]?.data ?? [];
        console.log(`✓ [200] ${selector.slice(0, 90)}`);
        console.log(`    ${series.length} séries`);
        series.slice(0, 5).forEach(s => {
            const total = (s.values ?? []).filter(v => v !== null).reduce((a, b) => a + b, 0);
            console.log(`    dimensionMap: ${JSON.stringify(s.dimensionMap)} | total: ${total}`);
        });
    } catch (err) {
        console.log(`✗ ERRO ${selector.slice(0, 90)}: ${err.message}`);
    }
}

async function main() {
    for (const c of candidates) {
        await testSelector(c);
        console.log();
    }
}

main();