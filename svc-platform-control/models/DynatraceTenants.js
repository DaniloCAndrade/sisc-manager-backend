const mongoose = require('mongoose');

const dynatraceTenantsSchema = new mongoose.Schema({
    nome: {
        type: String,
        required: [true, 'Nome é obrigatório'],
        trim: true
    },
    label: {
        type: String,
        required: [true, 'label obrigatório'],
        trim: true
    },
    tenantId: {
        type: String,
        required: [true, 'tenantId obrigatório'],
        trim: true
    },
    baseUrl: {
        type: String,
        required: [true, 'baseUrl obrigatório'],
        trim: true
    },
    apiToken: {
        type: String,
        required: [true, 'apiToken obrigatório'],
        trim: true
    },
    dataCriacao: {
        type: Date,
        default: Date.now
    },
    descricao: {
        type: String,
    },
    reportTemplante: {
        type: String,
        enum: ['default', 'Very', 'INEP/RNP', 'Detran'],
        default: 'default',
    },

    // ── Licenciamento Classic (svc-license) ──────────────────────
    // Sem API pra buscar isso automaticamente (diferente do DPS, que vem
    // do budget.total/currentPeriod.startTime da subscription) —
    // configurado manualmente por tenant.
    hostUnitsQuota: {
        type: Number,
        default: null,
    },
    dduQuota: {
        type: Number,
        default: null,
    },
    demQuota: {
        type: Number,
        default: null,
    },
    appSecurityQuota: {
        type: Number,
        default: null,
    },
    // Início do período anual de contrato (ex: aniversário do contrato) —
    // usado como "from" nas queries de DDU/DEM, pra bater com o mesmo
    // período que o painel nativo do Account Management mostra. Sem isso
    // preenchido, o cálculo cai num fallback de 30 dias (subestima o
    // consumo real do período inteiro).
    licensePeriodStart: {
        type: Date,
        default: null,
    },
});

module.exports = mongoose.model('DynatraceTenants', dynatraceTenantsSchema);