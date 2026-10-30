'use strict';

const { Sequelize } = require('sequelize');
const { Client } = require('pg');
const { carregarConfiguracaoBanco } = require('../configuracao/banco');
const { definirModelos } = require('./modelos/definir-modelos');

let conexao;

function criarOpcoesConexao(variaveis = process.env) {
  const configuracao = carregarConfiguracaoBanco(variaveis);
  const endereco = new URL(configuracao.url);
  if (!endereco.port) endereco.port = '5432';
  // O próprio driver interpreta credenciais codificadas e sslmode, sem conectar.
  // CLI e aplicação recebem exatamente o mesmo destino já validado.
  const parametros = new Client({ connectionString: endereco.href }).connectionParameters;

  return {
    ...configuracao.opcoes,
    database: parametros.database,
    username: parametros.user,
    password: parametros.password,
    host: parametros.host,
    port: parametros.port,
    dialectOptions: { ...configuracao.opcoes.dialectOptions, ssl: parametros.ssl },
  };
}

function criarConexao(variaveis = process.env) {
  const instancia = new Sequelize(criarOpcoesConexao(variaveis));
  definirModelos(instancia);
  return instancia;
}

function obterConexao() {
  if (!conexao) conexao = criarConexao();
  return conexao;
}

async function verificarConexao(instancia = obterConexao()) {
  await instancia.authenticate();
}

async function encerrarConexao() {
  if (!conexao) return;
  await conexao.close();
  conexao = undefined;
}

module.exports = { criarOpcoesConexao, criarConexao, obterConexao, verificarConexao, encerrarConexao };
