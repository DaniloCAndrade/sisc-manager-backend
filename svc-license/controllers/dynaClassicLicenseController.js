/**
 * dynaClassicLicenseController.js
 *
 * GET /api/license/classic-projects → lista de tenants Classic com
 * consumo de Host Units/DDU/DEM vs. as quotas cadastradas manualmente
 * (DynatraceTenants.hostUnitsQuota / dduQuota / demQuota).
 *
 * Tenants sem nenhuma quota preenchida são pulados (não faz sentido
 * calcular % contra null) — aparecem só depois de alguém preencher pelo
 * menos uma das 3 quotas na tela de tenants.
 */

const { listTenants } = require('../services/platformControlClient');
const { fetchHostUnits, fetchDduTotal, fetchDemTotal, fetchAppSecurityTotal } = require('../services/dynaClassicLicenseService');

function categorize(pct) {
    if (pct === null) return null;
    if (pct > 100) return 'excedido';
    if (pct >= 90) return 'critico';
    if (pct >= 70) return 'atencao';
    return 'ideal';
}

function pct(used, quota) {
    if (!quota || quota <= 0) return null;
    return Math.round((used / quota) * 1000) / 10;
}

// Ano de contrato (365 dias) + ~5 dias de folga — depois disso, é bem
// provável que o contrato já tenha sido renovado e ninguém atualizou
// licensePeriodStart. Não é uma certeza (contratos podem não ser anuais),
// só um alerta pra alguém confirmar.
const PERIOD_LIKELY_EXPIRED_DAYS = 370;

function daysSince(date) {
    return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}

exports.getClassicProjects = async (req, res) => {
    const fallbackDays = Math.min(parseInt(req.query.days, 10) || 30, 365);

    try {
        const allTenants = await listTenants();

        // Só considera tenants com pelo menos uma quota Classic preenchida
        const tenants = allTenants.filter(
            (t) => t.hostUnitsQuota != null || t.dduQuota != null || t.demQuota != null || t.appSecurityQuota != null
        );

        if (tenants.length === 0) {
            return res.json({
                success: true,
                projects: [],
                message: 'Nenhum tenant com quota Classic (Host Units/DDU/DEM) cadastrada ainda.',
            });
        }

        const projects = await Promise.all(
            tenants.map(async (t) => {
                // ⚠️ Sem licensePeriodStart cadastrado, cai num fallback de N dias
                // (padrão 30) — SUBESTIMA o consumo real do período de contrato
                // inteiro. É o mesmo problema que identificamos comparando com o
                // painel nativo do Account Management (período anual vs. 30 dias
                // davam uma diferença de ~6x). Preencher licensePeriodStart resolve.
                let from, usedFallback = false;
                if (t.licensePeriodStart) {
                    from = new Date(t.licensePeriodStart).toISOString();
                } else {
                    from = `-${fallbackDays}d`;
                    usedFallback = true;
                }

                const periodLikelyExpired = t.licensePeriodStart
                    ? daysSince(t.licensePeriodStart) > PERIOD_LIKELY_EXPIRED_DAYS
                    : false;

                try {
                    const [hostUnitsUsed, dduResult, demResult, appSecurityResult] = await Promise.all([
                        fetchHostUnits(t.baseUrl, t.apiToken),
                        fetchDduTotal(t.baseUrl, t.apiToken, from),
                        fetchDemTotal(t.baseUrl, t.apiToken, from),
                        fetchAppSecurityTotal(t.baseUrl, t.apiToken, from),
                    ]);

                    const hostUnitsPct = pct(hostUnitsUsed, t.hostUnitsQuota);
                    const dduPct = pct(dduResult.total, t.dduQuota);
                    const demPct = pct(demResult.total, t.demQuota);
                    const appSecurityPct = pct(appSecurityResult.total, t.appSecurityQuota);

                    // Categoria geral do card = a pior entre as 4 (mais crítica primeiro)
                    const order = { excedido: 3, critico: 2, atencao: 1, ideal: 0 };
                    const cats = [categorize(hostUnitsPct), categorize(dduPct), categorize(demPct), categorize(appSecurityPct)].filter(Boolean);
                    const overallCategory = cats.length
                        ? cats.reduce((worst, c) => (order[c] > order[worst] ? c : worst), cats[0])
                        : null;

                    return {
                        tenantId: t._id,
                        clienteNome: t.nome,
                        label: t.label,
                        licenseType: 'CLASSIC',
                        periodStart: t.licensePeriodStart ?? null,
                        usedFallbackWindow: usedFallback, // true = número provavelmente subestimado, falta cadastrar a data
                        periodLikelyExpired, // true = período já passou de ~1 ano, contrato provavelmente renovado sem atualizar a data
                        category: overallCategory,
                        hostUnits: { used: hostUnitsUsed, quota: t.hostUnitsQuota, percent: hostUnitsPct, category: categorize(hostUnitsPct) },
                        ddu: { used: dduResult.total, quota: t.dduQuota, percent: dduPct, category: categorize(dduPct), breakdown: dduResult.breakdown },
                        dem: { used: demResult.total, quota: t.demQuota, percent: demPct, category: categorize(demPct), breakdown: demResult.breakdown },
                        appSecurity: { used: appSecurityResult.total, quota: t.appSecurityQuota, percent: appSecurityPct, category: categorize(appSecurityPct), breakdown: appSecurityResult.breakdown },
                    };
                } catch (err) {
                    console.error(`[svc-license] Erro ao coletar Classic de ${t.nome}:`, err.message);
                    return { tenantId: t._id, clienteNome: t.nome, licenseType: 'CLASSIC', error: err.message };
                }
            })
        );

        return res.json({ success: true, projects });
    } catch (err) {
        console.error('[svc-license] Erro em getClassicProjects:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};