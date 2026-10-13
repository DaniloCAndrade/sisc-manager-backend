// models/DynatracePlatformCredentials.js
const mongoose = require('mongoose');

/**
 * Credenciais de plataforma Dynatrace (Documents API, Account Management API).
 *
 * Suporta dois tipos mutuamente exclusivos:
 *   - platform_token : token direto dt0s16.xxx (mais simples, sem refresh)
 *   - oauth_client   : client_id + client_secret + account URN (OAuth2 flow)
 *
 * E duas finalidades (define QUAIS escopos são pedidos no OAuth2):
 *   - documents : Documents API / Grail (usado pelo svc-inventory e svc-apm)
 *   - license   : Account Management API (usado pelo svc-license)
 *
 * ⚠️ Um mesmo tenant pode (e frequentemente vai) ter DUAS credenciais —
 * uma de cada finalidade. Isso é esperado, não duplicidade — cada uma serve
 * um serviço diferente. NÃO existe unicidade forçada em (tenantRef,
 * finalidade) no banco de propósito: um tenant pode ter mais de uma
 * credencial "documents" (ex: rotação/backup), a rota de resolução sempre
 * pega a mais recente ativa.
 *
 * Relação com tenants: N credenciais → 1 tenant (ou nenhum = global)
 */
const platformCredentialsSchema = new mongoose.Schema({

  // ── Identificação ─────────────────────────────────────────────
  nome: {
    type: String,
    required: [true, 'Nome é obrigatório'],
    trim: true,
  },

  // Tenant associado (opcional — null = credencial global/compartilhada)
  tenantRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DynatraceTenants',
    default: null,
  },

  // ── Finalidade ────────────────────────────────────────────────
  // Decide quais escopos OAuth2 são pedidos ao gerar o bearer token.
  finalidade: {
    type: String,
    enum: ['documents', 'license'],
    default: 'documents',
    required: true,
  },

  // ── Tipo de credencial ────────────────────────────────────────
  tipo: {
    type: String,
    enum: ['platform_token', 'oauth_client'],
    required: true,
  },

  // ── Platform Token (dt0s16.xxx) ───────────────────────────────
  // Preenchido apenas quando tipo === 'platform_token'
  platformToken: {
    type: String,
    trim: true,
    default: null,
  },

  // ── OAuth Client ──────────────────────────────────────────────
  // Preenchidos apenas quando tipo === 'oauth_client'
  clientId: {
    type: String,
    trim: true,
    default: null,
  },
  clientSecret: {
    type: String,
    trim: true,
    default: null,
  },
  accountUrn: {
    // urn:dtaccount:xxxxx-aaaa-bbbb-cccc-dddddddddd
    // O Account UUID puro (usado na Account Management API) é o trecho
    // depois de "dtaccount:" — extraído sob demanda, não duplicado aqui.
    type: String,
    trim: true,
    default: null,
  },

  // ── Cache do Bearer token (OAuth2) ────────────────────────────
  // Gerenciado pelo backend — não exposto na UI
  _bearerToken: {
    type: String,
    select: false,   // não retorna em queries normais
    default: null,
  },
  _bearerExpiresAt: {
    type: Date,
    select: false,
    default: null,
  },

  // ── Metadados ─────────────────────────────────────────────────
  descricao: {
    type: String,
    default: null,
  },
  dataCriacao: {
    type: Date,
    default: Date.now,
  },
  ativo: {
    type: Boolean,
    default: true,
  },

}, { versionKey: false });

// Índices para busca rápida por tenant e por finalidade
platformCredentialsSchema.index({ tenantRef: 1 });
platformCredentialsSchema.index({ finalidade: 1, ativo: 1 });

module.exports = mongoose.model('DynatracePlatformCredentials', platformCredentialsSchema);