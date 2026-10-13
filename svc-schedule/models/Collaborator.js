const mongoose = require('mongoose');
const { timeSchema, diaSemanaSchema } = require('./shared/schemas');

const collaboratorSchema = new mongoose.Schema({
    nome: { type: String, required: [true, 'Nome é obrigatório'], trim: true },
    email: { type: String, trim: true, lowercase: true },
    ativo: { type: Boolean, default: true },

    // ── Subgrupo — define posição na geração da escala ───────────────
    // DIURNO  → 12x36 turno dia   (07h–19h)
    // NOTURNO → 12x36 turno noite (19h–07h)
    // FIXO    → Cobre todos os dias

    subgrupo: {
        type: String,
        enum: ['DIURNO', 'NOTURNO', 'FIXO'],
        required: [true, 'Subgrupo é obrigatório'],
    },

    horarioTrabalho: {
        inicio: timeSchema,
        fim: timeSchema,
        intervalo: timeSchema,
        intervaloTamanho: timeSchema,
    },

    escala: {
        tipo: { type: String, enum: ['SEMANAL', 'CICLICO', 'LIVRE'], required: true },
        semanal: {
            diasTrabalho: { type: Number, min: 1, max: 7 },
            diasDescanso: { type: Number, min: 0, max: 6 },
            diasEspecificos: diaSemanaSchema,
            inicioSemana: {
                type: String,
                enum: ['DOMINGO', 'SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO'],
            },
        },
        ciclico: {
            horasTrabalho: { type: Number, min: 1 },
            horasDescanso: { type: Number, min: 1 },
            inicioCiclo: { type: Date },
        },
        livre: [{ data: Date, horaInicio: timeSchema, horaFim: timeSchema, observacao: String }],
        regime: { type: String, enum: ['PRESENCIAL', 'HIBRIDO', 'REMOTO', 'AUSENTE'] },
    },

    turno: {
        type: String,
        enum: ['MATUTINO', 'VESPERTINO', 'NOTURNO', 'INTEGRAL', 'ADMINISTRATIVO', 'CUSTOMIZADO'],
        required: true,
    },

    observacoes: String,
    criadoEm: { type: Date, default: Date.now, immutable: true },
    atualizadoEm: { type: Date, default: Date.now },
});

collaboratorSchema.pre('save', function (next) {
    this.atualizadoEm = new Date();
    next();
});

module.exports = mongoose.model('Collaborator', collaboratorSchema);