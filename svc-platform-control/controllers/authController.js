const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-em-producao';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────
const login = async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha)
            return res.status(400).json({ success: false, message: 'Email e senha são obrigatórios.' });

        const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+senha');
        if (!user || !user.ativo)
            return res.status(401).json({ success: false, message: 'Credenciais inválidas.' });

        const senhaCorreta = await user.compararSenha(senha);
        if (!senhaCorreta)
            return res.status(401).json({ success: false, message: 'Credenciais inválidas.' });

        const token = jwt.sign(
            { id: user._id, email: user.email, perfil: user.perfil },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES },
        );

        return res.json({
            success: true,
            token,
            user: { id: user._id, nome: user.nome, email: user.email, perfil: user.perfil },
        });
    } catch (err) {
        console.error('[authController] login:', err.message);
        return res.status(500).json({ success: false, message: 'Erro interno.' });
    }
};

// ─────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────
const me = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.ativo)
            return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });

        return res.json({
            success: true,
            user: { id: user._id, nome: user.nome, email: user.email, perfil: user.perfil },
        });
    } catch (err) {
        console.error('[authController] me:', err.message);
        return res.status(500).json({ success: false, message: 'Erro interno.' });
    }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/register  (admin)
// ─────────────────────────────────────────────────────────────────
const register = async (req, res) => {
    try {
        const { nome, email, senha, perfil } = req.body;
        if (!nome || !email || !senha)
            return res.status(400).json({ success: false, message: 'Nome, email e senha são obrigatórios.' });

        const existe = await User.findOne({ email: email.toLowerCase().trim() });
        if (existe)
            return res.status(409).json({ success: false, message: 'Email já cadastrado.' });

        const user = await User.create({ nome, email, senha, perfil: perfil || 'viewer' });

        return res.status(201).json({
            success: true,
            user: { id: user._id, nome: user.nome, email: user.email, perfil: user.perfil },
        });
    } catch (err) {
        console.error('[authController] register:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────
// GET /api/auth/users  (admin)
// ─────────────────────────────────────────────────────────────────
const listUsers = async (req, res) => {
    try {
        const users = await User.find({}, '-senha').lean();
        return res.json({ success: true, data: users });
    } catch (err) {
        console.error('[authController] listUsers:', err.message);
        return res.status(500).json({ success: false, message: 'Erro interno.' });
    }
};

// ─────────────────────────────────────────────────────────────────
// PUT /api/auth/users/:id  (admin)
// Atualiza nome, perfil e status ativo do usuário
// ─────────────────────────────────────────────────────────────────
const updateUser = async (req, res) => {
    try {
        const { nome, perfil, ativo } = req.body;

        const user = await User.findById(req.params.id);
        if (!user)
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

        if (nome !== undefined) user.nome = nome;
        if (perfil !== undefined) user.perfil = perfil;
        if (ativo !== undefined) user.ativo = ativo;

        await user.save();

        return res.json({
            success: true,
            user: { id: user._id, nome: user.nome, email: user.email, perfil: user.perfil, ativo: user.ativo },
        });
    } catch (err) {
        console.error('[authController] updateUser:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────
// PUT /api/auth/users/:id/senha  (admin)
// Admin altera a senha de qualquer usuário
// ─────────────────────────────────────────────────────────────────
const updateSenha = async (req, res) => {
    try {
        const { senha } = req.body;
        if (!senha || senha.length < 8)
            return res.status(400).json({ success: false, message: 'Senha deve ter no mínimo 8 caracteres.' });

        const user = await User.findById(req.params.id);
        if (!user)
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

        user.senha = senha; // o pre('save') faz o hash automaticamente
        await user.save();

        return res.json({ success: true, message: 'Senha atualizada com sucesso.' });
    } catch (err) {
        console.error('[authController] updateSenha:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────
// DELETE /api/auth/users/:id  (admin)
// Impede que o admin se exclua
// ─────────────────────────────────────────────────────────────────
const deleteUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);

        if (!user)
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

        if (user.isSeed)
            return res.status(403).json({ success: false, message: 'Este usuário não pode ser excluído.' });

        if (req.params.id === String(req.user.id))
            return res.status(400).json({ success: false, message: 'Você não pode excluir sua própria conta.' });

        await user.deleteOne();

        return res.json({ success: true, message: 'Usuário excluído com sucesso.' });
    } catch (err) {
        console.error('[authController] deleteUser:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = { login, me, register, listUsers, updateUser, updateSenha, deleteUser };