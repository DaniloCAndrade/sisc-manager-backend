require('dotenv').config();
const express = require('express');
const cors = require('cors');

const connectDB = require('./config/database');
const { authMiddleware } = require('./middleware/authMiddleware');
const absenceRoutes = require('./routes/absenceRoutes');
const collaboratorRoutes = require('./routes/collaboratorRoutes');
const dailyScheduleRouter = require('./routes/dailyScheduleRouter');
const programRoutes = require('./routes/programRoutes');
const exportRoutes = require('./routes/exportRoutes');

const app = express();
const PORT = process.env.PORT || 3006;

app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'UP', service: 'svc-schedule', timestamp: new Date().toISOString() });
});

// ── Rotas protegidas ──────────────────────────────────────────────
app.use('/api/absence', authMiddleware, absenceRoutes);
app.use('/api/collaborator', authMiddleware, collaboratorRoutes);
app.use('/api/dailySchedule', authMiddleware, dailyScheduleRouter);
app.use('/api/program', authMiddleware, programRoutes);
app.use('/api/export', authMiddleware, exportRoutes);

app.use((req, res) => res.status(404).json({ error: 'Endpoint não encontrado.' }));

async function start() {
    await connectDB();
    app.listen(PORT, () => console.log(`[svc-schedule] Rodando na porta ${PORT}`));
}

start().catch(err => {
    console.error('[svc-schedule] Erro fatal:', err);
    process.exit(1);
});