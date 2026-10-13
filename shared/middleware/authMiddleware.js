/**
 * authMiddleware.js
 *
 * Aceita dois tipos de autenticação:
 *   1. SERVICE_API_KEY (header x-service-key) — comunicação interna entre microserviços
 *   2. Bearer JWT — autenticação de usuários
 *
 * Troca futura para Keycloak: substituir apenas a validação JWT por JWKS.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-em-producao';
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || '';

const authMiddleware = (req, res, next) => {
    // ── 1. Service-to-service via x-service-key ──────────────────────
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey) {
        if (!SERVICE_API_KEY) {
            return res.status(500).json({ success: false, message: 'SERVICE_API_KEY não configurada no servidor.' });
        }
        if (serviceKey === SERVICE_API_KEY) {
            req.user = { id: 'service', perfil: 'service' };
            return next();
        }
        return res.status(401).json({ success: false, message: 'Service key inválida.' });
    }

    // ── 2. Bearer JWT (usuário) ───────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Token não fornecido.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        return next();
    } catch (err) {
        const message =
            err.name === 'TokenExpiredError' ? 'Token expirado.' :
                err.name === 'JsonWebTokenError' ? 'Token inválido.' :
                    'Falha na autenticação.';
        return res.status(401).json({ success: false, message });
    }
};

const requirePerfil = (...perfis) => (req, res, next) => {
    // service key tem acesso total
    if (req.user?.id === 'service') return next();
    if (!perfis.includes(req.user?.perfil)) {
        return res.status(403).json({ success: false, message: 'Acesso não autorizado.' });
    }
    return next();
};

module.exports = { authMiddleware, requirePerfil };