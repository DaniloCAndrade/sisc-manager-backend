/**
 * dynaInventoryExport.js
 * Usa o template TPL_11_LEVANTAMENTO_DE_INVENTÁRIO_01.docx
 * Substitui todo o body mantendo o sectPr original (headers/footers/margens)
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const TEMPLATE_PATH = path.join(__dirname, 'template_inventory.docx');

// ── Metadata ──────────────────────────────────────────────────────
const HIDDEN_CATEGORIES = new Set(['PROBLEMS', 'EVENTS']);

const CATEGORY_META = {
  HOST: { label: 'Hosts', group: 'Entidades' },
  SERVICE: { label: 'Services', group: 'Entidades' },
  APPLICATION: { label: 'Applications', group: 'Entidades' },
  PROCESS_GROUP: { label: 'Process Groups', group: 'Entidades' },
  KUBERNETES_CLUSTER: { label: 'K8s Clusters', group: 'Entidades' },
  KUBERNETES_NODE: { label: 'K8s Nodes', group: 'Entidades' },
  CLOUD_APPLICATION: { label: 'Cloud Apps', group: 'Entidades' },
  CLOUD_APPLICATION_NAMESPACE: { label: 'Namespaces', group: 'Entidades' },
  DISK: { label: 'Disks', group: 'Entidades' },
  NETWORK_INTERFACE: { label: 'Network Interfaces', group: 'Entidades' },
  SYNTHETIC_TEST: { label: 'Synthetic Tests', group: 'Entidades' },
  CUSTOM_DEVICE: { label: 'Custom Devices', group: 'Entidades' },
  DATABASE_SERVICE: { label: 'Database Services', group: 'Entidades' },
  DASHBOARDS_CLASSIC: { label: 'Dashboards (Classic)', group: 'Dashboards' },
  DASHBOARDS_GEN3: { label: 'Dashboards (Gen3)', group: 'Dashboards' },
  NOTEBOOKS: { label: 'Notebooks', group: 'Dashboards' },
  AUTOMATION_WORKFLOWS: { label: 'Workflows', group: 'Automação' },
  AUTOMATION_RULES: { label: 'Regras de Automação', group: 'Automação' },
  AUTOMATION_CALENDARS: { label: 'Calendários', group: 'Automação' },
  WEB_APPLICATIONS: { label: 'Web Applications', group: 'Configurações' },
  MOBILE_APPLICATIONS: { label: 'Mobile Applications', group: 'Configurações' },
  ALERTING_PROFILES: { label: 'Alerting Profiles', group: 'Configurações' },
  AUTO_TAG_RULES: { label: 'Auto Tag Rules', group: 'Configurações' },
  MANAGEMENT_ZONES: { label: 'Management Zones', group: 'Configurações' },
  MAINTENANCE_WINDOWS: { label: 'Maint. Windows', group: 'Configurações' },
  NOTIFICATIONS: { label: 'Notifications', group: 'Configurações' },
  REQUEST_ATTRIBUTES: { label: 'Request Attributes', group: 'Configurações' },
  CALCULATED_METRICS: { label: 'Calculated Metrics', group: 'Configurações' },
  ANOMALY_METRIC_EVENTS: { label: 'Anomaly Metric Events', group: 'Configurações' },
  CONDITIONAL_NAMING: { label: 'Conditional Naming', group: 'Configurações' },
  SYNTHETIC_MONITORS: { label: 'Synthetic Monitors', group: 'Synthetic' },
  SYNTHETIC_LOCATIONS: { label: 'Synthetic Locations', group: 'Synthetic' },
  ACTIVE_GATES: { label: 'ActiveGates', group: 'Infraestrutura' },
  ACTIVE_GATE_TOKENS: { label: 'ActiveGate Tokens', group: 'Infraestrutura' },
  NETWORK_ZONES: { label: 'Network Zones', group: 'Infraestrutura' },
  ONE_AGENTS: { label: 'OneAgents', group: 'Infraestrutura' },
  SLO: { label: 'SLOs', group: 'Observabilidade' },
  SECURITY_PROBLEMS: { label: 'Security Problems', group: 'Observabilidade' },
  RELEASES: { label: 'Releases', group: 'Observabilidade' },
  ATTACKS: { label: 'Attacks (30d)', group: 'Observabilidade' },
  EXTENSIONS: { label: 'Extensions', group: 'Extensões' },
  METRIC_DESCRIPTORS: { label: 'Custom Metrics', group: 'Extensões' },
  API_TOKENS: { label: 'API Tokens', group: 'Segurança' },
  CREDENTIALS: { label: 'Credentials Vault', group: 'Segurança' },
};

const GROUPS = [
  { key: 'Entidades', label: 'Entidades Monitoradas' },
  { key: 'Automação', label: 'Automação' },
  { key: 'Dashboards', label: 'Dashboards' },
  { key: 'Configurações', label: 'Configurações' },
  { key: 'Synthetic', label: 'Synthetic Monitoring' },
  { key: 'Infraestrutura', label: 'Infraestrutura' },
  { key: 'Observabilidade', label: 'Observabilidade' },
  { key: 'Extensões', label: 'Extensões & Métricas' },
  { key: 'Segurança', label: 'Segurança & Acesso' },
];

// ── XML helpers ───────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function run(text, opts = {}) {
  const { bold = false, color = '595959', size = 20, italic = false } = opts;
  return `<w:r><w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/><w:iCs/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text, opts = {}) {
  const { style = 'NoSpacing', align = '', spacing = '', pageBreakBefore = false, ...runOpts } = opts;
  const alignXml = align ? `<w:jc w:val="${align}"/>` : '';
  const spXml = spacing ? `<w:spacing ${spacing}/>` : '';
  const pbXml = pageBreakBefore ? '<w:pageBreakBefore/>' : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${spXml}${pbXml}${alignXml}</w:pPr>${run(text, runOpts)}</w:p>`;
}

function heading1(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function heading2(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function emptyPara() {
  return '<w:p><w:pPr><w:pStyle w:val="NoSpacing"/></w:pPr></w:p>';
}

function pageBreak() {
  return '<w:p><w:pPr><w:pStyle w:val="NoSpacing"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
}

function table(headers, rows, colWidths) {
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  const gridCols = colWidths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
  const border = `<w:top w:val="single" w:sz="4" w:color="D1D5DB"/><w:start w:val="single" w:sz="4" w:color="D1D5DB"/><w:bottom w:val="single" w:sz="4" w:color="D1D5DB"/><w:end w:val="single" w:sz="4" w:color="D1D5DB"/><w:insideH w:val="single" w:sz="4" w:color="D1D5DB"/><w:insideV w:val="single" w:sz="4" w:color="D1D5DB"/>`;

  function tcell(text, w, isHeader = false, bg = 'FFFFFF') {
    const fill = isHeader ? 'DBEAFE' : bg;
    const bold = isHeader ? '<w:b/><w:bCs/>' : '';
    const color = isHeader ? '1E40AF' : '374151';
    const sz = isHeader ? 18 : 20;
    return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:start w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:end w:w="120" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:pStyle w:val="NoSpacing"/></w:pPr><w:r><w:rPr>${bold}<w:color w:val="${color}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
  }

  const headerRow = `<w:tr><w:trPr><w:trHeight w:val="320"/><w:tblHeader/></w:trPr>${headers.map((h, i) => tcell(h, colWidths[i], true)).join('')}</w:tr>`;
  const dataRows = rows.map((row, ri) => {
    const bg = ri % 2 === 1 ? 'F9FAFB' : 'FFFFFF';
    return `<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>${row.map((cell, ci) => tcell(String(cell ?? '—'), colWidths[ci], false, bg)).join('')}</w:tr>`;
  }).join('');

  return `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${headerRow}${dataRows}</w:tbl>`;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return String(iso); }
}

// ── Corpo do documento ────────────────────────────────────────────
function buildBody(inventoryResult, tenantDoc) {
  const { summary, managementZones, inventory, executedAt } = inventoryResult;
  const tenantLabel = tenantDoc.label ?? tenantDoc.nome ?? 'Tenant';
  const tenantName = tenantDoc.nome ?? tenantLabel;
  const parts = [];
  let secNum = 1;

  // Página de conteúdo começa após page break
  parts.push(pageBreak());
  parts.push(para(`Tenant: ${tenantName}  |  Label: ${tenantLabel}  |  Gerado em: ${formatDate(executedAt)}`, { color: '6B7280', size: 18, align: 'center', spacing: 'w:after="200"' }));
  parts.push(emptyPara());

  const visibleRows = summary.rows.filter(r => !HIDDEN_CATEGORIES.has(r.category));
  const totalVisible = visibleRows.reduce((s, r) => s + r.count, 0);

  // ── Sumário Executivo ──────────────────────────────────────────
  parts.push(heading1(`${secNum++}. Sumário Executivo`));
  parts.push(para(`Total de objetos inventariados: ${totalVisible.toLocaleString('pt-BR')}${summary.totalFiltered > 0 ? `  (${summary.totalFiltered} filtrados por ruído K8s)` : ''}`, { bold: true, color: '1D4ED8', size: 22 }));
  parts.push(emptyPara());

  const summaryRows = visibleRows.filter(r => r.count > 0);
  if (summaryRows.length > 0) {
    parts.push(table(
      ['Categoria', 'Grupo', 'Quantidade'],
      summaryRows.map(r => [
        CATEGORY_META[r.category]?.label ?? r.category,
        CATEGORY_META[r.category]?.group ?? '—',
        r.count.toLocaleString('pt-BR'),
      ]),
      [4500, 2500, 2026]
    ));
  }
  parts.push(emptyPara());

  // ── Seções por grupo ───────────────────────────────────────────
  for (const group of GROUPS) {
    const groupRows = summary.rows.filter(r =>
      CATEGORY_META[r.category]?.group === group.key &&
      !HIDDEN_CATEGORIES.has(r.category) &&
      r.count > 0
    );
    if (!groupRows.length) continue;

    const groupTotal = groupRows.reduce((s, r) => s + r.count, 0);
    parts.push(heading1(`${secNum++}. ${group.label}`));
    parts.push(para(`${groupTotal.toLocaleString('pt-BR')} objeto${groupTotal !== 1 ? 's' : ''} encontrado${groupTotal !== 1 ? 's' : ''}`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(table(
      ['Categoria', 'Quantidade'],
      groupRows.map(r => [CATEGORY_META[r.category]?.label ?? r.category, r.count.toLocaleString('pt-BR')]),
      [7000, 2026]
    ));
    parts.push(emptyPara());

    // Detalhe API Tokens
    if (group.key === 'Segurança' && inventory.API_TOKENS?.length > 0) {
      parts.push(heading2('Detalhe: API Tokens'));
      parts.push(table(
        ['Nome', 'Proprietário', 'Status', 'Criado em', 'Último uso'],
        inventory.API_TOKENS.map(t => [
          t.name ?? '—', t.owner ?? '—',
          t.enabled !== false ? 'Ativo' : 'Inativo',
          t.creationDate ? formatDate(t.creationDate) : '—',
          t.lastUsedDate ? formatDate(t.lastUsedDate) : 'Nunca',
        ]),
        [2400, 1800, 1000, 2000, 1826]
      ));
      parts.push(emptyPara());
    }
  }

  // ── Management Zones ───────────────────────────────────────────
  const zoneNames = Object.keys(managementZones).sort((a, b) => {
    if (a === '(sem Management Zone)') return 1;
    if (b === '(sem Management Zone)') return -1;
    return a.localeCompare(b);
  });

  if (zoneNames.length > 0) {
    parts.push(heading1(`${secNum++}. Distribuição por Management Zone`));
    parts.push(para(`${zoneNames.filter(z => z !== '(sem Management Zone)').length} Management Zone(s) configurada(s)`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(table(
      ['Management Zone', 'Total de Entidades'],
      zoneNames.map(zone => {
        const total = Object.values(managementZones[zone]).reduce((s, arr) => s + arr.length, 0);
        return [zone, total.toLocaleString('pt-BR')];
      }),
      [7000, 2026]
    ));
  }

  return parts.join('\n');
}

// ── Gerador principal ─────────────────────────────────────────────
async function generateInventoryDocx(inventoryResult, tenantDoc) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template não encontrado: ${TEMPLATE_PATH}`);
  }

  const zip = new AdmZip(TEMPLATE_PATH);
  let docXml = zip.readAsText('word/document.xml');

  const tenantLabel = tenantDoc.label ?? tenantDoc.nome ?? 'Tenant';
  const dataStr = formatDate(inventoryResult.executedAt);

  // ── Substitui placeholders da capa ────────────────────────────
  docXml = docXml.replace(/Nome do Cliente/g, esc(tenantLabel));
  docXml = docXml.replace(/Nome do cliente/g, esc(tenantLabel));

  // Substitui "nome do tenant" que pode estar fragmentado em múltiplos <w:r>
  // Estratégia: substituir no texto plano extraído dos runs
  docXml = docXml.replace(/nome do tenant/g, esc(tenantLabel));

  // Substitui placeholder de data (pode estar fragmentado também)
  docXml = docXml.replace(/dd\/mm\/aaaa, hh:mm/g, dataStr);
  docXml = docXml.replace(/00\/00\/0000, 00h00/g, dataStr);

  // ── Substitui o corpo (após capa) ─────────────────────────────
  // Encontra o início do primeiro Heading1 (início do conteúdo pós-capa)
  // e substitui tudo até o sectPr pelo conteúdo gerado
  const sectPrMatch = docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  const sectPr = sectPrMatch ? sectPrMatch[0] : '';

  // Encontra o primeiro heading1 (início do conteúdo de template)
  const h1Idx = docXml.indexOf('<w:pStyle w:val="Heading1"');

  if (h1Idx !== -1 && sectPr) {
    // Retrocede para o início do <w:p> que contém esse heading
    const paraStart = docXml.lastIndexOf('<w:p ', h1Idx);
    const before = docXml.substring(0, paraStart);
    const bodyContent = buildBody(inventoryResult, tenantDoc);

    docXml = `${before}\n${bodyContent}\n<w:p><w:pPr><w:pStyle w:val="NoSpacing"/>${sectPr}</w:pPr></w:p>\n</w:body>\n</w:document>`;
  } else {
    // Fallback: substitui body inteiro
    const bodyStart = docXml.indexOf('<w:body>') + '<w:body>'.length;
    const bodyContent = buildBody(inventoryResult, tenantDoc);
    docXml = docXml.substring(0, bodyStart) + '\n' + bodyContent + (sectPr ? `\n<w:p><w:pPr>${sectPr}</w:pPr></w:p>` : '') + '\n</w:body>\n</w:document>';
  }

  zip.updateFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
  try { zip.deleteFile('[trash]/0000.dat'); } catch { }
  try { zip.deleteFile('[trash]/0001.dat'); } catch { }

  return zip.toBuffer();
}

module.exports = { generateInventoryDocx };