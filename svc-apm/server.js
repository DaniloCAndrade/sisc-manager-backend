require('dotenv').config();
const express = require('express');
const cors = require('cors');

const infrastructureRoutes = require('./routes/infrastructure');
const servicesRoutes = require('./routes/services');
const userExperienceRoutes = require('./routes/userExperience');
const reportRoutes = require('./routes/reportRoutes');

const app = express();
const PORT = process.env.PORT || 3004;

app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'UP',
        service: 'svc-apm',
        timestamp: new Date().toISOString(),
    });
});

// ── Rotas ─────────────────────────────────────────────────────────
// Mantém os mesmos prefixos do monólito para não quebrar o frontend
app.use('/api/infra', infrastructureRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/user', userExperienceRoutes);

app.use('/api/report', reportRoutes);

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint não encontrado.' });
});

app.listen(PORT, () => {
    console.log(`[svc-apm] Rodando na porta ${PORT}`);
    console.log(`[svc-apm] svc-platform-control: ${process.env.PLATFORM_CONTROL_URL || 'http://localhost:3002'}`);
});