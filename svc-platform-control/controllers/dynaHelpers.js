/**
 * dynaHelpers.js
 * Funções utilitárias compartilhadas pelos controllers Dynatrace
 * dentro do svc-platform-control.
 */

const axios = require('axios');

/**
 * Cria um client axios pré-configurado para um tenant Dynatrace.
 * @param {Object} tenant - documento DynatraceTenants (com baseUrl e apiToken)
 */
function createDynaClient(tenant) {
  return axios.create({
    baseURL: tenant.baseUrl.replace(/\/$/, ''),
    headers: {
      Authorization: `Api-Token ${tenant.apiToken}`,
      Accept:        'application/json; charset=utf-8',
    },
  });
}

/**
 * Monta a expressão de filtro de tag para uso em entitySelector do Dynatrace.
 * Ex: key="env", value="prod" → tag("env:prod")
 * @param {string} key
 * @param {string} [value]
 */
function buildServiceTagFilterExpression(key, value) {
  if (!key) return '';
  const tagExpr = value ? `${key}:${value}` : key;
  return `,tag("${tagExpr}")`;
}

module.exports = { createDynaClient, buildServiceTagFilterExpression };