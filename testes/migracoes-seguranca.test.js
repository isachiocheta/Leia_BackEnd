'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Sequelize = require('sequelize');
const migracoes = [
  ['usuários', require('../database/migracoes/20261030010000-completar-usuarios')],
  ['sessões', require('../database/migracoes/20261030011000-criar-sessoes')],
  ['gêneros', require('../database/migracoes/20261030020000-ajustar-generos')],
  ['livros', require('../database/migracoes/20261030021000-completar-livros')],
];

const ambienteSeguro = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://usuario:senha@localhost:5432/leia_mais',
  TEST_DATABASE_URL: 'postgresql://usuario:senha@localhost:5432/leia_mais_teste',
};

async function comAmbiente(variaveis, executar) {
  const anteriores = {};

  for (const [nome, valor] of Object.entries(variaveis)) {
    anteriores[nome] = process.env[nome];
    process.env[nome] = valor;
  }

  try {
    await executar();
  } finally {
    for (const [nome, valor] of Object.entries(anteriores)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  }
}

function criarInterface(nomeBanco) {
  const chamadas = { transacoes: 0, sql: 0, ddl: 0 };
  const queryInterface = {
    sequelize: {
      config: { database: nomeBanco, host: 'localhost', port: 5432 },
      getDialect: () => 'postgres',
      transaction: async (executar) => {
        chamadas.transacoes += 1;
        return executar({});
      },
      query: async () => { chamadas.sql += 1; },
    },
  };

  for (const operacao of ['dropTable', 'removeConstraint', 'changeColumn', 'removeColumn']) {
    queryInterface[operacao] = async () => { chamadas.ddl += 1; };
  }

  return { queryInterface, chamadas };
}

for (const [nome, migracao] of migracoes) {
  test(`rollback de ${nome} exige ambiente de teste antes de tocar no banco`, async () => {
    const { queryInterface, chamadas } = criarInterface('leia_mais_teste');

    await comAmbiente({ ...ambienteSeguro, NODE_ENV: 'production' }, async () => {
      await assert.rejects(migracao.down(queryInterface, Sequelize), /NODE_ENV/);
    });

    assert.deepEqual(chamadas, { transacoes: 0, sql: 0, ddl: 0 });
  });

  test(`rollback de ${nome} bloqueia a conexão normal mesmo com URLs de teste válidas`, async () => {
    const { queryInterface, chamadas } = criarInterface('leia_mais');

    await comAmbiente(ambienteSeguro, async () => {
      await assert.rejects(migracao.down(queryInterface, Sequelize), /conexão diferente/);
    });

    assert.deepEqual(chamadas, { transacoes: 0, sql: 0, ddl: 0 });
  });
}
