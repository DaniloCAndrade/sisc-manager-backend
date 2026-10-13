// routes/Dynatrace/dynaPlatformCredentialsRoutes.js

const express = require('express');
const router = express.Router();

const PlatformCredentials = require('../models/DynatracePlatformCredentials');
const { SCOPES_REPORTS_MINIMAL, SCOPES_LICENSE } = require('../constants/dynatraceScopes');
const DynatraceTenants = require('../models/DynatraceTenants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskSecret(str) {
  if (!str) return null;
  const parts = str.split('.');
  if (parts.length >= 2) return parts[0] + '.' + parts[1] + '.' + '•'.repeat(12);
  return str.slice(0, 8) + '•'.repeat(12);
}

// Account URN: urn:dtaccount:xxxxx-aaaa-bbbb-cccc-dddddddddd
// O Account UUID puro (usado na Account Management API) é tudo depois do
// último ":" — extraído sob demanda, não duplicado no schema.
function extractAccountUuid(accountUrn) {
  if (!accountUrn) return null;
  const parts = accountUrn.split(':');
  return parts[parts.length - 1] || null;
}

// Escopo do OAuth2 depende da finalidade da credencial
function scopesForFinalidade(finalidade) {
  return finalidade === 'license' ? SCOPES_LICENSE : SCOPES_REPORTS_MINIMAL;
}

async function resolveBearerToken(credDoc) {
  if (credDoc._bearerToken && credDoc._bearerExpiresAt && credDoc._bearerExpiresAt > new Date()) {
    return credDoc._bearerToken;
  }

  const tokenUrl = 'https://sso.dynatrace.com/sso/oauth2/token';
  const scopeList = scopesForFinalidade(credDoc.finalidade);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credDoc.clientId,
    client_secret: credDoc.clientSecret,
    scope: scopeList.join(' '),
  });

  console.log('[OAuth2] tokenUrl:', tokenUrl, '| finalidade:', credDoc.finalidade);
  console.log('[OAuth2] client_id:', credDoc.clientId?.slice(0, 20) + '...');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json().catch(() => ({}));
  console.log('[OAuth2] status:', response.status, '| scopes:', data.scope?.slice(0, 100));

  if (!response.ok || !data.access_token) {
    const msg = data.error_description || data.error || data.message || `OAuth2 falhou: HTTP ${response.status}`;
    throw new Error(msg);
  }

  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  await PlatformCredentials.findByIdAndUpdate(credDoc._id, {
    _bearerToken: data.access_token,
    _bearerExpiresAt: expiresAt,
  });

  return data.access_token;
}

function toPlatformUrl(baseUrl) {
  return baseUrl.replace('.live.dynatrace.com', '.apps.dynatrace.com');
}

async function resolveAuthHeader(credDoc) {
  if (credDoc.tipo === 'platform_token') return `Bearer ${credDoc.platformToken}`;
  const bearer = await resolveBearerToken(credDoc);
  return `Bearer ${bearer}`;
}

