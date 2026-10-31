'use strict';

const { carregarAmbiente } = require('./ambiente');

const PRAZO_SESSAO_MS = 30 * 60 * 1000;
const NOME_COOKIE_SESSAO = 'leia.sid';

function carregarConfiguracaoSessao(variaveis = process.env) {
  const { ambiente, origemPermitida } = carregarAmbiente(variaveis);
  const segredo = variaveis.SESSION_SECRET;
  if (typeof segredo !== 'string' || segredo.trim().length === 0 || Buffer.byteLength(segredo, 'utf8') < 32) {
    throw new Error('SESSION_SECRET deve conter pelo menos 32 bytes UTF-8 e não pode ser vazio.');
  }

  const origemHttps = origemPermitida.startsWith('https:');
  const seguroInformado = variaveis.SESSION_COOKIE_SECURE ?? (origemHttps ? 'true' : 'false');
  if (!['true', 'false'].includes(seguroInformado)) {
    throw new Error('SESSION_COOKIE_SECURE deve ser true ou false.');
  }
  const secure = seguroInformado === 'true';
  if (ambiente === 'production' && !secure) {
    throw new Error('SESSION_COOKIE_SECURE deve ser true em production.');
  }
  if (origemHttps && !secure) {
    throw new Error('SESSION_COOKIE_SECURE deve ser true com origem HTTPS.');
  }

  return Object.freeze({
    segredo,
    nomeCookie: NOME_COOKIE_SESSAO,
    prazoMs: PRAZO_SESSAO_MS,
    cookie: Object.freeze({
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: PRAZO_SESSAO_MS,
    }),
  });
}

module.exports = { carregarConfiguracaoSessao, PRAZO_SESSAO_MS, NOME_COOKIE_SESSAO };
