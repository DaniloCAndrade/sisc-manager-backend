const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
    nome: {
        type: String,
        required: [true, 'Nome é obrigatório'],
        trim: true,
    },
    email: {
        type: String,
        required: [true, 'Email é obrigatório'],
        unique: true,
        trim: true,
        lowercase: true,
        match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    senha: {
        type: String,
        required: [true, 'Senha é obrigatória'],
        select: false, // nunca retorna a senha em queries normais
    },
    perfil: {
        type: String,
        enum: ['admin', 'viewer'],
        default: 'viewer',
    },
    ativo: {
        type: Boolean,
        default: true,
    },
    isSeed: {
        type: Boolean,
        default: false,
    },
    criadoEm: {
        type: Date,
        default: Date.now,
    },
});

// Hash da senha antes de salvar
userSchema.pre('save', async function (next) {
    if (!this.isModified('senha')) return next();
    this.senha = await bcrypt.hash(this.senha, 12);
    next();
});

// Método para comparar senha
userSchema.methods.compararSenha = async function (senhaInformada) {
    return bcrypt.compare(senhaInformada, this.senha);
};

module.exports = mongoose.model('User', userSchema);