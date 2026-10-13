const Collaborator = require('../models/Collaborator');

const criarCollaborator = async (req, res) => {
    try {
        const collaborator = new Collaborator(req.body);
        await collaborator.save();
        return res.status(201).json({ success: true, data: collaborator, message: 'Colaborador criado com sucesso.' });
    } catch (err) {
        console.error('[collaboratorController] criarCollaborator:', err.message);
        return res.status(400).json({ success: false, message: err.message });
    }
};

const listarCollaborator = async (req, res) => {
    try {
        const collaborators = await Collaborator.find({ ativo: true }).sort({ nome: 1 });
        return res.json({ success: true, data: collaborators });
    } catch (err) {
        console.error('[collaboratorController] listarCollaborator:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const listarCollaboratorAtivo = async (req, res) => {
    try {
        const collaborators = await Collaborator.find().sort({ nome: 1 });
        return res.json({ success: true, data: collaborators });
    } catch (err) {
        console.error('[collaboratorController] listarCollaboratorAtivo:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const atualizarCollaborator = async (req, res) => {
    try {
        const collaborator = await Collaborator.findByIdAndUpdate(
            req.params.id,
            { ...req.body, atualizadoEm: new Date() },
            { new: true, runValidators: true },
        );
        if (!collaborator) return res.status(404).json({ success: false, message: 'Colaborador não encontrado.' });
        return res.json({ success: true, data: collaborator, message: 'Colaborador atualizado com sucesso.' });
    } catch (err) {
        console.error('[collaboratorController] atualizarCollaborator:', err.message);
        return res.status(400).json({ success: false, message: err.message });
    }
};

const deletarCollaborator = async (req, res) => {
    try {
        const collaborator = await Collaborator.findByIdAndDelete(req.params.id);
        if (!collaborator) return res.status(404).json({ success: false, message: 'Colaborador não encontrado.' });
        return res.json({ success: true, message: 'Colaborador deletado com sucesso.' });
    } catch (err) {
        console.error('[collaboratorController] deletarCollaborator:', err.message);
        return res.status(400).json({ success: false, message: err.message });
    }
};

module.exports = { criarCollaborator, listarCollaborator, listarCollaboratorAtivo, atualizarCollaborator, deletarCollaborator };