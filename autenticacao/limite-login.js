'use strict';

const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

function criarLimiteLogin({ maximo = 10, janelaMs = 15 * 60 * 1000, agora = Date.now } = {}) {
  if (!Number.isInteger(maximo) || maximo < 1 || !Number.isSafeInteger(janelaMs) || janelaMs < 1) {
    throw new TypeError('Limite de login inválido.');
  }
  // Limite por IP para esta instalação. Não guarda email, senha, SID ou token.
  // A aplicação não confia em X-Forwarded-For enviado diretamente pelo cliente.
  const tentativas = new Map();
  return (requisicao, resposta, proximo) => {
    const instante = agora();
    for (const [chave, entrada] of tentativas) {
      if (entrada.fim <= instante) tentativas.delete(chave);
    }
    const ip = requisicao.ip || requisicao.socket.remoteAddress;
    let entrada = tentativas.get(ip);
    if (!entrada) {
      // Memória limitada; contador destinado ao único processo desta instalação.
      if (tentativas.size >= 10000) tentativas.delete(tentativas.keys().next().value);
      entrada = { total: 0, fim: instante + janelaMs };
      tentativas.set(ip, entrada);
    }
    if (entrada.total >= maximo) {
      resposta.set('Retry-After', String(Math.max(1, Math.ceil((entrada.fim - instante) / 1000))));
      return proximo(new ErroAplicacao('TOO_MANY_REQUESTS'));
    }
    entrada.total += 1;
    return proximo();
  };
}

module.exports = { criarLimiteLogin };
