/**
 * ScheduleConfig.js
 * Armazena a configuração de rotação por mês — substitui o campo
 * config/substitutionState que ficava dentro do JSON da escala.
 *
 * Um documento por mês (ano + mes únicos).
 */
const mongoose = require('mongoose');

const scheduleConfigSchema = new mongoose.Schema({
    ano: { type: Number, required: true },
    mes: { type: Number, required: true, min: 1, max: 12 },

    dayStartIndex: { type: Number, default: 0 },
    nightStartIndex: { type: Number, default: 0 },

    // Guardados para derivação correta do próximo mês
    _numDiurno: { type: Number, default: 0 },
    _numNoturno: { type: Number, default: 0 },

    substitutionState: {
        cedoIdx: { type: Number, default: 0 },
        tardeIdx: { type: Number, default: 0 },
        fixoIdx: { type: Number, default: 0 },
    },

    geradoEm: { type: Date, default: Date.now },
});

scheduleConfigSchema.index({ ano: 1, mes: 1 }, { unique: true });

module.exports = mongoose.model('ScheduleConfig', scheduleConfigSchema);