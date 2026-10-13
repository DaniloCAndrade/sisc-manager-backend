/**
 * dynaInventoryExportSpecific.js
 * Templates específicos por relatório — estilos: Heading1, Heading2, NoSpacing
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const TEMPLATE_INFRASTRUCTURE = path.join(__dirname, 'template_infrastructure.docx');
const TEMPLATE_APPLICATIONS = path.join(__dirname, 'template_applications.docx');
const TEMPLATE_DASHBOARDS = path.join(__dirname, 'template_dashboards.docx');

// ── XML helpers ───────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function run(text, opts = {}) {
  const { bold = false, color = '374151', size = 20 } = opts;
  return `<w:r><w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text, opts = {}) {
  const { style = 'NoSpacing', align = '', spacing = '', ...runOpts } = opts;
  const alignXml = align ? `<w:jc w:val="${align}"/>` : '';
  const spXml = spacing ? `<w:spacing ${spacing}/>` : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${spXml}${alignXml}</w:pPr>${run(text, runOpts)}</w:p>`;
}

function heading1(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function heading2(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function emptyPara() { return '<w:p><w:pPr><w:pStyle w:val="NoSpacing"/></w:pPr></w:p>'; }

function pageBreak() {
  return '<w:p><w:pPr><w:pStyle w:val="NoSpacing"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(iso); }
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

// ── Injeção de corpo no template ──────────────────────────────────
async function generateDocx(bodyXml, tenantDoc, templatePath, executedAt) {
  if (!fs.existsSync(templatePath)) throw new Error(`Template não encontrado: ${templatePath}`);

  const zip = new AdmZip(templatePath);
  let docXml = zip.readAsText('word/document.xml');

  const tenantLabel = tenantDoc.label ?? tenantDoc.nome ?? 'Tenant';
  const dataStr = formatDate(executedAt);

  docXml = docXml.replace(/Nome do Cliente/g, esc(tenantLabel));
  docXml = docXml.replace(/Nome do cliente/g, esc(tenantLabel));
  docXml = docXml.replace(/nome do tenant/g, esc(tenantLabel));
  docXml = docXml.replace(/dd\/mm\/aaaa, hh:mm/g, dataStr);
  docXml = docXml.replace(/00\/00\/0000, 00h00/g, dataStr);

  const sectPrMatch = docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  const sectPr = sectPrMatch ? sectPrMatch[0] : '';
  const h1Idx = docXml.indexOf('<w:pStyle w:val="Heading1"');

  if (h1Idx !== -1 && sectPr) {
    const paraStart = docXml.lastIndexOf('<w:p ', h1Idx);
    const before = docXml.substring(0, paraStart);
    docXml = `${before}\n${bodyXml}\n<w:p><w:pPr><w:pStyle w:val="NoSpacing"/>${sectPr}</w:pPr></w:p>\n</w:body>\n</w:document>`;
  } else {
    const bodyStart = docXml.indexOf('<w:body>') + '<w:body>'.length;
    docXml = docXml.substring(0, bodyStart) + '\n' + bodyXml + (sectPr ? `\n<w:p><w:pPr>${sectPr}</w:pPr></w:p>` : '') + '\n</w:body>\n</w:document>';
  }

  zip.updateFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
  try { zip.deleteFile('[trash]/0000.dat'); } catch { }
  try { zip.deleteFile('[trash]/0001.dat'); } catch { }
  return zip.toBuffer();
}

// ── 1. Dashboards & Notebooks ─────────────────────────────────────
function buildDashboardsBody(inventoryResult, tenantDoc) {
  const { inventory, executedAt } = inventoryResult;
  const tenantLabel = tenantDoc.label ?? tenantDoc.nome ?? 'Tenant';
  const parts = [];

  parts.push(pageBreak());
  parts.push(para(`Tenant: ${tenantLabel}  |  Gerado em: ${formatDate(executedAt)}`, { color: '6B7280', size: 18, align: 'center', spacing: 'w:after="200"' }));
  parts.push(emptyPara());

  const classic = inventory.DASHBOARDS_CLASSIC || [];
  const gen3 = inventory.DASHBOARDS_GEN3 || [];
  const notebooks = inventory.NOTEBOOKS || [];
  const total = classic.length + gen3.length + notebooks.length;

  parts.push(heading1('1. Sumário'));
  parts.push(para(`Total: ${total} itens  |  Classic: ${classic.length}  |  Gen3: ${gen3.length}  |  Notebooks: ${notebooks.length}`, { bold: true, color: '1D4ED8', size: 22 }));
  parts.push(emptyPara());

  if (classic.length > 0) {
    parts.push(heading1('2. Dashboards Classic'));
    parts.push(para(`${classic.length} dashboard(s) — formato clássico (API v1)`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(table(['Nome', 'ID'], classic.map(d => [d.name ?? '—', d.id ?? '—']), [6500, 2526]));
    parts.push(emptyPara());
  }

  if (gen3.length > 0) {
    parts.push(heading1('3. Dashboards Gen3'));
    parts.push(para(`${gen3.length} dashboard(s) — novo formato (Documents API)`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(para('Atenção: apenas documentos com visibilidade "Visible to anyone in your environment" ou compartilhados com a conta de serviço são listados.', { color: 'D97706', size: 18, italic: true }));
    parts.push(emptyPara());
    parts.push(table(
      ['Nome', 'Proprietário', 'Privado', 'Versão', 'Última modificação'],
      gen3.map(d => [d.name ?? '—', d.owner ?? '—', d.isPrivate ? 'Sim' : 'Não', String(d.version ?? '—'), d.modificationInfo?.lastModifiedTime ? formatDate(d.modificationInfo.lastModifiedTime) : '—']),
      [2800, 2000, 700, 700, 2826]
    ));
    parts.push(emptyPara());
  }

  if (notebooks.length > 0) {
    parts.push(heading1('4. Notebooks'));
    parts.push(para(`${notebooks.length} notebook(s)`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(para('Atenção: mesma limitação de visibilidade dos Dashboards Gen3.', { color: 'D97706', size: 18, italic: true }));
    parts.push(emptyPara());
    parts.push(table(
      ['Nome', 'Proprietário', 'Privado', 'Versão', 'Última modificação'],
      notebooks.map(n => [n.name ?? '—', n.owner ?? '—', n.isPrivate ? 'Sim' : 'Não', String(n.version ?? '—'), n.modificationInfo?.lastModifiedTime ? formatDate(n.modificationInfo.lastModifiedTime) : '—']),
      [2800, 2000, 700, 700, 2826]
    ));
    parts.push(emptyPara());
  }

  return parts.join('\n');
}

// ── 2. Aplicações ─────────────────────────────────────────────────
function buildApplicationsBody(inventoryResult, tenantDoc) {
  const { inventory, executedAt } = inventoryResult;
  const tenantLabel = tenantDoc.label ?? tenantDoc.nome ?? 'Tenant';
  const parts = [];

  parts.push(pageBreak());
  parts.push(para(`Tenant: ${tenantLabel}  |  Gerado em: ${formatDate(executedAt)}`, { color: '6B7280', size: 18, align: 'center', spacing: 'w:after="200"' }));
  parts.push(emptyPara());

  const webApps = inventory.WEB_APPLICATIONS || [];
  const mobileApps = inventory.MOBILE_APPLICATIONS || [];
  const appEntities = inventory.APPLICATION || [];

  parts.push(heading1('1. Sumário'));
  parts.push(para(`Web Apps: ${webApps.length}  |  Mobile Apps: ${mobileApps.length}  |  Entidades Application: ${appEntities.length}`, { bold: true, color: '1D4ED8', size: 22 }));
  parts.push(emptyPara());

  if (appEntities.length > 0) {
    parts.push(heading1('2. Aplicações Monitoradas'));
    parts.push(para(`${appEntities.length} entidade(s) do tipo APPLICATION`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(table(
      ['Nome', 'Entity ID', 'Management Zone(s)', 'Tags'],
      appEntities.map(a => [
        a.displayName ?? '—', a.entityId ?? '—',
        (a.managementZones || []).map(z => z.name).join(', ') || '—',
        (a.tags || []).map(t => t.key + (t.value ? `:${t.value}` : '')).slice(0, 3).join(', ') || '—',
      ]),
      [2600, 2400, 2200, 1826]
    ));
    parts.push(emptyPara());
  }

  if (webApps.length > 0) {
    parts.push(heading1('3. Web Applications (Config)'));
    parts.push(para(`${webApps.length} configuração(ões) de Web Application`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(table(['Nome', 'ID'], webApps.map(a => [a.name ?? '—', a.id ?? '—']), [6500, 2526]));
    parts.push(emptyPara());
  }

  if (mobileApps.length > 0) {
    parts.push(heading1('4. Mobile Applications (Config)'));
    parts.push(para(`${mobileApps.length} configuração(ões) de Mobile Application`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(table(['Nome', 'ID'], mobileApps.map(a => [a.name ?? '—', a.id ?? '—']), [6500, 2526]));
    parts.push(emptyPara());
  }

  return parts.join('\n');
}

// ── 3. Infraestrutura ─────────────────────────────────────────────
const MONITORING_MODE_LABELS = {
  FULL_STACK: 'Full Stack', INFRASTRUCTURE: 'Infrastructure',
  DEEP_MONITORING: 'Deep Monitoring', DISCOVERY: 'Discovery',
};

function buildInfrastructureBody(inventoryResult, tenantDoc) {
  const { inventory, executedAt } = inventoryResult;
  const tenantLabel = tenantDoc.label ?? tenantDoc.nome ?? 'Tenant';
  const parts = [];

  parts.push(pageBreak());
  parts.push(para(`Tenant: ${tenantLabel}  |  Gerado em: ${formatDate(executedAt)}`, { color: '6B7280', size: 18, align: 'center', spacing: 'w:after="200"' }));
  parts.push(emptyPara());

  const hosts = inventory.HOST || [];
  const clusters = inventory.KUBERNETES_CLUSTER || [];
  const nodes = inventory.KUBERNETES_NODE || [];
  const namespaces = inventory.CLOUD_APPLICATION_NAMESPACE || [];
  const activeGates = inventory.ACTIVE_GATES || [];

  parts.push(heading1('1. Sumário'));
  parts.push(para(`Hosts: ${hosts.length}  |  K8s Clusters: ${clusters.length}  |  K8s Nodes: ${nodes.length}  |  Namespaces: ${namespaces.length}  |  ActiveGates: ${activeGates.length}`, { bold: true, color: '1D4ED8', size: 22 }));
  parts.push(emptyPara());

  if (hosts.length > 0) {
    const byMode = {};
    for (const h of hosts) {
      const mode = h.properties?.monitoringMode || h.monitoringMode || 'UNKNOWN';
      if (!byMode[mode]) byMode[mode] = [];
      byMode[mode].push(h);
    }
    parts.push(heading1('2. Hosts'));
    parts.push(para(`${hosts.length} host(s) monitorado(s)`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(heading2('Distribuição por tipo de monitoramento'));
    parts.push(table(['Tipo de Monitoramento', 'Qtd. Hosts'], Object.entries(byMode).map(([mode, arr]) => [MONITORING_MODE_LABELS[mode] ?? mode, String(arr.length)]), [7000, 2026]));
    parts.push(emptyPara());
    parts.push(heading2('Lista de Hosts'));
    parts.push(table(
      ['Nome', 'Entity ID', 'OS', 'Monitoramento', 'Management Zone(s)', 'Tags'],
      hosts.map(h => [
        h.displayName ?? '—', h.entityId ?? '—',
        h.properties?.osType ?? '—',
        MONITORING_MODE_LABELS[h.properties?.monitoringMode ?? h.monitoringMode] ?? '—',
        (h.managementZones || []).map(z => z.name).join(', ') || '—',
        (h.tags || []).map(t => t.key + (t.value ? `:${t.value}` : '')).slice(0, 2).join(', ') || '—',
      ]),
      [1800, 2000, 900, 1200, 1700, 1426]
    ));
    parts.push(emptyPara());
  }

  if (clusters.length > 0) {
    parts.push(heading1('3. Kubernetes Clusters'));
    parts.push(para(`${clusters.length} cluster(s)  |  ${nodes.length} node(s)  |  ${namespaces.length} namespace(s)`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(heading2('Clusters'));
    parts.push(table(['Nome', 'Entity ID', 'Management Zone(s)'], clusters.map(c => [c.displayName ?? '—', c.entityId ?? '—', (c.managementZones || []).map(z => z.name).join(', ') || '—']), [2800, 3200, 3026]));
    parts.push(emptyPara());

    if (nodes.length > 0) {
      parts.push(heading2(`K8s Nodes (${nodes.length})`));
      parts.push(table(['Nome', 'Entity ID', 'Management Zone(s)'], nodes.map(n => [n.displayName ?? '—', n.entityId ?? '—', (n.managementZones || []).map(z => z.name).join(', ') || '—']), [2800, 3200, 3026]));
      parts.push(emptyPara());
    }

    if (namespaces.length > 0) {
      parts.push(heading2(`Namespaces (${namespaces.length})`));
      parts.push(table(['Nome', 'Entity ID', 'Management Zone(s)', 'Tags'], namespaces.map(ns => [ns.displayName ?? '—', ns.entityId ?? '—', (ns.managementZones || []).map(z => z.name).join(', ') || '—', (ns.tags || []).map(t => t.key + (t.value ? `:${t.value}` : '')).slice(0, 2).join(', ') || '—']), [2400, 2600, 2200, 1826]));
      parts.push(emptyPara());
    }
  }

  if (activeGates.length > 0) {
    parts.push(heading1('4. ActiveGates'));
    parts.push(para(`${activeGates.length} ActiveGate(s) registrado(s)`, { color: '6B7280', size: 18 }));
    parts.push(emptyPara());
    parts.push(table(
      ['Nome/ID', 'Tipo', 'Versão', 'OS', 'Network Zone'],
      activeGates.map(ag => [ag.hostname ?? ag.id ?? '—', ag.type ?? '—', ag.version ?? '—', ag.osType ?? '—', ag.networkZone ?? '—']),
      [2600, 1400, 1400, 1200, 2426]
    ));
    parts.push(emptyPara());
  }

  return parts.join('\n');
}

// ── Exports ───────────────────────────────────────────────────────
async function generateDashboardsDocx(inventoryResult, tenantDoc) {
  return generateDocx(buildDashboardsBody(inventoryResult, tenantDoc), tenantDoc, TEMPLATE_DASHBOARDS, inventoryResult.executedAt);
}

async function generateApplicationsDocx(inventoryResult, tenantDoc) {
  return generateDocx(buildApplicationsBody(inventoryResult, tenantDoc), tenantDoc, TEMPLATE_APPLICATIONS, inventoryResult.executedAt);
}

async function generateInfrastructureDocx(inventoryResult, tenantDoc) {
  return generateDocx(buildInfrastructureBody(inventoryResult, tenantDoc), tenantDoc, TEMPLATE_INFRASTRUCTURE, inventoryResult.executedAt);
}

module.exports = { generateDashboardsDocx, generateApplicationsDocx, generateInfrastructureDocx };