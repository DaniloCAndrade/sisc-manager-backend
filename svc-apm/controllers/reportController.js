/**
 * reportController.js
 * GET /api/report/:reportKey?id=<tenantId>&from=2026-05-01&to=2026-05-31
 */

const { getTenantById } = require('../services/platformControlClient');
const { gerarRelatorio } = require('../services/report/reportOrchestrator');

const gerarRelatorioAPM = async (req, res) => {
    try {
        const { reportKey } = req.params;
        const { id, from, to } = req.query;

        if (!id) return res.status(400).json({ success: false, message: 'id do tenant é obrigatório' });
        if (!from || !to) return res.status(400).json({ success: false, message: 'from e to são obrigatórios (YYYY-MM-DD)' });
        if (!['portal', 'app', 'getran'].includes(reportKey))
            return res.status(400).json({ success: false, message: 'reportKey inválido. Use: portal | app | getran' });

        const tenant = await getTenantById(id);
        if (!tenant) return res.status(404).json({ success: false, message: 'Tenant não encontrado' });

        // Remove espaços/quebras de linha que podem vir da query string
        const fromClean = (from || '').trim().replace(/\s+/g, '');
        const toClean = (to || '').trim().replace(/\s+/g, '');
        const fromISO = `${fromClean}T00:00:00.000-03:00`;
        const toISO = `${toClean}T23:59:59.999-03:00`;

        // Passa o mongoId para buscar OAuth no orchestrator
        await gerarRelatorio({
            tenant,
            tenantMongoId: id,
            reportKey,
            from: fromISO,
            to: toISO,
            res,
        });

    } catch (err) {
        console.error('[reportController] gerarRelatorioAPM:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { gerarRelatorioAPM };