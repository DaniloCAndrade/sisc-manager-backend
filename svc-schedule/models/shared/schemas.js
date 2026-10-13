const mongoose = require('mongoose');

const timeSchema = new mongoose.Schema({
    hora: { type: Number, min: 0, max: 23, required: true },
    minuto: { type: Number, min: 0, max: 59, required: true, default: 0 },
}, { _id: false });

const diaSemanaSchema = new mongoose.Schema({
    domingo: String, segunda: String, terca: String,
    quarta: String, quinta: String, sexta: String, sabado: String,
}, { _id: false });

const horarioTrabalhoSchema = new mongoose.Schema({
    inicio: timeSchema,
    fim: timeSchema,
    intervalo: timeSchema,
    intervaloTamanho: timeSchema,
}, { _id: false });

module.exports = { timeSchema, diaSemanaSchema, horarioTrabalhoSchema };