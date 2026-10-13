/**
 * dynaLicenseController.js
 *
 * GET /api/license/projects              → lista de projetos (subscriptions) de TODOS os clientes com credencial de licenciamento
 * GET /api/license/projects/:uuid?accountUuid=...  → detalhe: dados da subscription + custo diário por serviço
 * GET /api/license/projects/:uuid/projection?accountUuid=...&days=30 → projeção linear
 *
 * ⚠️ :uuid sozinho não identifica uma subscription de forma única entre
 * clientes diferentes — por isso os endpoints de detalhe/projeção exigem
 * também ?accountUuid=... (veio junto na resposta de /projects).
 */

const { listLicenseAccounts } = require('../services/platformControlClient');
const {
    listSubscriptions,
    getSubscription,
    getEnvironmentCost,
} = require('../services/dynaLicenseService');

// ---------------------------------------------------------------------------
// Categorização por faixa de consumo (mesmas faixas do desenho aprovado)
// ⚠️ Faixa 50%-70% não tem categoria própria no desenho original — tratada
// aqui como parte de "ideal" até confirmar se deveria ter rótulo separado.
// ---------------------------------------------------------------------------
function categorize(pct) {
    if (pct > 100) return 'excedido';
    if (pct >= 90) return 'critico';
    if (pct >= 70) return 'atencao';
    return 'ideal';
}

const CATEGORY_LABELS = {
    ideal: 'Consumo Ideal',
    atencao: 'Atenção',
    critico: 'Crítico',
    excedido: 'Excedido',
};

function isExpired(endTime) {
    if (!endTime) return false;
    return new Date(endTime).getTime() < Date.now();
}

// ---------------------------------------------------------------------------
// Mapeia uma subscription crua da API pro formato usado pelos cards,
// já identificada com qual cliente/conta ela pertence.
// ---------------------------------------------------------------------------
function mapSubscriptionToProject(sub, accountInfo) {
    const clienteMeta = {
        accountUuid: accountInfo.accountUuid,
        credentialId: accountInfo.credentialId,
        clienteNome: accountInfo.tenant?.nome ?? accountInfo.nome,
        tenantId: accountInfo.tenant?.id ?? null,
    };

    // ⚠️ Ainda não temos amostra real de subscription CLASSIC — por enquanto
    // assume DPS sempre que existir "budget" no payload (confirmado via curl
    // pra subscription DPS real). Precisa validar quando tivermos uma
    // subscription Classic de verdade pra comparar o formato.
    const isDps = !!sub.budget;

    if (isDps) {
        const total = sub.budget?.total ?? 0;
        const used = sub.budget?.used ?? 0;
        const pct = total > 0 ? (used / total) * 100 : 0;

        return {
            ...clienteMeta,
            uuid: sub.uuid,
            name: sub.name,
            status: sub.status,
            licenseType: 'DPS',
            contractValue: total,
            currentCost: used,
            currencyCode: sub.budget?.currencyCode ?? 'BRL',
            percent: Math.round(pct * 10) / 10,
            category: categorize(pct),
            periodStart: sub.currentPeriod?.startTime ?? sub.startTime,
            periodEnd: sub.currentPeriod?.endTime ?? sub.endTime,
            daysRemaining: sub.currentPeriod?.daysRemaining ?? null,
            expired: isExpired(sub.currentPeriod?.endTime ?? sub.endTime),
        };
    }

    // Placeholder pra Classic — capturado pra não quebrar o /projects, mas o
    // mapeamento completo (Host Units, DEM, DDU) fica pra próxima etapa.
    return {
        ...clienteMeta,
        uuid: sub.uuid,
        name: sub.name,
        status: sub.status,
        licenseType: 'CLASSIC',
        percent: null,
        category: null,
        _raw: sub, // mantido pra facilitar debug até implementarmos Classic de verdade
    };
}

