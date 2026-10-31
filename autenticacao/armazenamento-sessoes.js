'use strict';

const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { PRAZO_SESSAO_MS } = require('../configuracao/sessao');

function criarArmazenamentoSessoes({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Informe o pool PostgreSQL para armazenar sessões.');
  }

  return new PgStore({
    pool,
    tableName: 'sessoes',
    createTableIfMissing: false,
    // A expiração absoluta também é verificada pelo middleware no servidor.
    // Leituras e polling não devem atualizar o prazo persistido no PostgreSQL.
    disableTouch: true,
    ttl: PRAZO_SESSAO_MS / 1000,
    // Não inicia tarefas de banco ao importar a aplicação. O store ignora
    // sessões expiradas mesmo quando as linhas ainda aguardam limpeza.
    pruneSessionInterval: false,
    errorLog() {
      console.error('Falha no armazenamento de sessões.');
    },
  });
}

module.exports = { criarArmazenamentoSessoes };
