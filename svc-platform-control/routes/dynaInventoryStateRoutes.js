// routes/dynaInventoryStateRoutes.js
/**
 * dynaInventoryStateRoutes.js
 *
 * Endpoint INTERNO (consumido pelo svc-inventory via x-service-key,
 * mesmo padrão de resolve-bearer em dynaPlatformCredentialsRoutes.js)
 * para persistir o estado/progresso/resultado do inventário no Mongo,
 * em vez de em memória por processo — resolve a inconsistência entre
 * réplicas do svc-inventory.
 *
 * POST   /api/dynatrace/inventory-state/:tenantId/start     → inicia um job (status: running)
 * PATCH  /api/dynatrace/inventory-state/:tenantId/progress  → atualiza o progresso do job em andamento
 * POST   /api/dynatrace/inventory-state/:tenantId/complete  → marca como concluído e salva o resultado (gzip)
 * POST   /api/dynatrace/inventory-state/:tenantId/fail      → marca como erro
 * GET    /api/dynatrace/inventory-state/:tenantId/status    → status/progresso atual (sem o resultado, é leve)
 * GET    /api/dynatrace/inventory-state/:tenantId/result    → resultado completo do último inventário em cache
 * DELETE /api/dynatrace/inventory-state/:tenantId           → invalida cache/job
 */

const express = require('express');
const router = express.Router();
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DynaInventoryState = require('../models/DynaInventoryState');

// ---------------------------------------------------------------------------
// POST /:tenantId/start
// ---------------------------------------------------------------------------
router.post('/:tenantId/start', async (req, res) => {
    try {
        const now = new Date();
        const doc = await DynaInventoryState.findOneAndUpdate(
            { tenantId: req.params.tenantId },
            {
                $set: {
                    status: 'running',
                    progress: { step: 0, total: 0, label: null },
                    startedAt: now,
                    finishedAt: null,
                    error: { message: null, validation: null },
                    // NÃO mexe em resultGzip/cachedAt aqui — mantém o cache anterior
                    // disponível até esse novo job terminar (com sucesso ou erro).
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        return res.json({ success: true, status: doc.status, startedAt: doc.startedAt });
    } catch (err) {
        console.error('[inventory-state/start]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// PATCH /:tenantId/progress
// Body: { step, total, label }
// ---------------------------------------------------------------------------
router.patch('/:tenantId/progress', async (req, res) => {
    try {
        const { step, total, label } = req.body;
        const doc = await DynaInventoryState.findOneAndUpdate(
            { tenantId: req.params.tenantId },
            { $set: { progress: { step, total, label } } },
            { new: true },
        );
        if (!doc) return res.status(404).json({ success: false, message: 'Job não encontrado.' });
        return res.json({ success: true });
    } catch (err) {
        console.error('[inventory-state/progress]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// POST /:tenantId/complete
// Body: { result: <objeto completo do inventário> }
// ---------------------------------------------------------------------------
router.post('/:tenantId/complete', async (req, res) => {
    try {
        const { result } = req.body;
        if (!result) return res.status(400).json({ success: false, message: 'Campo "result" é obrigatório.' });

        const json = JSON.stringify(result);
        const resultGzip = await gzip(json);

        console.log(
            `[inventory-state/complete] tenant ${req.params.tenantId}: ` +
            `${(json.length / 1024 / 1024).toFixed(2)}MB → ${(resultGzip.length / 1024 / 1024).toFixed(2)}MB (gzip)`
        );

        if (resultGzip.length > 15 * 1024 * 1024) {
            // Ainda passou de ~15MB mesmo comprimido — não arrisca estourar o
            // limite de 16MB do MongoDB. Loga bem alto pra alguém notar e migrar
            // pra GridFS se isso realmente acontecer.
            console.error(
                `[inventory-state/complete] ⚠️ Resultado do tenant ${req.params.tenantId} muito grande ` +
                `mesmo comprimido (${(resultGzip.length / 1024 / 1024).toFixed(2)}MB) — não salvo. ` +
                `Precisa migrar para GridFS.`
            );
            await DynaInventoryState.findOneAndUpdate(
                { tenantId: req.params.tenantId },
                {
                    $set: {
                        status: 'error',
                        finishedAt: new Date(),
                        error: { message: 'Resultado do inventário excede o limite de armazenamento (mesmo comprimido).', validation: null },
                    },
                },
            );
            return res.status(413).json({ success: false, message: 'Resultado grande demais para armazenar.' });
        }

        const now = new Date();
        await DynaInventoryState.findOneAndUpdate(
            { tenantId: req.params.tenantId },
            {
                $set: {
                    status: 'done',
                    finishedAt: now,
                    resultGzip,
                    cachedAt: now,
                },
            },
            { upsert: true },
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('[inventory-state/complete]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// POST /:tenantId/fail
// Body: { message, validation? }
// ---------------------------------------------------------------------------
router.post('/:tenantId/fail', async (req, res) => {
    try {
        const { message, validation } = req.body;
        await DynaInventoryState.findOneAndUpdate(
            { tenantId: req.params.tenantId },
            {
                $set: {
                    status: 'error',
                    finishedAt: new Date(),
                    error: { message: message || 'Erro desconhecido.', validation: validation || null },
                },
            },
            { upsert: true },
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('[inventory-state/fail]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /:tenantId/status
// Leve — não inclui o resultGzip.
// ---------------------------------------------------------------------------
router.get('/:tenantId/status', async (req, res) => {
    try {
        const doc = await DynaInventoryState.findOne({ tenantId: req.params.tenantId })
            .select('-resultGzip')
            .lean();

        if (!doc) return res.json({ success: true, status: 'idle' });

        return res.json({
            success: true,
            status: doc.status,
            progress: doc.progress,
            startedAt: doc.startedAt,
            finishedAt: doc.finishedAt,
            error: doc.status === 'error' ? doc.error : null,
            cachedAt: doc.cachedAt,
            hasCachedResult: !!doc.cachedAt,
        });
    } catch (err) {
        console.error('[inventory-state/status]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /:tenantId/result
// Descomprime e devolve o resultado completo do último inventário em cache.
// ---------------------------------------------------------------------------
router.get('/:tenantId/result', async (req, res) => {
    try {
        const doc = await DynaInventoryState.findOne({ tenantId: req.params.tenantId }).lean();
        if (!doc || !doc.resultGzip || !doc.cachedAt) {
            return res.status(404).json({ success: false, message: 'Nenhum resultado em cache para este tenant.' });
        }

        // ⚠️ Com .lean(), um campo Mongoose do tipo Buffer volta como um objeto
        // Binary do driver do MongoDB (não um Buffer puro do Node) — passar isso
        // direto pro zlib.gunzip() quebra. Normaliza antes de descomprimir.
        const gzipBuffer = Buffer.isBuffer(doc.resultGzip)
            ? doc.resultGzip
            : Buffer.from(doc.resultGzip.buffer || doc.resultGzip);

        const json = await gunzip(gzipBuffer);
        const result = JSON.parse(json.toString('utf-8'));

        return res.json({ success: true, cachedAt: doc.cachedAt, result });
    } catch (err) {
        console.error('[inventory-state/result]', err.message, err.stack);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// DELETE /:tenantId
// ---------------------------------------------------------------------------
router.delete('/:tenantId', async (req, res) => {
    try {
        await DynaInventoryState.deleteOne({ tenantId: req.params.tenantId });
        return res.json({ success: true, message: 'Cache/job invalidado.' });
    } catch (err) {
        console.error('[inventory-state/delete]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;