const Absence = require('../models/Absence');
const Collaborator = require('../models/Collaborator');
const { regenerateAffectedMonths } = require('./generate');

const criarAbsence = async (req, res) => {
    try {
        const { collaboratorId, tipo, periodo, indeterminate, substitutionChain, observacao, status } = req.body;

        if (!collaboratorId || !tipo || !periodo?.inicio) {
            return res.status(400).json({ success: false, message: 'collaboratorId, tipo e periodo.inicio são obrigatórios.' });
        }

        const collab = await Collaborator.findById(collaboratorId).lean();
        if (!collab) return res.status(404).json({ success: false, message: 'Colaborador não encontrado.' });

        const absence = new Absence({
            collaboratorId: collab._id,
            nome: collab.nome,
            tipo,
            periodo: {
                inicio: new Date(periodo.inicio),
                fim: indeterminate ? null : (periodo.fim ? new Date(periodo.fim) : null),
            },
            indeterminate: Boolean(indeterminate),
            substitutionChain: substitutionChain ?? {},
            status: status ?? 'CRIADO',
            observacao,
        });

        await absence.save();

        const regeneratedMonths = await regenerateAffectedMonths(absence);
        return res.status(201).json({ success: true, data: absence, regeneratedMonths });
    } catch (err) {
        console.error('[AbsenceController] criarAbsence:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const listarAbsence = async (req, res) => {
    try {
        const absences = await Absence.find().sort({ 'periodo.inicio': -1 }).lean();
        return res.json({ success: true, data: absences });
    } catch (err) {
        console.error('[AbsenceController] listarAbsence:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const listarAbsenceAtivo = async (req, res) => {
    try {
        const now = new Date();
        const absences = await Absence.find({
            $or: [{ 'periodo.fim': null }, { 'periodo.fim': { $gte: now } }],
            'periodo.inicio': { $lte: now },
        }).lean();
        return res.json({ success: true, data: absences });
    } catch (err) {
        console.error('[AbsenceController] listarAbsenceAtivo:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const atualizarAbsence = async (req, res) => {
    try {
        const absence = await Absence.findById(req.params.id);
        if (!absence) return res.status(404).json({ success: false, message: 'Ausência não encontrada.' });

        const { tipo, periodo, indeterminate, substitutionChain, observacao, status } = req.body;

        if (tipo) absence.tipo = tipo;
        if (observacao) absence.observacao = observacao;
        if (status) absence.status = status;

        if (periodo?.inicio) absence.periodo.inicio = new Date(periodo.inicio);
        if (indeterminate !== undefined) {
            absence.indeterminate = Boolean(indeterminate);
            absence.periodo.fim = indeterminate ? null : (periodo?.fim ? new Date(periodo.fim) : absence.periodo.fim);
        } else if (periodo?.fim !== undefined) {
            absence.periodo.fim = periodo.fim ? new Date(periodo.fim) : null;
        }

        if (substitutionChain !== undefined) absence.substitutionChain = substitutionChain;

        await absence.save();

        const regeneratedMonths = await regenerateAffectedMonths(absence);
        return res.json({ success: true, data: absence, regeneratedMonths });
    } catch (err) {
        console.error('[AbsenceController] atualizarAbsence:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const deletarAbsence = async (req, res) => {
    try {
        const absence = await Absence.findByIdAndDelete(req.params.id);
        if (!absence) return res.status(404).json({ success: false, message: 'Ausência não encontrada.' });

        const regeneratedMonths = await regenerateAffectedMonths(absence);
        return res.json({ success: true, message: 'Ausência removida.', regeneratedMonths });
    } catch (err) {
        console.error('[AbsenceController] deletarAbsence:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { criarAbsence, listarAbsence, listarAbsenceAtivo, atualizarAbsence, deletarAbsence };