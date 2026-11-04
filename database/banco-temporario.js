'use strict';

const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { criarConexao } = require('./conexao');
const { validarBancoTeste } = require('../configuracao/banco');
const { validarDestinoTeste } = require('../configuracao/operacoes-banco');

async function criarBancoTemporario(finalidade, variaveis = process.env) {
  const origem = validarBancoTeste(variaveis);
  if (!['exportacao', 'migracoes', 'sql', 'demonstracao'].includes(finalidade)) throw new Error('Finalidade de banco temporário inválida.');
  const nome = `leia_${finalidade}_${randomBytes(6).toString('hex')}_teste`;
  const endereco = new URL(origem.url); endereco.pathname = `/${nome}`;
  const ambiente = { ...variaveis, TEST_DATABASE_URL: endereco.href };
  validarBancoTeste(ambiente);
  const controle = new Client({ connectionString: origem.url, connectionTimeoutMillis: 3000 });
  let criado = false; let conexao;
  async function encerrar() {
    try {
      if (conexao) await conexao.close();
      if (criado) {
        // Só remove o nome imprevisível criado por esta chamada, nunca um banco
        // preexistente. Sem FORCE: conexões inesperadas impedem a remoção.
        validarBancoTeste(variaveis); validarBancoTeste(ambiente);
        if (conexao) validarDestinoTeste(conexao, ambiente);
        const { rows } = await controle.query('SELECT current_database() AS banco');
        if (rows[0].banco !== origem.nomeBanco || !/^leia_(exportacao|migracoes|sql|demonstracao)_[a-f0-9]{12}_teste$/.test(nome)) throw new Error('Destino temporário não confirmado.');
        await controle.query(`DROP DATABASE "${nome}"`); criado = false;
      }
    } finally { await controle.end(); }
  }
  try {
    await controle.connect();
    await controle.query(`CREATE DATABASE "${nome}" TEMPLATE template0`); criado = true;
    conexao = criarConexao(ambiente); validarDestinoTeste(conexao, ambiente);
    return { nome, variaveis: ambiente, conexao, encerrar };
  } catch (erro) { await encerrar(); throw erro; }
}

module.exports = { criarBancoTemporario };