// ---------------------------------------------------------------------------
// GET /  (?finalidade=documents|license opcional, filtra a listagem)
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const filter = { ativo: true };
    if (req.query.finalidade) filter.finalidade = req.query.finalidade;

    const docs = await PlatformCredentials.find(filter)
      .populate('tenantRef', 'nome label tenantId')
      .lean();

    const list = docs.map((doc) => ({
      _id: doc._id,
      nome: doc.nome,
      tipo: doc.tipo,
      finalidade: doc.finalidade,
      tenantRef: doc.tenantRef,
      descricao: doc.descricao,
      dataCriacao: doc.dataCriacao,
      platformToken: doc.tipo === 'platform_token' ? maskSecret(doc.platformToken) : null,
      clientId: doc.tipo === 'oauth_client' ? doc.clientId : null,
      clientSecret: doc.tipo === 'oauth_client' ? maskSecret(doc.clientSecret) : null,
      accountUrn: doc.tipo === 'oauth_client' ? doc.accountUrn : null,
    }));

    return res.json(list);
  } catch (err) {
    console.error('[platform-creds/GET]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { nome, tipo, finalidade, tenantRef, descricao, platformToken, clientId, clientSecret, accountUrn } = req.body;

  if (!nome || !tipo)
    return res.status(400).json({ success: false, message: 'nome e tipo são obrigatórios.' });
  if (tipo === 'platform_token' && !platformToken)
    return res.status(400).json({ success: false, message: 'platformToken é obrigatório.' });
  if (tipo === 'oauth_client' && (!clientId || !clientSecret || !accountUrn))
    return res.status(400).json({ success: false, message: 'clientId, clientSecret e accountUrn são obrigatórios.' });

  try {
    const doc = await PlatformCredentials.create({
      nome, tipo,
      finalidade: finalidade === 'license' ? 'license' : 'documents',
      descricao: descricao || null,
      tenantRef: tenantRef || null,
      platformToken: tipo === 'platform_token' ? platformToken : null,
      clientId: tipo === 'oauth_client' ? clientId : null,
      clientSecret: tipo === 'oauth_client' ? clientSecret : null,
      accountUrn: tipo === 'oauth_client' ? accountUrn : null,
    });
    return res.status(201).json({ success: true, _id: doc._id, nome: doc.nome, tipo: doc.tipo, finalidade: doc.finalidade });
  } catch (err) {
    console.error('[platform-creds/POST]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /:id
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  const { nome, descricao, finalidade, tenantRef, platformToken, clientId, clientSecret, accountUrn } = req.body;
  try {
    const update = { nome, descricao: descricao || null, tenantRef: tenantRef || null };
    if (finalidade) update.finalidade = finalidade === 'license' ? 'license' : 'documents';
    if (platformToken) update.platformToken = platformToken;
    if (clientId) update.clientId = clientId;
    if (accountUrn) update.accountUrn = accountUrn;
    if (clientSecret) {
      update.clientSecret = clientSecret;
      update._bearerToken = null;
      update._bearerExpiresAt = null;
    }
    await PlatformCredentials.findByIdAndUpdate(req.params.id, update);
    return res.json({ success: true });
  } catch (err) {
    console.error('[platform-creds/PUT]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id (soft delete)
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    await PlatformCredentials.findByIdAndUpdate(req.params.id, { ativo: false });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /by-tenant/:tenantId  (?finalidade=documents|license, default documents)
// ---------------------------------------------------------------------------
router.get('/by-tenant/:tenantId', async (req, res) => {
  try {
    const finalidade = req.query.finalidade === 'license' ? 'license' : 'documents';
    const doc = await PlatformCredentials.findOne({ tenantRef: req.params.tenantId, finalidade, ativo: true }).lean();
    if (!doc) return res.status(404).json({ success: false, message: `Nenhuma credencial (${finalidade}) para este tenant.` });
    return res.json({ success: true, tipo: doc.tipo, finalidade: doc.finalidade, hasCredential: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/test
// ⚠️ O teste de conexão continua específico da Documents API — só faz
// sentido pra credenciais finalidade=documents (precisa de um tenant
// associado com baseUrl). Credenciais de license não têm um teste
// equivalente implementado ainda.
// ---------------------------------------------------------------------------
router.post('/:id/test', async (req, res) => {
  try {
    const credDoc = await PlatformCredentials
      .findById(req.params.id)
      .select('+_bearerToken +_bearerExpiresAt +platformToken +clientId +clientSecret +accountUrn')
      .lean();
    if (!credDoc) return res.status(404).json({ success: false, message: 'Credencial não encontrada.' });

    if (credDoc.finalidade === 'license') {
      return res.status(400).json({ success: false, message: 'Teste de conexão ainda não implementado para credenciais de licenciamento.' });
    }

    const tenantDoc = await DynatraceTenants.findById(credDoc.tenantRef).lean();
    if (!tenantDoc) return res.status(404).json({ success: false, message: 'Tenant associado não encontrado.' });

    const authHeader = await resolveAuthHeader(credDoc);
    const platformBase = toPlatformUrl(tenantDoc.baseUrl);
    const testUrl = new URL(`${platformBase}/platform/document/v1/documents`);
    testUrl.searchParams.set('filter', "type='dashboard'");
    testUrl.searchParams.set('page-size', '1');

    const testResponse = await fetch(testUrl.toString(), {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    const responseData = await testResponse.json().catch(() => ({}));

    if (testResponse.ok) {
      return res.json({ success: true, message: 'Credencial válida — Documents API acessível.', docCount: responseData.totalCount ?? '?' });
    }
    return res.status(testResponse.status).json({
      success: false,
      message: responseData?.error?.message || `HTTP ${testResponse.status}`,
    });
  } catch (err) {
    console.error('[platform/test] Erro:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /resolve-bearer/:tenantId  (?finalidade=documents|license, default documents)
// Endpoint interno para outros microserviços (svc-inventory, svc-apm, svc-license)
// ---------------------------------------------------------------------------
router.get('/resolve-bearer/:tenantId', async (req, res) => {
  try {
    const finalidade = req.query.finalidade === 'license' ? 'license' : 'documents';

    const credDoc = await PlatformCredentials
      .findOne({ tenantRef: req.params.tenantId, finalidade, ativo: true })
      .select('+_bearerToken +_bearerExpiresAt +platformToken +clientId +clientSecret +accountUrn')
      .lean();

    if (!credDoc) return res.status(404).json({ success: false, message: `Nenhuma credencial (${finalidade}) ativa para este tenant.` });

    const header = await resolveAuthHeader(credDoc);
    return res.json({ success: true, header });
  } catch (err) {
    console.error('[resolve-bearer] Erro:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /license-accounts
// Endpoint interno para o svc-license — lista TODAS as contas Dynatrace
// (uma por tenant, tipicamente) que têm credencial de licenciamento
// cadastrada, já com o bearer resolvido e o Account UUID extraído.
// ---------------------------------------------------------------------------
router.get('/license-accounts', async (req, res) => {
  try {
    const docs = await PlatformCredentials
      .find({ finalidade: 'license', ativo: true })
      .populate('tenantRef', 'nome label tenantId')
      .select('+_bearerToken +_bearerExpiresAt +platformToken +clientId +clientSecret +accountUrn')
      .lean();

    const accounts = [];
    for (const credDoc of docs) {
      const accountUuid = extractAccountUuid(credDoc.accountUrn);
      if (!accountUuid) {
        console.warn(`[license-accounts] Credencial ${credDoc._id} (${credDoc.nome}) sem accountUrn válido — ignorada.`);
        continue;
      }
      try {
        const header = await resolveAuthHeader(credDoc);
        accounts.push({
          credentialId: credDoc._id,
          nome: credDoc.nome,
          tenant: credDoc.tenantRef
            ? { id: credDoc.tenantRef._id, nome: credDoc.tenantRef.nome, label: credDoc.tenantRef.label }
            : null,
          accountUuid,
          authHeader: header,
        });
      } catch (err) {
        console.error(`[license-accounts] Falha ao resolver bearer de ${credDoc.nome}:`, err.message);
        // não derruba a lista inteira por causa de uma credencial com problema
      }
    }

    return res.json({ success: true, accounts });
  } catch (err) {
    console.error('[license-accounts] Erro:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;