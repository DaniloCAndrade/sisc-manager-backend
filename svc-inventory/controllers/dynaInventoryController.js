/**
 * dynaInventoryController.js
 *
 * POST   /api/dynatrace/inventory/:tenantId/validate  → testa conectividade
 * POST   /api/dynatrace/inventory/:tenantId/run       → inicia o scan (ASSÍNCRONO — responde 202 na hora)
 * GET    /api/dynatrace/inventory/:tenantId/status    → acompanha o progresso da coleta em andamento
 * GET    /api/dynatrace/inventory/:tenantId           → último resultado em cache
 * DELETE /api/dynatrace/inventory/:tenantId/cache     → invalida cache
 *
 * ── HISTÓRICO DE MUDANÇAS ───────────────────────────────────────────────────
 * v2: /run passou a ser assíncrono (202 imediato + polling em /status), pra
 *     não estourar o timeout do Route/HAProxy do OpenShift em tenants grandes.
 * v3: estado (job em andamento + cache do resultado) deixou de ser Map() em
 *     memória do processo e passou a ser persistido no svc-platform-control
 *     (Mongo), via platformControlClient. Isso resolve a inconsistência que
 *     acontecia quando o svc-inventory rodava com múltiplas réplicas: cada
 *     réplica tinha sua própria cópia do Map, então requisições consecutivas
 *     do mesmo usuário podiam cair em réplicas diferentes e ver estados
 *     diferentes (uma dizia "rodando", outra "nunca iniciei", outra tinha
 *     o resultado pronto). Agora todas consultam a mesma fonte de verdade.
 */

const {
  getTenantById,
  updateTenantBaseUrl,
  listTenants,
  startInventoryJob,
  updateInventoryProgress,
  completeInventoryJob,
  failInventoryJob,
  getInventoryState,
  getInventoryResult,
  clearInventoryState,
} = require('../services/platformControlClient');
const { runInventory, validateTenant } = require('./dynaInventoryService');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ---------------------------------------------------------------------------
// Helper interno — coleta um único tenant e persiste o resultado, tratando
// erro internamente (usado pela rotina de coleta de TODOS os tenants).
// Diferente do fluxo de /run: aqui sempre força uma coleta nova (é o
// propósito da rotina agendada — refrescar tudo, não usar cache antigo).
// ---------------------------------------------------------------------------
async function collectTenantInBackground(tenant) {
  const tenantId = String(tenant._id ?? tenant.id);
  try {
    const currentState = await getInventoryState(tenantId);
    if (currentState.status === 'running') {
      console.log(`[InventoryController] run-all: tenant ${tenantId} já está coletando — pulando.`);
      return;
    }

    await startInventoryJob(tenantId);

    const result = await runInventory(tenant, (progress) => {
      updateInventoryProgress(tenantId, progress);
    });

    if (result.urlWasCorrected) {
      try {
        await updateTenantBaseUrl(tenantId, result.resolvedUrl);
      } catch (e) {
        console.error('[InventoryController] run-all: falha ao persistir baseUrl corrigido:', e.message);
      }
    }

    await completeInventoryJob(tenantId, result);
    console.log(`[InventoryController] run-all: tenant ${tenantId} concluído com sucesso.`);
  } catch (err) {
    console.error(`[InventoryController] run-all: erro no tenant ${tenantId}:`, err.message);
    const validation = err.code === 'TENANT_VALIDATION_FAILED' ? (err.validation || null) : null;
    await failInventoryJob(tenantId, err.message, validation);
  }
}

