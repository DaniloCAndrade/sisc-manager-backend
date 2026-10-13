/**
 * reportOrchestrator.js
 * Coordena a coleta de dados e a geração do .docx para um relatório.
 * 
 * Uso:
 *   const { gerarRelatorio } = require('./reportOrchestrator');
 *   await gerarRelatorio({ tenant, reportKey: 'portal', from, to, res });
 */

const { REPORT_CONFIGS } = require('./reportConfig');
const { collectSectionData } = require('./reportDataService');
const { buildDocx } = require('./docxBuilder');

async function gerarRelatorio({ tenant, tenantMongoId, reportKey, from, to, res }) {
    const config = REPORT_CONFIGS[reportKey];
    if (!config) throw new Error(`Relatório desconhecido: ${reportKey}`);

    console.log(`[reportOrchestrator] Gerando relatório ${config.label} | ${from} → ${to}`);

    const sectionsData = await Promise.all(
        config.sections.map(section =>
            // Rede de segurança: infraType (e appType) vivem no nível do config
            // (config.infraType), não em cada seção individualmente. Caso uma
            // seção não repita esses campos, preenchemos aqui a partir do config,
            // pra collectSectionData sempre ter section.infraType disponível.
            collectSectionData(
                tenant,
                tenantMongoId,
                {
                    infraType: config.infraType,
                    appType: config.appType,
                    ...section,
                },
                from,
                to,
            )
        )
    );

    const filename = `Relatório_APM_${config.label.replace(/\s/g, '_')}_${from.slice(0, 7)}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await buildDocx({ config, sectionsData, from, to, res });
}

module.exports = { gerarRelatorio };