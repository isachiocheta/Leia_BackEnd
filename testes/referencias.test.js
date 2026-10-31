'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const referencia = require('../database/semeadores/referencias/20261030061000-carregar-generos-referencia');

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

function criarInterface(database) {
  const chamadas = { transacoes: 0, consultas: 0 };
  return {
    chamadas,
    queryInterface: {
      sequelize: {
        config: { database, host: 'localhost', port: 5432 },
        getDialect: () => 'postgres',
        transaction: async (executar) => {
          chamadas.transacoes += 1;
          await executar({});
        },
        query: async () => { chamadas.consultas += 1; },
      },
    },
  };
}

test('reversão de referências bloqueia produção antes de consultar ou alterar o banco', async () => {
  const { chamadas, queryInterface } = criarInterface('leia_mais_teste');

  await comAmbiente({ ...ambienteSeguro, NODE_ENV: 'production' }, async () => {
    await assert.rejects(referencia.down(queryInterface), /NODE_ENV/);
  });

  assert.deepEqual(chamadas, { transacoes: 0, consultas: 0 });
});

test('reversão de referências bloqueia conexão normal mesmo com URLs de teste válidas', async () => {
  const { chamadas, queryInterface } = criarInterface('leia_mais');

  await comAmbiente(ambienteSeguro, async () => {
    await assert.rejects(referencia.down(queryInterface), /conexão diferente/);
  });

  assert.deepEqual(chamadas, { transacoes: 0, consultas: 0 });
});
