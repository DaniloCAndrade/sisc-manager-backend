require('dotenv').config();
const express = require('express');
const cors = require('cors');
const topPages = require('./routes/top-pages');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'UP',
        service: 'svc-apdex',
        timestamp: new Date().toISOString(),
    });
});

// ── Rotas ─────────────────────────────────────────────────────────
app.use('/api/apdex-analyze', topPages);

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint não encontrado.' });
});

app.listen(PORT, () => {
    console.log(`[svc-apdex] Rodando na porta ${PORT}`);
    console.log(`[svc-apdex] svc-platform-control: ${process.env.PLATFORM_CONTROL_URL || 'http://localhost:3002'}`);
});