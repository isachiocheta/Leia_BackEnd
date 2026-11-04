'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { carregarDemonstracao } = require('../configuracao/demonstracao');
const { criarPlano, calendario, asDezoito } = require('../database/demonstracao/plano');
const { carregarDemonstracaoOpcional } = require('../database/carregar-demonstracao');
const { criarBancoTemporario } = require('../database/banco-temporario');

const nomes = ['INICIO', 'METADE', 'FINAL', 'SEM_PARTICIPACAO', 'PENDENTE'];
const ambiente = Object.fromEntries(nomes.map((nome) => [`DEMO_SENHA_${nome}`, '  Senha exclusiva de teste 22  ']));

test('demo valida senhas sem transformação e configuração inválida antes de conectar', async () => {
  const configuracao = carregarDemonstracao({ ...ambiente, DEMO_DATA_BASE: '2026-11-03' });
  assert.equal(configuracao.senhas.inicio, ambiente.DEMO_SENHA_INICIO);
  assert.equal(carregarDemonstracao(ambiente).dataBase, null);
  for (const variaveis of [{ ...ambiente, DEMO_SENHA_INICIO: undefined }, { ...ambiente, DEMO_SENHA_FINAL: 'curta' },
    { ...ambiente, DEMO_SENHA_METADE: 'é'.repeat(37) }, { ...ambiente, DEMO_DATA_BASE: '2026-02-30' }, { ...ambiente, DEMO_DATA_BASE: '2026-11-03T12:00:00Z' }]) {
    await assert.rejects(carregarDemonstracaoOpcional(variaveis, { transaction() { throw new Error('Não deveria conectar.'); } }), { codigo: 'CONFIGURACAO_DEMONSTRACAO_INVALIDA' });
  }
});

test('datas civis e instantes usam America/Sao_Paulo inclusive horário de verão histórico', () => {
  assert.equal(calendario('2024-02-28', 1), '2024-02-29'); assert.equal(calendario('2024-02-28', 2), '2024-03-01');
  assert.equal(asDezoito('2026-11-03').toISOString(), '2026-11-03T21:00:00.000Z');
  assert.equal(asDezoito('2018-12-01').toISOString(), '2018-12-01T20:00:00.000Z');
  const plano = criarPlano('2026-11-03');
  assert.deepEqual(Object.values(plano.participacoes).slice(0, 3).map((dado) => dado.paginaAtual), [0, 150, 300]);
  assert.equal(plano.ciclos.atual.livro, plano.ciclos.concluido.livro);
  assert.throws(() => criarPlano('0001-01-01'), { codigo: 'CONFIGURACAO_DEMONSTRACAO_INVALIDA' });
});

test('criação/exportação de banco temporário exige ambiente e nomes distintos antes de conectar', async () => {
  await assert.rejects(criarBancoTemporario('exportacao', { NODE_ENV: 'production' }), /NODE_ENV/);
  await assert.rejects(criarBancoTemporario('exportacao', { NODE_ENV: 'test', DATABASE_URL: 'postgres://u:p@localhost/mesmo_teste', TEST_DATABASE_URL: 'postgres://u:p@localhost/mesmo_teste' }), /diferente/);
});
