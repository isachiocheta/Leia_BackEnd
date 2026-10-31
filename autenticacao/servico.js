'use strict';

const { Pool } = require('pg');
const banco = require('../database/conexao');
const { carregarConfiguracaoSessao } = require('../configuracao/sessao');
const { criarAutenticacao } = require('./rotas');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');

let autenticacao;
let pool;

function obterAutenticacao() {
  if (autenticacao) return autenticacao;
  const configuracao = carregarConfiguracaoSessao();
  const opcoes = banco.criarOpcoesConexao();
  pool = new Pool({
    host: opcoes.host,
    port: opcoes.port,
    user: opcoes.username,
    password: opcoes.password,
    database: opcoes.database,
    ssl: opcoes.dialectOptions.ssl,
    max: 3,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    statement_timeout: 3000,
  });
  pool.on('error', () => console.error('Conexão de sessões indisponível.'));
  autenticacao = criarAutenticacao({
    configuracao,
    pool,
    obterUsuario: () => banco.obterConexao().models.Usuario,
  });
  return autenticacao;
}

function atenderAutenticacao(requisicao, resposta, proximo) {
  try {
    return obterAutenticacao().roteador(requisicao, resposta, proximo);
  } catch {
    return proximo(new ErroAplicacao('SERVICE_UNAVAILABLE'));
  }
}

async function encerrarAutenticacao() {
  try {
    if (autenticacao) await autenticacao.encerrar();
  } finally {
    autenticacao = undefined;
    const poolAtual = pool;
    pool = undefined;
    if (poolAtual) await poolAtual.end();
  }
}

module.exports = { atenderAutenticacao, encerrarAutenticacao };
