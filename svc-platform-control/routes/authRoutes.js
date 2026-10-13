const express = require('express');
const {
    login, me, register, listUsers,
    updateUser, updateSenha, deleteUser,
} = require('../controllers/authController');
const { authMiddleware, requirePerfil } = require('../middleware/authMiddleware');

const router = express.Router();

// ── Públicas ──────────────────────────────────────────────────────
router.post('/login', login);

router.post('/seed', async (req, res) => {
    const User = require('../models/User');
    try {
        const total = await User.countDocuments();
        if (total > 0)
            return res.status(403).json({ success: false, message: 'Setup já realizado.' });
        const { nome, email, senha } = req.body;
        if (!nome || !email || !senha)
            return res.status(400).json({ success: false, message: 'nome, email e senha são obrigatórios.' });
        const user = await User.create({ nome, email, senha, perfil: 'admin', isSeed: true });
        return res.status(201).json({
            success: true,
            message: 'Primeiro usuário admin criado com sucesso.',
            user: { id: user._id, nome: user.nome, email: user.email, perfil: user.perfil },
        });
    } catch (err) {
        console.error('[auth/seed]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── Autenticadas ──────────────────────────────────────────────────
router.get('/me', authMiddleware, me);

// ── Somente admin ─────────────────────────────────────────────────
router.post('/register', authMiddleware, requirePerfil('admin'), register);
router.get('/users', authMiddleware, requirePerfil('admin'), listUsers);
router.put('/users/:id', authMiddleware, requirePerfil('admin'), updateUser);
router.put('/users/:id/senha', authMiddleware, requirePerfil('admin'), updateSenha);
router.delete('/users/:id', authMiddleware, requirePerfil('admin'), deleteUser);

module.exports = router;