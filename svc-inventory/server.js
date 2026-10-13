require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const { authMiddleware } = require('./middleware/authMiddleware');
const dynaInventoryRoutes = require('./routes/dynaInventoryRoutes');
const inventoryController = require('./controllers/dynaInventoryController');

const app = express();
const PORT = process.env.PORT || 3003;

// Compressão gzip das respostas — reduz bastante o tamanho de payloads
// grandes (ex: inventário do DETRAN, com milhares de entidades), diminuindo
// tempo de transferência e a chance de estourar timeout de gateway/proxy.
// Precisa vir ANTES das rotas.
app.use(compression());

app.use(cors());
app.use(express.json());

// ── Health (ambos os prefixos por segurança) ──────────────────────
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'svc-inventory', timestamp: new Date().toISOString() }));
app.get('/svc/inventory/health', (req, res) => res.json({ status: 'UP', service: 'svc-inventory', timestamp: new Date().toISOString() }));

// ── Rota de agendamento externo (cron) ─────────────────────────────
// Dispara a coleta de TODOS os tenants — pensada para ser chamada por um
// serviço externo de agendamento (ex: cron-job.org) uma vez ao dia.
// Protegida por uma chave própria (CRON_SECRET) — NÃO usa o authMiddleware
// normal (JWT de usuário / x-service-key interno), porque quem chama isso
// é um site externo de cron, não um usuário logado nem outro microserviço.
// Configure CRON_SECRET nas variáveis de ambiente e use a mesma chave na
// URL configurada no serviço de agendamento: .../run-all?key=SEU_SEGREDO
function cronAuth(req, res, next) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return res.status(500).json({ success: false, message: 'CRON_SECRET não configurada no servidor.' });
    }
    if (req.query.key !== secret) {
        return res.status(401).json({ success: false, message: 'Chave inválida.' });
    }
    return next();
}

app.post('/api/cron/inventory/run-all', cronAuth, inventoryController.runAllInventories);
app.post('/svc/inventory/api/cron/inventory/run-all', cronAuth, inventoryController.runAllInventories);

// ── Rotas protegidas ──────────────────────────────────────────────
// Sem prefixo  → Envoy faz strip de /svc/inventory antes de repassar
// Com prefixo  → Envoy repassa a URL completa sem strip
app.use('/api/dynatrace/inventory', authMiddleware, dynaInventoryRoutes);
app.use('/svc/inventory/api/dynatrace/inventory', authMiddleware, dynaInventoryRoutes);

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Endpoint não encontrado.' }));

app.listen(PORT, () => {
    console.log(`[svc-inventory] Rodando na porta ${PORT}`);
    console.log(`[svc-inventory] svc-platform-control: ${process.env.PLATFORM_CONTROL_URL || 'http://localhost:3002'}`);
});