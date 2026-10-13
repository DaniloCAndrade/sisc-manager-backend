// shared/schemas.js
const mongoose = require('mongoose');

// Schema para horários (reutilizável)
const timeSchema = new mongoose.Schema({
    hora: {
        type: Number,
        min: 0,
        max: 23,
        required: true
    },
    minuto: {
        type: Number,
        min: 0,
        max: 59,
        required: true,
        default: 0
    }
}, { _id: false });

const diaSemanaModo = { type: String, enum: ['PRESENCIAL', 'REMOTO', 'HIBRIDO', 'INDISPONIVEL', 'DISPONIVEL', 'EVENTUAL'], default: 'HIBRIDO' };

// Schema para dias da semana
const diaSemanaSchema = new mongoose.Schema({
    domingo: diaSemanaModo,
    segunda: diaSemanaModo,
    terca: diaSemanaModo,
    quarta: diaSemanaModo,
    quinta: diaSemanaModo,
    sexta: diaSemanaModo,
    sabado: diaSemanaModo,
}, { _id: false });


const horarioTrabalhoSchema = new mongoose.Schema({
    inicio: timeSchema, // tenho que conseguir importar esse timeSchema de ./Collaborator.js, talvez eu tenha que mudar para ser possivel expeorta a extrutura, ou vale a pena eu recriar ela? ou coloco em um arquivo a parte?
    fim: timeSchema,
    intervalo: timeSchema,
    intervaloTamanho: timeSchema,
}, { _id: false });

module.exports = {
    timeSchema,
    diaSemanaSchema,
    horarioTrabalhoSchema,
};