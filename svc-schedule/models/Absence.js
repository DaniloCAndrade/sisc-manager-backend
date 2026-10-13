const mongoose = require('mongoose');
const { ObjectId } = mongoose.Schema.Types;

const absenceSchema = new mongoose.Schema({
    collaboratorId: { type: ObjectId, ref: 'Collaborator', required: true },
    nome: String,   // desnormalizado

    tipo: {
        type: String,
        enum: ['ATESTADO', 'FERIAS', 'LICENCA', 'OUTRO'],
        required: true,
    },

    periodo: {
        inicio: { type: Date, required: true },
        fim: { type: Date, default: null },   // null = indeterminado
    },

    indeterminate: { type: Boolean, default: false },

    // Cadeia de substituição manual
    substitutionChain: {
        // Id do 12x36 diurno que vai cobrir a noite (quando o noturno falta)
        nightSubId: { type: ObjectId, ref: 'Collaborator', default: null },
        nightSubNome: String,
        // Id do 5x2 que cobre o turno completo de dia (FDS)
        dayDirectSubId: { type: ObjectId, ref: 'Collaborator', default: null },
        dayDirectSubNome: String,
    },

    status: {
        type: String,
        enum: ['CRIADO', 'ACEITO', 'ERRO'],
        default: 'CRIADO',
    },

    observacao: String,
    criadoEm: { type: Date, default: Date.now, immutable: true },
    atualizadoEm: { type: Date, default: Date.now },
});

absenceSchema.pre('save', function (next) {
    this.atualizadoEm = new Date();
    next();
});

module.exports = mongoose.model('Absence', absenceSchema);