// ---------------------------------------------------------------------------
// GET /projects
// ---------------------------------------------------------------------------
exports.getProjects = async (req, res) => {
    try {
        const accounts = await listLicenseAccounts();

        if (accounts.length === 0) {
            return res.json({
                success: true,
                summary: Object.entries(CATEGORY_LABELS).map(([key, label]) => ({ key, label, count: 0 })),
                projects: [],
                message: 'Nenhuma credencial de licenciamento cadastrada ainda.',
            });
        }

        // Busca todas as subscriptions de todos os clientes em paralelo
        const perAccount = await Promise.all(
            accounts.map(async (acc) => {
                try {
                    const subsList = await listSubscriptions(acc.accountUuid, acc.authHeader);
                    const items = Array.isArray(subsList?.data) ? subsList.data
                        : Array.isArray(subsList) ? subsList
                            : [];

                    // Conta com credencial de licenciamento cadastrada, mas sem
                    // nenhuma subscription DPS — provavelmente é licenciamento Classic
                    // (a API de Platform Subscription só cobre DPS). Mostra isso
                    // explicitamente em vez de deixar o cliente sumir silenciosamente
                    // da lista.
                    if (items.length === 0) {
                        return [{
                            accountUuid: acc.accountUuid,
                            credentialId: acc.credentialId,
                            clienteNome: acc.tenant?.nome ?? acc.nome,
                            tenantId: acc.tenant?.id ?? null,
                            uuid: null,
                            name: acc.tenant?.nome ?? acc.nome,
                            licenseType: 'CLASSIC_OU_SEM_DPS',
                            percent: null,
                            category: null,
                            message: 'Nenhuma subscription DPS encontrada nesta conta — provável licenciamento Classic (suporte previsto para uma próxima etapa).',
                        }];
                    }

                    const detailed = await Promise.all(
                        items.map(async (item) => {
                            try {
                                const sub = await getSubscription(acc.accountUuid, acc.authHeader, item.uuid);
                                return mapSubscriptionToProject(sub, acc);
                            } catch (err) {
                                console.error(`[svc-license] Erro em subscription ${item.uuid} (${acc.nome}):`, err.message);
                                return { uuid: item.uuid, name: item.name ?? item.uuid, accountUuid: acc.accountUuid, clienteNome: acc.tenant?.nome ?? acc.nome, error: err.message };
                            }
                        })
                    );
                    return detailed;
                } catch (err) {
                    console.error(`[svc-license] Erro ao listar subscriptions da conta ${acc.nome}:`, err.message);
                    return [{ accountUuid: acc.accountUuid, clienteNome: acc.tenant?.nome ?? acc.nome, error: err.message }];
                }
            })
        );

        const allProjects = perAccount.flat();

        const summary = { ideal: 0, atencao: 0, critico: 0, excedido: 0 };
        for (const p of allProjects) {
            if (p.category && summary[p.category] !== undefined) summary[p.category]++;
        }

        return res.json({
            success: true,
            summary: Object.entries(summary).map(([key, count]) => ({
                key, label: CATEGORY_LABELS[key], count,
            })),
            projects: allProjects,
        });
    } catch (err) {
        console.error('[svc-license] Erro em getProjects:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ---------------------------------------------------------------------------
// GET /projects/:uuid?accountUuid=...
// Detalhe + custo diário por capability (default: últimos 7 dias)
// ---------------------------------------------------------------------------
exports.getProjectDetail = async (req, res) => {
    const { uuid } = req.params;
    const { accountUuid } = req.query;
    const days = Math.min(parseInt(req.query.days, 10) || 7, 400);

    if (!accountUuid) {
        return res.status(400).json({ success: false, message: 'Parâmetro accountUuid é obrigatório (veio na resposta de /projects).' });
    }

    try {
        const accounts = await listLicenseAccounts();
        const account = accounts.find((a) => a.accountUuid === accountUuid);
        if (!account) return res.status(404).json({ success: false, message: 'Conta não encontrada ou credencial inativa.' });

        const sub = await getSubscription(accountUuid, account.authHeader, uuid);
        const project = mapSubscriptionToProject(sub, account);

        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
        const fmt = (d) => d.toISOString().slice(0, 19) + 'Z';

        let dailyCost = [];
        try {
            const costResp = await getEnvironmentCost(accountUuid, account.authHeader, uuid, fmt(startTime), fmt(endTime));
            // ⚠️ Formato de resposta ainda não 100% validado na v3 — mantém a
            // mesma leitura usada na v2 testada manualmente (data[].cost[]),
            // com fallback pra outras formas plausíveis.
            const rawCosts = costResp?.data?.[0]?.cost
                ?? costResp?.data?.flatMap((d) => d.cost ?? [])
                ?? [];
            dailyCost = rawCosts;
        } catch (err) {
            console.error(`[svc-license] Erro ao buscar custo diário de ${uuid}:`, err.message);
        }

        return res.json({ success: true, project, dailyCost, windowDays: days });
    } catch (err) {
        console.error('[svc-license] Erro em getProjectDetail:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ---------------------------------------------------------------------------
// GET /projects/:uuid/projection?accountUuid=...&days=30
// Projeção linear simples: média diária (consumido / dias corridos do
// período) × dias do horizonte escolhido.
// ---------------------------------------------------------------------------
exports.getProjectProjection = async (req, res) => {
    const { uuid } = req.params;
    const { accountUuid } = req.query;
    const horizonDays = parseInt(req.query.days, 10) || 30;

    if (!accountUuid) {
        return res.status(400).json({ success: false, message: 'Parâmetro accountUuid é obrigatório (veio na resposta de /projects).' });
    }

    try {
        const accounts = await listLicenseAccounts();
        const account = accounts.find((a) => a.accountUuid === accountUuid);
        if (!account) return res.status(404).json({ success: false, message: 'Conta não encontrada ou credencial inativa.' });

        const sub = await getSubscription(accountUuid, account.authHeader, uuid);
        const project = mapSubscriptionToProject(sub, account);

        if (project.licenseType !== 'DPS') {
            return res.status(400).json({ success: false, message: 'Projeção disponível apenas para licenciamento DPS por enquanto.' });
        }

        const periodStart = new Date(project.periodStart);
        const now = new Date();
        const daysElapsed = Math.max(1, Math.round((now - periodStart) / (24 * 60 * 60 * 1000)));

        const dailyAverage = project.currentCost / daysElapsed;
        const projectedValue = dailyAverage * horizonDays;
        const projectedPercentOfContract = project.contractValue > 0
            ? (projectedValue / project.contractValue) * 100
            : 0;
        const projectedExcess = projectedValue - project.contractValue;

        return res.json({
            success: true,
            horizonDays,
            contractValue: project.contractValue,
            consumedSoFar: project.currentCost,
            dailyAverage,
            projectedValue,
            projectedPercentOfContract: Math.round(projectedPercentOfContract * 10) / 10,
            projectedExcess,
            willExceedBudget: projectedValue > project.contractValue,
        });
    } catch (err) {
        console.error('[svc-license] Erro em getProjectProjection:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};