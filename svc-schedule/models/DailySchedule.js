const mongoose = require('mongoose');
const { ObjectId } = mongoose.Schema.Types;

// ── Sub-schemas ───────────────────────────────────────────────────

const shiftSchema = new mongoose.Schema({
    collaboratorId: { type: ObjectId, ref: 'Collaborator', required: true },
    nome: String,   // desnormalizado para leitura rápida
    start: String,   // "07:00"
    end: String,   // "19:00"
    absent: { type: Boolean, default: false },
}, { _id: false });

const regular5x2Schema = new mongoose.Schema({
    collaboratorId: { type: ObjectId, ref: 'Collaborator', required: true },
    nome: String,
    start: String,
    end: String,
    working: { type: Boolean, default: true },
}, { _id: false });

const substitutionSchema = new mongoose.Schema({
    collaboratorId: { type: ObjectId, ref: 'Collaborator', required: true },
    nome: String,
    start: String,
    end: String,
    hours: Number,
    type: {
        type: String,
        enum: ['early_sub', 'late_sub', 'full_12h', 'day_to_night_12x36'],
    },
    confirmed: { type: Boolean, default: true },
    auto: { type: Boolean, default: false },
}, { _id: false });

const overnightSchema = new mongoose.Schema({
    collaboratorId: { type: ObjectId, ref: 'Collaborator', required: true },
    nome: String,
    start: String,
    end: String,
    hours: Number,
    programName: String,
}, { _id: false });

// ── Schema principal ──────────────────────────────────────────────

const dailyScheduleSchema = new mongoose.Schema({
    // Data do dia — armazenada sem componente de hora (meia-noite UTC)
    data: { type: Date, required: true, unique: true },
    // Campos derivados para consulta rápida
    ano: { type: Number, required: true },
    mes: { type: Number, required: true },   // 1–12
    dia: { type: Number, required: true },
    diaSemana: String,                            // "segunda-feira"
    isWeekend: { type: Boolean, default: false },

    // Turnos 12x36
    day_shift: { type: shiftSchema, default: null },
    night_shift: { type: shiftSchema, default: null },

    // Trabalho regular 5x2 (vazio nos fins de semana)
    regular_5x2: { type: [regular5x2Schema], default: [] },

    // Substituições do dia
    substitutions: { type: [substitutionSchema], default: [] },

    // Plantões de madrugada
    overnight_5x2: { type: overnightSchema, default: null },
    opening_overnight_5x2: { type: overnightSchema, default: null },

    notes: { type: String, default: '' },

    criadoEm: { type: Date, default: Date.now, immutable: true },
    atualizadoEm: { type: Date, default: Date.now },
}, { timestamps: false });

dailyScheduleSchema.index({ ano: 1, mes: 1 });

dailyScheduleSchema.pre('save', function (next) {
    this.atualizadoEm = new Date();
    next();
});

module.exports = mongoose.model('DailySchedule', dailyScheduleSchema);