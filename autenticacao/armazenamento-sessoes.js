'use strict';

const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { PRAZO_SESSAO_MS } = require('../configuracao/sessao');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

function criarArmazenamentoSessoes({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Informe o pool PostgreSQL para armazenar sessões.');
  }

  const armazenamento = new PgStore({
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
  // O express-session também salva/destrói sessões internamente, inclusive ao
  // concluir uma resposta. Sanitizamos na fronteira do store para que esses
  // callbacks nunca propaguem SQL, parâmetros ou credenciais do driver.
  for (const metodo of ['get', 'set', 'destroy', 'touch']) {
    const executar = armazenamento[metodo].bind(armazenamento);
    armazenamento[metodo] = (...argumentos) => {
      const concluir = argumentos.at(-1);
      if (typeof concluir === 'function') {
        argumentos[argumentos.length - 1] = (erro, ...resultados) => (
          concluir(erro ? new ErroAplicacao('SERVICE_UNAVAILABLE') : null, ...resultados)
        );
      }
      try { return executar(...argumentos); }
      catch { throw new ErroAplicacao('SERVICE_UNAVAILABLE'); }
    };
  }
  return armazenamento;
}

module.exports = { criarArmazenamentoSessoes };