// ---------------------------------------------------------------------------
// POST /run-all  (rotina agendada — dispara a coleta de TODOS os tenants)
// Protegido por chave própria (CRON_SECRET), não pelo authMiddleware normal
// — quem chama isso é um serviço externo de agendamento, não um usuário
// logado nem outro microserviço interno.
// ---------------------------------------------------------------------------
exports.runAllInventories = async (req, res) => {
  try {
    const tenants = await listTenants();
    if (!tenants?.length) {
      return res.json({ success: true, message: 'Nenhum tenant cadastrado.', total: 0 });
    }

    // Responde IMEDIATAMENTE — o cron externo só precisa saber que foi
    // disparado, não precisa esperar todas as coletas terminarem.
    res.status(202).json({
      success: true,
      message: `Coleta iniciada para ${tenants.length} tenant(s). Processamento sequencial em background.`,
      total: tenants.length,
    });

    // Sequencial (não em paralelo) — evita várias coletas grandes rodando ao
    // mesmo tempo competindo por memória/CPU no mesmo processo (foi
    // justamente concorrência + payload grande que quase derrubou o pod
    // no episódio do DETRAN).
    for (const tenantRef of tenants) {
      const tenantId = String(tenantRef._id ?? tenantRef.id);
      console.log(`[InventoryController] run-all: iniciando tenant ${tenantId} (${tenantRef.nome ?? ''})`);

      const fullTenant = await getTenantById(tenantId);
      if (!fullTenant) {
        console.warn(`[InventoryController] run-all: tenant ${tenantId} não encontrado ao buscar detalhes — pulando.`);
        continue;
      }
      await collectTenantInBackground(fullTenant);
    }

    console.log('[InventoryController] run-all: processamento de todos os tenants concluído.');
  } catch (err) {
    console.error('[InventoryController] Erro em runAllInventories:', err.message);
    // Já respondemos 202 antes de chegar aqui (na maioria dos casos) — só loga.
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// ---------------------------------------------------------------------------
// POST /validate
// Testa se o tenant está acessível e devolve a URL correta.
// Útil para checar antes de salvar no banco ou debugar problemas.
// ---------------------------------------------------------------------------
exports.validateTenant = async (req, res) => {
  const { tenantId } = req.params;

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant não encontrado.' });

    const validation = await validateTenant(tenant.baseUrl, tenant.apiToken);

    // Se a URL foi corrigida automaticamente, atualiza no banco
    if (validation.ok && validation.suggestedUrl && validation.suggestedUrl !== tenant.baseUrl) {
      await updateTenantBaseUrl(tenantId, validation.suggestedUrl);
      validation.baseUrlUpdatedInDb = true;
      validation.message = `baseUrl corrigido automaticamente para ${validation.suggestedUrl} e atualizado no banco.`;
    }

    return res.json({ success: validation.ok, tenant: { id: tenant._id, nome: tenant.nome }, ...validation });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// POST /run  (ASSÍNCRONO — estado persistido no svc-platform-control)
// ---------------------------------------------------------------------------
exports.runInventory = async (req, res) => {
  const { tenantId } = req.params;
  const forceRefresh = req.query.force === 'true';

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant não encontrado' });

    // Cache válido — responde na hora, sem disparar nova coleta
    if (!forceRefresh) {
      const cached = await getInventoryResult(tenantId);
      if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
        return res.json({
          success: true,
          status: 'done',
          fromCache: true,
          cachedAt: cached.cachedAt,
          tenant: { id: tenant._id, nome: tenant.nome, label: tenant.label },
          ...cached.result,
        });
      }
    }

    // Já existe uma coleta rodando para esse tenant — não duplica, só informa
    const currentState = await getInventoryState(tenantId);
    if (currentState.status === 'running') {
      return res.status(202).json({
        success: true,
        status: 'running',
        message: 'Inventário já está sendo coletado. Consulte GET /:tenantId/status para acompanhar.',
        progress: currentState.progress,
        startedAt: currentState.startedAt,
      });
    }

    // Registra o início do job no svc-platform-control ANTES de disparar em
    // background — se isso falhar, melhor abortar aqui do que deixar a
    // coleta rodando sem ninguém conseguir acompanhar o progresso dela.
    const startResult = await startInventoryJob(tenantId);

    // Dispara a coleta em BACKGROUND (sem await aqui)
    runInventory(tenant, (progress) => {
      // fire-and-forget — updateInventoryProgress já loga e não lança erro,
      // não precisamos (nem devemos) esperar isso pra continuar coletando.
      updateInventoryProgress(tenantId, progress);
    })
      .then(async (result) => {
        // Se a URL foi corrigida durante o run, persiste no banco
        if (result.urlWasCorrected) {
          try {
            await updateTenantBaseUrl(tenantId, result.resolvedUrl);
            console.log(`[InventoryController] baseUrl do tenant ${tenantId} corrigido para ${result.resolvedUrl}`);
          } catch (e) {
            console.error('[InventoryController] Falha ao persistir baseUrl corrigido:', e.message);
          }
        }

        await completeInventoryJob(tenantId, result);
      })
      .catch(async (err) => {
        console.error('[InventoryController] Erro ao executar inventário (async):', err);
        const validation = err.code === 'TENANT_VALIDATION_FAILED' ? (err.validation || null) : null;
        await failInventoryJob(tenantId, err.message, validation);
      });

    // Responde IMEDIATAMENTE — não espera a coleta terminar
    return res.status(202).json({
      success: true,
      status: 'running',
      message: 'Inventário iniciado. Consulte GET /:tenantId/status para acompanhar o progresso.',
      startedAt: startResult.startedAt,
    });

  } catch (err) {
    console.error('[InventoryController] Erro ao iniciar inventário:', err);
    return res.status(500).json({ success: false, message: 'Erro interno ao iniciar inventário.', error: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /:tenantId/status
// Progresso da coleta em andamento (ou resultado da última, se já terminou).
// ---------------------------------------------------------------------------
exports.getInventoryStatus = async (req, res) => {
  const { tenantId } = req.params;

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant não encontrado.' });

    const state = await getInventoryState(tenantId);

    if (state.status === 'idle') {
      return res.json({ success: true, status: 'idle', message: 'Nenhuma coleta iniciada. Use POST /run.' });
    }

    if (state.status === 'running') {
      return res.json({
        success: true,
        status: 'running',
        progress: state.progress,
        startedAt: state.startedAt,
      });
    }

    if (state.status === 'error') {
      return res.status(400).json({
        success: false,
        status: 'error',
        message: state.error?.message,
        validation: state.error?.validation ?? null,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      });
    }

    // status === 'done'
    return res.json({
      success: true,
      status: 'done',
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      cachedAt: state.cachedAt,
    });

  } catch (err) {
    // getInventoryState relança em caso de falha de rede com o
    // svc-platform-control — reporta como erro transitório, não como job
    // inexistente, pro frontend saber que vale tentar de novo.
    return res.status(503).json({ success: false, message: `Falha ao consultar status: ${err.message}` });
  }
};

// ---------------------------------------------------------------------------
// GET /:tenantId
// ---------------------------------------------------------------------------
exports.getLastInventory = async (req, res) => {
  const { tenantId } = req.params;

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant não encontrado.' });

    const cached = await getInventoryResult(tenantId);
    if (!cached) {
      return res.status(404).json({
        success: false,
        message: 'Nenhum inventário executado para este tenant. Use POST /run para iniciar.',
      });
    }

    return res.json({
      success: true,
      fromCache: true,
      cachedAt: cached.cachedAt,
      tenant: { id: tenant._id, nome: tenant.nome, label: tenant.label },
      ...cached.result,
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// DELETE /:tenantId/cache
// ---------------------------------------------------------------------------
exports.clearCache = async (req, res) => {
  try {
    await clearInventoryState(req.params.tenantId);
    return res.json({ success: true, message: 'Cache invalidado.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /:tenantId/export
// Gera e retorna o arquivo Word (.docx) do inventário em cache.
// ---------------------------------------------------------------------------
const { generateInventoryDocx } = require('./dynaInventoryExport');
const {
  generateDashboardsDocx,
  generateApplicationsDocx,
  generateInfrastructureDocx,
} = require('./dynaInventoryExportSpecific');

exports.exportInventory = async (req, res) => {
  const { tenantId } = req.params;

  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant não encontrado.' });

    // Precisa ter inventário em cache para exportar
    const cached = await getInventoryResult(tenantId);
    if (!cached) {
      return res.status(404).json({
        success: false,
        message: 'Nenhum inventário em cache. Execute o inventário primeiro via POST /run.',
      });
    }

    const buffer = await generateInventoryDocx(cached.result, tenant);

    const filename = `inventario_${(tenant.label ?? tenant.tenantId ?? tenantId).replace(/[^a-zA-Z0-9_-]/g, "_")}_${new Date().toISOString().slice(0, 10)}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);

  } catch (err) {
    console.error('[InventoryController] Erro ao exportar inventário:', err);
    return res.status(500).json({ success: false, message: 'Erro ao gerar documento Word.', error: err.message });
  }
};

// ---------------------------------------------------------------------------
// Helper reutilizável para exports específicos
// ---------------------------------------------------------------------------
async function runSpecificExport(tenantId, generatorFn, filePrefix, res) {
  try {
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant não encontrado.' });

    const cached = await getInventoryResult(tenantId);
    if (!cached) {
      return res.status(404).json({
        success: false,
        message: 'Nenhum inventário em cache. Execute o inventário primeiro via POST /run.',
      });
    }

    const buffer = await generatorFn(cached.result, tenant);
    const label = (tenant.label ?? tenant.tenantId ?? tenantId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${filePrefix}_${label}_${new Date().toISOString().slice(0, 10)}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);

  } catch (err) {
    console.error('[InventoryController] Erro ao exportar:', err);
    return res.status(500).json({ success: false, message: 'Erro ao gerar documento Word.', error: err.message });
  }
}

// GET /:tenantId/export/dashboards
exports.exportDashboards = (req, res) =>
  runSpecificExport(req.params.tenantId, generateDashboardsDocx, 'dashboards', res);

// GET /:tenantId/export/applications
exports.exportApplications = (req, res) =>
  runSpecificExport(req.params.tenantId, generateApplicationsDocx, 'aplicacoes', res);

// GET /:tenantId/export/infrastructure
exports.exportInfrastructure = (req, res) =>
  runSpecificExport(req.params.tenantId, generateInfrastructureDocx, 'infraestrutura', res);