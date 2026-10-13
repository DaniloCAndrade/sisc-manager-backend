require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const { authMiddleware } = require('./middleware/authMiddleware');
const dynaLicenseRoutes = require('./routes/dynaLicenseRoutes');

const app = express();
const PORT = process.env.PORT || 3007;

app.use(compression());
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'svc-license', timestamp: new Date().toISOString() }));
app.get('/svc/license/health', (req, res) => res.json({ status: 'UP', service: 'svc-license', timestamp: new Date().toISOString() }));

// Dados sempre ao vivo (consumo Dynatrace muda a cada consulta) — sem isso,
// navegador/CDN no meio do caminho pode devolver uma resposta 304 antiga
// em vez de buscar de novo, mostrando números desatualizados.
const noCache = (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
};

// Mesmo padrão de strip de prefixo dos outros serviços (Envoy)
app.use('/api/license', noCache, authMiddleware, dynaLicenseRoutes);
app.use('/svc/license/api/license', noCache, authMiddleware, dynaLicenseRoutes);

app.use((req, res) => res.status(404).json({ error: 'Endpoint não encontrado.' }));

app.listen(PORT, () => {
    console.log(`[svc-license] Rodando na porta ${PORT}`);
});