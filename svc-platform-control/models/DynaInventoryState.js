// models/DynaInventoryState.js
const mongoose = require('mongoose');

/**
 * Estado + cache do inventário Dynatrace, compartilhado entre TODAS as
 * réplicas do svc-inventory (resolve o problema de cada réplica ter seu
 * próprio Map() em memória, causando respostas inconsistentes/404/503
 * dependendo de qual pod atende a requisição).
 *
 * Um documento por tenant (tenantId = _id do DynatraceTenants).
 *
 * O resultado do inventário é guardado COMPRIMIDO (gzip) em `resultGzip`
 * — tenants grandes (ex: DETRAN, ~10k entidades) podem gerar um JSON de
 * várias dezenas de MB, e o limite de documento do MongoDB é 16MB. JSON
 * repetitivo comprime tipicamente 70-90%, então isso deve manter a folga
 * necessária. Se mesmo comprimido algum tenant passar de 16MB no futuro,
 * o próximo passo seria migrar esse campo para GridFS.
 */
const dynaInventoryStateSchema = new mongoose.Schema({
    tenantId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },

    status: {
        type: String,
        enum: ['running', 'done', 'error'],
        required: true,
    },

    progress: {
        step: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        label: { type: String, default: null },
    },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },

    error: {
        message: { type: String, default: null },
        validation: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    // Resultado comprimido do último inventário bem-sucedido — pode conviver
    // com um novo `status: 'running'` (job novo rodando) sem apagar o cache
    // anterior, até o novo terminar com sucesso.
    resultGzip: { type: Buffer, default: null },
    cachedAt: { type: Date, default: null },

}, { versionKey: false });

module.exports = mongoose.model('DynaInventoryState', dynaInventoryStateSchema);