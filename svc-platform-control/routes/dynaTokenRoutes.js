/**
 * dynaTokenRoutes.js
 * Rota para criação de API Token no tenant Dynatrace via backend.
 * Evita CORS — o browser não consegue chamar o Dynatrace diretamente.
 *
 * Registre no server.js:
 *   const dynaTokenRoutes = require('./routes/Dynatrace/dynaTokenRoutes');
 *   app.use('/api/dynatrace/tokens', dynaTokenRoutes);
 */

const express = require('express');
const router  = express.Router();

// Escopos padrão do ReportAPI_v2
const REPORT_API_SCOPES = [
  'activeGates.read', 'activeGateTokenManagement.read',
  'adaptiveTrafficManagement.read', 'agentTokenManagement.read',
  'apiTokens.read', 'attacks.read', 'auditLogs.read',
  'entities.read', 'events.read',
  'extensionConfigurations.read', 'extensionDiscoveryJmx.read',
  'extensionEnvironment.read', 'extensions.read',
  'geographicRegions.read', 'hub.read',
  'javaScriptMappingFiles.read', 'logs.read', 'metrics.read',
  'networkZones.read', 'oneAgents.read', 'problems.read',
  'releases.read', 'rumCookieNames.read', 'rumManualInsertionTags.read',
  'securityProblems.read', 'settings.read', 'slo.read',
  'syntheticExecutions.read', 'syntheticLocations.read',
  'tenantTokenRotation.write', 'traces.lookup', 'unifiedAnalysis.read',
  'CaptureRequestData', 'credentialVault.read', 'DataExport',
  'DssFileManagement', 'DTAQLAccess', 'ExternalSyntheticIntegration',
  'ReadConfig', 'ReadSyntheticData', 'RumJavaScriptTagManagement',
  'UserSessionAnonymization', 'AdvancedSyntheticIntegration',
];

// ---------------------------------------------------------------------------
// POST /api/dynatrace/tokens/generate
//
// Body: { baseUrl: string, adminToken: string, tokenName?: string }
//
// Cria o token ReportAPI_v2 no tenant usando o adminToken informado,
// e devolve o valor do token gerado para ser salvo no banco.
// ---------------------------------------------------------------------------
router.post('/generate', async (req, res) => {
  const { baseUrl, adminToken, tokenName = 'ReportAPI_v2' } = req.body;

  if (!baseUrl || !adminToken) {
    return res.status(400).json({
      success: false,
      message: 'baseUrl e adminToken são obrigatórios.',
    });
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/v2/apiTokens`;

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Accept':        'application/json; charset=utf-8',
        'Content-Type':  'application/json; charset=utf-8',
        'Authorization': `Api-Token ${adminToken}`,
      },
      body: JSON.stringify({ name: tokenName, scopes: REPORT_API_SCOPES }),
    });

    const data = await response.json();

    if (!response.ok) {
      // Repassa a mensagem de erro do Dynatrace
      const message =
        data?.error?.message ||
        data?.message ||
        `HTTP ${response.status} ao criar token no Dynatrace.`;
      return res.status(response.status).json({ success: false, message });
    }

    // data.token contém o valor do token gerado (só disponível na criação)
    return res.json({
      success:   true,
      token:     data.token,
      tokenId:   data.id,
      tokenName: data.name,
    });

  } catch (err) {
    console.error('[dynaTokenRoutes] Erro ao gerar token:', err.message);
    return res.status(500).json({
      success: false,
      message: `Falha de rede ao conectar ao tenant: ${err.message}`,
    });
  }
});

module.exports = router;