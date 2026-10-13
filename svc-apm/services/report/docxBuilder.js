/**
 * docxBuilder.js
 * Gera o relatório APM em .docx usando AdmZip + XML direto.
 *
 * ── ALTERAÇÕES NESTA VERSÃO ────────────────────────────────────────────────
 * - Seção "Banco de Dados" REMOVIDA (vira relatório próprio).
 * - Alertas: adicionado gráfico de colunas por dia, além da pizza por tipo.
 * - Latência: rótulo atualizado para p95.
 * - UX reestruturado em subseções (Apdex / Sessões / Rage Click / Taxa de
 *   Rejeição / Sazonalidade / Geolocalização / Dispositivos / Navegadores),
 *   com gráfico de linha diário para o Apdex e tabela Top 10 para Geolocalização.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'controllers', 'report', 'template_apm.docx')
const CHART_W = 1400;
const CHART_H = 640;
const chartCanvas = new ChartJSNodeCanvas({
    width: CHART_W,
    height: CHART_H,
    backgroundColour: 'white',
    chartCallback: (ChartJS) => {
        ChartJS.defaults.font.size = 22;
    },
});

const COLORS = ['#D70233', '#1E3A8A', '#059669', '#D97706', '#7C3AED', '#0891B2', '#BE185D', '#065F46'];

const COLORS_20 = [
    '#E11D48', '#2563EB', '#16A34A', '#EA580C', '#9333EA',
    '#0D9488', '#CA8A04', '#DB2777', '#0891B2', '#65A30D',
    '#7C3AED', '#DC2626', '#0284C7', '#D97706', '#059669',
    '#C026D3', '#4F46E5', '#84CC16', '#BE123C', '#0E7490',
];

// ── Gráficos ────────────────────────────────────────────────────

async function multiLineChartPng({ timestamps, series }, title, isTimeAxis = false) {
    if (!timestamps?.length || !series?.length) return null;

    const labels = timestamps.map(ts => {
        const d = new Date(ts);
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    });

    const yCallbackTime = (value) => {
        if (value >= 60_000_000) return (value / 60_000_000).toFixed(0) + ' min';
        if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + ' s';
        if (value >= 1_000) return (value / 1_000).toFixed(0) + ' ms';
        return value.toFixed(0) + ' µs';
    };
    const yCallbackCount = (value) => {
        if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
        if (value >= 1_000) return (value / 1_000).toFixed(0) + 'k';
        return String(value);
    };

    return chartCanvas.renderToBuffer({
        type: 'line',
        data: {
            labels,
            datasets: series.map((s, i) => ({
                label: s.name.length > 16 ? s.name.slice(0, 16) + '…' : s.name,
                data: s.values,
                borderColor: COLORS_20[i % COLORS_20.length],
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.25,
                // pointRadius pequeno (não 0): séries com pico isolado em um único
                // bucket — comum em pods de build/batch, que só existem por horas
                // no mês — ficavam INVISÍVEIS com pointRadius 0, já que uma linha
                // exige 2 pontos conectados; um marcador garante que o pico apareça.
                pointRadius: 1.5,
                borderWidth: 1.25,
                spanGaps: true,
            })),
        },
        options: {
            plugins: {
                title: { display: !!title, text: title, font: { size: 26 } },
                legend: {
                    display: true, position: 'bottom',
                    labels: { font: { size: 16 }, boxWidth: 16, padding: 10 },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: (v) => (isTimeAxis ? yCallbackTime(v) : yCallbackCount(v)), font: { size: 18 } },
                },
                x: { ticks: { maxTicksLimit: 12, autoSkip: true, font: { size: 18 } } },
            },
        },
    });
}

// Gráfico de linha simples (uma série), usado para o Apdex diário (escala 0–1)
async function singleLineChartPng({ timestamps, values }, title) {
    if (!timestamps?.length || !values?.length) return null;

    const labels = timestamps.map(ts => {
        const d = new Date(ts);
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    });

    return chartCanvas.renderToBuffer({
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Apdex',
                data: values,
                borderColor: COLORS[1],
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.25,
                pointRadius: 2,
                borderWidth: 2,
                spanGaps: true,
            }],
        },
        options: {
            plugins: {
                title: { display: !!title, text: title, font: { size: 26 } },
                legend: { display: false },
            },
            scales: {
                y: { min: 0, max: 1, ticks: { font: { size: 18 } } },
                x: { ticks: { maxTicksLimit: 12, autoSkip: true, font: { size: 18 } } },
            },
        },
    });
}

async function barChartPng(labels, values, title) {
    return chartCanvas.renderToBuffer({
        type: 'bar',
        data: {
            labels: labels.map(l => l.length > 22 ? l.slice(-22) : l),
            datasets: [{ data: values, backgroundColor: COLORS[0], borderRadius: 3 }],
        },
        options: {
            plugins: { title: { display: !!title, text: title, font: { size: 26 } }, legend: { display: false } },
            scales: { y: { beginAtZero: true } },
        },
    });
}

async function pieChartPng(labels, values, title) {
    return chartCanvas.renderToBuffer({
        type: 'pie',
        data: {
            labels,
            datasets: [{ data: values, backgroundColor: COLORS }],
        },
        options: {
            plugins: { title: { display: !!title, text: title, font: { size: 26 } }, legend: { position: 'right' } },
        },
    });
}

// ── XML helpers ───────────────────────────────────────────────────

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function para(text, opts = {}) {
    const { bold = false, color = '2D3748', size = 22, align = '' } = opts;
    const jc = align ? `<w:jc w:val="${align}"/>` : '';
    return `<w:p>
    <w:pPr><w:pStyle w:val="SemEspaamento"/><w:spacing w:after="120"/>${jc}</w:pPr>
    <w:r>
      <w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>
      <w:t xml:space="preserve">${esc(text)}</w:t>
    </w:r>
  </w:p>`;
}

function h1(text) {
    return `<w:p>
    <w:pPr><w:pStyle w:val="Ttulo1"/><w:spacing w:before="400" w:after="200"/></w:pPr>
    <w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>
  </w:p>`;
}

function h2(text) {
    return `<w:p>
    <w:pPr><w:pStyle w:val="Ttulo2"/><w:spacing w:before="300" w:after="120"/></w:pPr>
    <w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>
  </w:p>`;
}

function h3(text) {
    return `<w:p>
    <w:pPr><w:pStyle w:val="Ttulo3"/><w:spacing w:before="200" w:after="80"/></w:pPr>
    <w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>
  </w:p>`;
}

function empty() {
    return '<w:p><w:pPr><w:pStyle w:val="SemEspaamento"/></w:pPr></w:p>';
}

function pageBreak() {
    return '<w:p><w:pPr><w:pStyle w:val="SemEspaamento"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
}

function imagePara(rId, widthEmu = 6120000, heightEmu = 2800000, imgId = 100) {
    return `<w:p>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr>
    <w:r><w:rPr/><w:drawing>
      <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
        <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:docPr id="${imgId}" name="chart_${imgId}"/>
        <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:nvPicPr>
                <pic:cNvPr id="${imgId}" name="chart_${imgId}"/>
                <pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr>
              </pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing></w:r>
  </w:p>`;
}

function simpleTable(headers, rows) {
    const colW = Math.floor(9026 / headers.length);
    const border = `<w:top w:val="single" w:sz="4" w:color="D1D5DB"/>
    <w:start w:val="single" w:sz="4" w:color="D1D5DB"/>
    <w:bottom w:val="single" w:sz="4" w:color="D1D5DB"/>
    <w:end w:val="single" w:sz="4" w:color="D1D5DB"/>
    <w:insideH w:val="single" w:sz="4" w:color="D1D5DB"/>
    <w:insideV w:val="single" w:sz="4" w:color="D1D5DB"/>`;

    const cell = (text, isHeader, bg) => `<w:tc>
    <w:tcPr>
      <w:tcW w:w="${colW}" w:type="dxa"/>
      <w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>
      <w:tcMar><w:top w:w="80" w:type="dxa"/><w:start w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:end w:w="120" w:type="dxa"/></w:tcMar>
    </w:tcPr>
    <w:p><w:pPr><w:pStyle w:val="SemEspaamento"/></w:pPr>
      <w:r><w:rPr>${isHeader ? '<w:b/><w:bCs/>' : ''}<w:color w:val="${isHeader ? '1E40AF' : '595959'}"/><w:sz w:val="${isHeader ? 18 : 20}"/><w:szCs w:val="${isHeader ? 18 : 20}"/></w:rPr>
        <w:t xml:space="preserve">${esc(text)}</w:t>
      </w:r>
    </w:p>
  </w:tc>`;

    const hRow = `<w:tr><w:trPr><w:trHeight w:val="320"/><w:tblHeader/></w:trPr>${headers.map(h => cell(h, true, 'DBEAFE')).join('')}</w:tr>`;
    const dRows = rows.map((row, ri) =>
        `<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>${row.map(c => cell(c, false, ri % 2 === 0 ? 'FFFFFF' : 'F9FAFB')).join('')}</w:tr>`
    ).join('');

    return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9026" w:type="dxa"/>
      <w:tblBorders>${border}</w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>${headers.map(() => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>
    ${hRow}${dRows}
  </w:tbl>`;
}

// ── Formatadores ──────────────────────────────────────────────────

function fmtNum(n) { return typeof n === 'number' ? n.toLocaleString('pt-BR') : '—'; }
function fmtPct(n) { return typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : '—'; }
function fmtUs(n) {
    if (typeof n !== 'number') return '—';
    if (n >= 60_000_000) return `${(n / 60_000_000).toFixed(1)} min`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} s`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)} ms`;
    return `${n.toFixed(0)} µs`;
}
function periodLabel(from, to) {
    const fmt = s => { const [y, m, d] = s.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
    return `${fmt(from)} a ${fmt(to)}`;
}
function apdexLabel(v) {
    if (v === null) return 'N/D';
    if (v >= 0.94) return `${v} — Excelente`;
    if (v >= 0.85) return `${v} — Bom`;
    if (v >= 0.70) return `${v} — Tolerante`;
    return `${v} — Ruim`;
}

// ── Construção de seção ───────────────────────────────────────────

async function buildSectionXml(sData, images) {
    const parts = [];
    const pushImg = (buf, w = 6120000, h = 2800000) => {
        if (!buf) return;
        const rId = `rId${images.length + 200}`;
        images.push({ rId, buf });
        parts.push(imagePara(rId, w, h, images.length + 199));
    };

    parts.push(h2(sData.label));

    // ── 2. Alertas ────────────────────────────────────────────────
    parts.push(h3('Alertas'));
    parts.push(para(`Neste período foram identificados ${fmtNum(sData.alertas.total)} alertas com duração superior a 15 minutos.`));
    if (sData.alertas.byType.length > 0) {
        const buf = await pieChartPng(
            sData.alertas.byType.map(a => a.name),
            sData.alertas.byType.map(a => a.count),
            'Distribuição de Alertas por Tipo'
        );
        pushImg(buf);
        parts.push(simpleTable(
            ['Tipo', 'Ocorrências', '%'],
            sData.alertas.byType.map(a => [a.name, fmtNum(a.count), `${a.pct}%`])
        ));
        parts.push(empty());
    }
    if (sData.alertas.byDay?.length > 0) {
        const buf = await barChartPng(
            sData.alertas.byDay.map(d => d.label),
            sData.alertas.byDay.map(d => d.count),
            'Total de Alertas por Dia'
        );
        pushImg(buf);
        parts.push(empty());
    }

    // ── 3. Performance de Aplicação ──────────────────────────────
    parts.push(h3('Análise de Performance de Aplicação'));

    const perfMetrics = [
        ['Tráfego', 'Volume de requisições por serviço ao longo do período.', sData.performance.trafico, sData.performance.traficoSerie, fmtNum, false],
        ['Latência (p95)', 'Tempo de resposta p95 por serviço ao longo do período.', sData.performance.latencia, sData.performance.latenciaSerie, fmtUs, true],
        ['Erros 4xx', 'Erros de cliente por serviço ao longo do período.', sData.performance.erros4xx, sData.performance.erros4xxSerie, fmtNum, false],
        ['Erros 5xx', 'Erros de servidor por serviço ao longo do período.', sData.performance.erros5xx, sData.performance.erros5xxSerie, fmtNum, false],
    ];

    for (const [titulo, desc, porServico, serieMulti, fmtFn, isTimeAxis] of perfMetrics) {
        parts.push(para(titulo, { bold: true }));
        parts.push(para(desc));

        if (serieMulti?.series?.length > 0) {
            const buf = await multiLineChartPng(serieMulti, titulo, isTimeAxis);
            pushImg(buf);
        } else {
            parts.push(para('Sem dados disponíveis para este período.', { color: '9CA3AF' }));
        }

        if (porServico.length > 0) {
            parts.push(para('Top serviços:', { bold: true, size: 20 }));
            parts.push(simpleTable(
                ['Serviço', 'Total'],
                porServico.slice(0, 10).map(s => [s.name, fmtFn(s.total)])
            ));
        }
        parts.push(empty());
    }

    // ── 5. Infraestrutura ────────────────────────────────────────
    parts.push(h3('Visão Geral de Infraestrutura'));
    for (const [titulo, dados, serie] of [
        ['CPU Média (%)', sData.infra.cpuAvg, sData.infra.cpuAvgSerie],
        ['CPU Máxima (%)', sData.infra.cpuMax, sData.infra.cpuMaxSerie],
        ['Memória (%)', sData.infra.memory, sData.infra.memorySerie],
    ]) {
        parts.push(para(titulo, { bold: true }));
        if (dados.length > 0) {
            if (serie?.series?.length > 0) {
                const buf = await multiLineChartPng(serie, titulo, false);
                pushImg(buf);
            }
            parts.push(simpleTable(
                ['Container Group', '%'],
                dados.map(s => [s.name, fmtNum(Number(s.total.toFixed(2)))])
            ));
            parts.push(empty());
        } else {
            parts.push(para('Sem dados disponíveis.', { color: '9CA3AF' }));
        }
        parts.push(empty());
    }

    // ── 6. Experiência do Usuário ────────────────────────────────
    parts.push(h3('Visão de Experiência de Usuário'));

    // 6.1 Apdex
    parts.push(para('Apdex', { bold: true, size: 24 }));
    parts.push(para(`Apdex do período: ${apdexLabel(sData.ux.apdex)}`));
    if (sData.ux.apdexSerie?.timestamps?.length > 0) {
        const buf = await singleLineChartPng(sData.ux.apdexSerie, 'Apdex — Classificação Dia a Dia');
        pushImg(buf);
    }
    parts.push(empty());

    // 6.2 Sessões de Usuário
    parts.push(para('Sessões de Usuário', { bold: true, size: 24 }));
    parts.push(para(`Total de Sessões: ${fmtNum(sData.ux.sessoes)}`));
    parts.push(empty());

    // 6.2.1 Rage Click
    if (sData.ux.rageClicks !== null) {
        parts.push(para('Rage Click', { bold: true, size: 20 }));
        parts.push(para(`Total de Rage Clicks: ${fmtNum(sData.ux.rageClicks)}`));
        parts.push(empty());
    }

    // 6.2.2 Taxa de Rejeição
    if (sData.ux.bounceRate !== null) {
        parts.push(para('Taxa de Rejeição', { bold: true, size: 20 }));
        parts.push(para(`Taxa de Rejeição (bounce rate): ${fmtPct(sData.ux.bounceRate)}`));
        parts.push(empty());
    }

    // 6.3 Sazonalidade
    if (sData.ux.sazonalidade.iniciadas.length > 0 || sData.ux.sazonalidade.ativas.length > 0) {
        parts.push(para('Sazonalidade de Acessos', { bold: true, size: 24 }));
        if (sData.ux.sazonalidade.iniciadas.length > 0) {
            parts.push(para('Top 3 Horários — Sessões Iniciadas:', { bold: true, size: 20 }));
            parts.push(simpleTable(['Horário', 'Sessões'], sData.ux.sazonalidade.iniciadas.map(s => [s.label, fmtNum(s.value)])));
            parts.push(empty());
        }
        if (sData.ux.sazonalidade.ativas.length > 0) {
            parts.push(para('Top 3 Horários — Sessões Ativas:', { bold: true, size: 20 }));
            parts.push(simpleTable(['Horário', 'Sessões'], sData.ux.sazonalidade.ativas.map(s => [s.label, fmtNum(s.value)])));
            parts.push(empty());
        }
    }

    // 6.4 Geolocalização
    if (sData.ux.geolocalizacao.length > 0) {
        parts.push(para('Geolocalização', { bold: true, size: 24 }));
        const buf = await barChartPng(
            sData.ux.geolocalizacao.map(g => g.estado),
            sData.ux.geolocalizacao.map(g => g.acoes),
            'Ações por Estado (Brasil)'
        );
        pushImg(buf);
        parts.push(para('Top 10 Estados:', { bold: true, size: 20 }));
        parts.push(simpleTable(
            ['Estado', 'Ações'],
            sData.ux.geolocalizacao.slice(0, 10).map(g => [g.estado, fmtNum(g.acoes)])
        ));
        parts.push(empty());
    }

    // 6.5 Dispositivos
    if (sData.ux.devices?.length > 0) {
        parts.push(para('Dispositivos', { bold: true, size: 24 }));
        const buf = await pieChartPng(
            sData.ux.devices.map(d => d.label),
            sData.ux.devices.map(d => d.count),
            'Sessões por Tipo de Dispositivo'
        );
        pushImg(buf);
        parts.push(simpleTable(
            ['Dispositivo', 'Sessões', '%'],
            sData.ux.devices.map(d => [d.label, fmtNum(d.count), `${d.pct}%`])
        ));
        parts.push(empty());
    }

    // 6.6 Navegadores
    if (sData.ux.browsers?.length > 0) {
        parts.push(para('Navegadores', { bold: true, size: 24 }));
        const buf = await pieChartPng(
            sData.ux.browsers.map(b => b.label),
            sData.ux.browsers.map(b => b.count),
            'Ações por Navegador'
        );
        pushImg(buf);
        parts.push(simpleTable(
            ['Navegador', 'Ações', '%'],
            sData.ux.browsers.map(b => [b.label, fmtNum(b.count), `${b.pct}%`])
        ));
        parts.push(empty());
    }

    if (sData.ux.crashes?.length) {
        parts.push(para('Crashes por OS e Versão:', { bold: true }));
        parts.push(simpleTable(['OS', 'Versão', 'Crashes'], sData.ux.crashes.map(c => [c.os, c.versao, fmtNum(c.crashes)])));
        parts.push(empty());
    }

    return parts.join('\n');
}

// ── Gerador principal ─────────────────────────────────────────────

async function buildDocx({ config, sectionsData, from, to, res }) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
        console.warn('[docxBuilder] template_apm.docx não encontrado — usando docx mínimo');
        return buildDocxMinimal({ config, sectionsData, from, to, res });
    }

    const period = periodLabel(from, to);
    const images = [];

    const bodyParts = [];
    bodyParts.push(`<w:p><w:pPr><w:pStyle w:val="SemEspaamento"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>`);
    bodyParts.push(para(`${config.label}  |  Período: ${period}  |  Gerado em: ${new Date().toLocaleDateString('pt-BR')}`, { color: '6B7280', size: 18, align: 'center' }));
    bodyParts.push(empty());
    bodyParts.push(h1('1. Introdução'));
    bodyParts.push(para(`Este relatório apresenta os indicadores de monitoramento da aplicação ${config.label} no período de ${period}.`));
    bodyParts.push(empty());

    for (let i = 0; i < sectionsData.length; i++) {
        try {
            const xml = await buildSectionXml(sectionsData[i], images);
            bodyParts.push(xml);
        } catch (err) {
            console.error('[docxBuilder] buildSectionXml erro:', err.message);
            bodyParts.push(para(`Erro ao gerar seção ${sectionsData[i]?.label}: ${err.message}`, { color: 'D70233' }));
        }
    }

    bodyParts.push(pageBreak());
    bodyParts.push(h1('Conclusão'));
    bodyParts.push(para(`A aplicação ${config.label} foi monitorada durante o período de ${period}. A equipe de observabilidade da Very Tecnologia continuará acompanhando os indicadores.`));

    const zip = new AdmZip(TEMPLATE_PATH);
    let docXml = zip.readAsText('word/document.xml');

    docXml = docXml
        .replace('Nota Técnica - Análise Dynatrace', `Relatório APM — ${esc(config.label)}`)
        .replace('TPL01 – SISC – NOTA TECNICA', `Período: ${period}`);

    const firstHeadingIdx = docXml.indexOf('<w:pStyle w:val="Ttulo1"');
    if (firstHeadingIdx !== -1) {
        const paraStart = docXml.lastIndexOf('<w:p ', firstHeadingIdx);
        const before = docXml.substring(0, paraStart);
        const sectPrMatch = docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g);
        const lastSectPr = sectPrMatch ? sectPrMatch[sectPrMatch.length - 1] : '';
        docXml = `${before}\n${bodyParts.join('\n')}\n<w:p><w:pPr>${lastSectPr}</w:pPr></w:p>\n</w:body>\n</w:document>`;
    }

    let relsXml = zip.readAsText('word/_rels/document.xml.rels');
    const relsClose = '</Relationships>';
    const newRels = images.map(({ rId, buf }, i) => {
        const imgName = `media/apm_chart_${i}.png`;
        zip.addFile(`word/${imgName}`, buf);
        return `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${imgName}"/>`;
    }).join('\n');
    relsXml = relsXml.replace(relsClose, `${newRels}\n${relsClose}`);

    zip.updateFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
    zip.updateFile('word/_rels/document.xml.rels', Buffer.from(relsXml, 'utf-8'));

    const buf = zip.toBuffer();
    res.end(buf);
}

async function buildDocxMinimal({ config, sectionsData, from, to, res }) {
    const period = periodLabel(from, to);
    const images = [];
    const bodyParts = [];

    bodyParts.push(h1(`Relatório APM — ${config.label}`));
    bodyParts.push(para(`Período: ${period}`));
    bodyParts.push(empty());

    for (const sData of sectionsData) {
        try {
            bodyParts.push(await buildSectionXml(sData, images));
        } catch (e) {
            console.error('[docxBuilder] buildSectionXml erro:', e.message);
        }
    }

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const imgRels = images.map(({ rId }, i) =>
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/apm_chart_${i}.png"/>`
    ).join('\n');

    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${imgRels}
</Relationships>`;

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
  mc:Ignorable="w14 wpc wpg wps">
  <w:body>
    ${bodyParts.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf-8'));
    zip.addFile('_rels/.rels', Buffer.from(rels, 'utf-8'));
    zip.addFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(docRels, 'utf-8'));
    images.forEach(({ buf }, i) => zip.addFile(`word/media/apm_chart_${i}.png`, buf));

    res.end(zip.toBuffer());
}

module.exports = { buildDocx };