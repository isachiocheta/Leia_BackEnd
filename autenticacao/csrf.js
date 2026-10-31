'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

function obterTokenCsrf(sessao) {
  if (!sessao.csrfToken) sessao.csrfToken = randomBytes(32).toString('hex');
  return sessao.csrfToken;
}

function protegerCsrf(requisicao, resposta, proximo) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(requisicao.method)) return proximo();
  // O token fica associado à sessão no servidor. Não é recebido por query,
  // cookie legível pelo JavaScript ou corpo que possa aparecer em logs.
  const informado = requisicao.get('X-CSRF-Token');
  const esperado = requisicao.session?.csrfToken;
  if (
    typeof informado !== 'string' || !/^[a-f0-9]{64}$/.test(informado) ||
    typeof esperado !== 'string' || !/^[a-f0-9]{64}$/.test(esperado) ||
    !timingSafeEqual(Buffer.from(informado, 'hex'), Buffer.from(esperado, 'hex'))
  ) return proximo(new ErroAplicacao('FORBIDDEN'));
  return proximo();
}

module.exports = { obterTokenCsrf, protegerCsrf };
