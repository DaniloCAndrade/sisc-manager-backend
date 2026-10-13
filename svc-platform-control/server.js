require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const connectDB = require('./config/database');
const DynatraceTenants = require('./models/DynatraceTenants');

// ── Rotas ─────────────────────────────────────────────────────────
const healthRoutes = require('./routes/healthRoutes');
const authRoutes = require('./routes/authRoutes');
const configRoutes = require('./routes/config');
const dynaTenantsRoutes = require('./routes/dynaTenantsRoutes');
const dynaPlatformCredentialsRoutes = require('./routes/dynaPlatformCredentialsRoutes');
const dynaTokenRoutes = require('./routes/dynaTokenRoutes');
const dynaInventoryStateRoutes = require('./routes/dynaInventoryStateRoutes');

const { authMiddleware } = require('./middleware/authMiddleware');

const app = express();
const PORT = process.env.PORT || 3002;
const CACHE_INTERVAL_MS = parseInt(process.env.TENANTS_CACHE_INTERVAL_MS || '300000', 10);

// ── Middleware ────────────────────────────────────────────────────
app.use(cors());
// Aumenta o limite padrão (100kb) do body parser — o svc-inventory envia o
// resultado completo do inventário (POST .../complete), que pode passar de
// vários MB em tenants grandes antes de comprimir no lado do svc-platform-control.
app.use(express.json({ limit: '50mb' }));

// ── Cache de tenants ──────────────────────────────────────────────
const tenantsById = new Map();

async function loadTenantsFromDB() {
    try {
        const docs = await DynatraceTenants.find({}).lean();
        tenantsById.clear();
        docs.forEach((doc) => {
            tenantsById.set(String(doc._id), {
                id: String(doc._id),
                label: doc.label || doc.nome,
                nome: doc.nome,
                tenantId: doc.tenantId,
                baseUrl: doc.baseUrl,
                apiToken: doc.apiToken,
                api: axios.create({
                    baseURL: doc.baseUrl.replace(/\/$/, ''),
                    headers: { Authorization: `Api-Token ${doc.apiToken}` },
                }),
            });
        });
        console.log(`[svc-platform-control] Cache atualizado — ${tenantsById.size} tenant(s).`);
    } catch (err) {
        console.error('[svc-platform-control] Erro ao carregar tenants:', err.message);
    }
}

function resolveTenantFromReq(req) {
    const rawId = req.headers['x-tenant-id'] || req.query.tenantId;
    if (!rawId) throw new Error('Tenant não informado (header x-tenant-id ou query ?tenantId=)');
    const tenant = tenantsById.get(String(rawId));
    if (!tenant) throw new Error(`Tenant não encontrado no cache: ${rawId}`);
    return { tenant, system: null };
}

function getTenantClient(req) {
    const { tenant } = resolveTenantFromReq(req);
    return tenant.api;
}

app.locals.getTenantClient = getTenantClient;
app.locals.resolveTenantFromReq = resolveTenantFromReq;
app.locals.tenantsById = tenantsById;
app.locals.reloadTenants = loadTenantsFromDB;

// ── Rotas públicas ────────────────────────────────────────────────
app.use('/', healthRoutes);
app.use('/api/auth', authRoutes);

// ── Rotas protegidas ──────────────────────────────────────────────
app.use('/api/config', authMiddleware, configRoutes);
app.use('/api/dynaTenant', authMiddleware, dynaTenantsRoutes);
app.use('/api/dynatrace/platform-credentials', authMiddleware, dynaPlatformCredentialsRoutes);
app.use('/api/dynatrace/tokens', authMiddleware, dynaTokenRoutes);
// Endpoint interno consumido pelo svc-inventory (autenticação via x-service-key)
// para persistir estado/cache do inventário compartilhado entre réplicas.
app.use('/api/dynatrace/inventory-state', authMiddleware, dynaInventoryStateRoutes);

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint não encontrado.' });
});

async function start() {
    await connectDB();
    await loadTenantsFromDB();
    setInterval(loadTenantsFromDB, CACHE_INTERVAL_MS);
    app.listen(PORT, () => {
        console.log(`[svc-platform-control] Rodando na porta ${PORT}`);
    });
}

start().catch((err) => {
    console.error('[svc-platform-control] Erro fatal:', err);
    process.exit(1);
});