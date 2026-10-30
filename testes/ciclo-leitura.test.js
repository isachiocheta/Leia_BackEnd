'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { Sequelize } = require('sequelize');
const { definirModelos } = require('../database/modelos/definir-modelos');

const sequelize = new Sequelize({ dialect: 'postgres', logging: false });
const { Livro, CicloLeitura } = definirModelos(sequelize);
const auditoria = {
  criadoEm: new Date('2026-10-30T12:00:00Z'),
  atualizadoEm: new Date('2026-10-30T12:00:00Z'),
};

after(async () => sequelize.close());

function dadosValidos(alteracoes = {}) {
  return {
    nome: 'Leitura coletiva', livroId: 1,
    dataInicio: '2026-10-01', dataFim: '2026-10-31',
    ...auditoria, ...alteracoes,
  };
}

test('ciclo começa planejado independentemente das datas', async () => {
  for (const [dataInicio, dataFim] of [['2000-01-01', '2000-01-31'], ['2090-01-01', '2090-01-31']]) {
    const ciclo = CicloLeitura.build(dadosValidos({ dataInicio, dataFim }));
    await ciclo.validate();
    assert.equal(ciclo.situacao, 'PLANEJADO');
  }
});

test('ciclo exige nome não vazio, até 120 caracteres, e livro', async () => {
  await CicloLeitura.build(dadosValidos({ nome: 'n'.repeat(120) })).validate();
  for (const nome of [undefined, null, '', ' \t\n ', 'n'.repeat(121)]) {
    await assert.rejects(CicloLeitura.build(dadosValidos({ nome })).validate(), { name: 'SequelizeValidationError' });
  }
  for (const livroId of [undefined, null]) {
    await assert.rejects(CicloLeitura.build(dadosValidos({ livroId })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('datas civis DATEONLY preservam o dia como strings em diferentes fusos', async () => {
  const fusoAnterior = process.env.TZ;
  try {
    for (const fuso of ['UTC', 'America/Sao_Paulo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = fuso;
      const ciclo = CicloLeitura.build(dadosValidos({ dataInicio: '2018-11-04', dataFim: '2018-11-05' }));
      await ciclo.validate();
      assert.equal(ciclo.dataInicio, '2018-11-04');
      assert.equal(ciclo.dataFim, '2018-11-05');
      assert.equal(ciclo.toJSON().dataInicio, '2018-11-04');
      assert.equal(ciclo.toJSON().dataFim, '2018-11-05');
    }
  } finally {
    if (fusoAnterior === undefined) delete process.env.TZ;
    else process.env.TZ = fusoAnterior;
  }
});

test('intervalo aceita o mesmo dia e rejeita início posterior ao fim', async () => {
  await CicloLeitura.build(dadosValidos({ dataInicio: '2024-02-29', dataFim: '2024-02-29' })).validate();
  await assert.rejects(CicloLeitura.build(dadosValidos({ dataInicio: '2026-11-01', dataFim: '2026-10-31' })).validate(), { name: 'SequelizeValidationError' });
  for (const campo of ['dataInicio', 'dataFim']) {
    for (const valor of [undefined, null]) {
      await assert.rejects(CicloLeitura.build(dadosValidos({ [campo]: valor })).validate(), { name: 'SequelizeValidationError' });
    }
  }
});

test('orientações são opcionais e limitadas a 2000 caracteres', async () => {
  for (const orientacoes of [undefined, null, '', 'o'.repeat(2000)]) {
    await CicloLeitura.build(dadosValidos({ orientacoes })).validate();
  }
  await assert.rejects(CicloLeitura.build(dadosValidos({ orientacoes: 'o'.repeat(2001) })).validate(), { name: 'SequelizeValidationError' });
});

test('ciclo aceita somente as situações declaradas sem calculá-las', async () => {
  for (const situacao of ['PLANEJADO', 'EM_ANDAMENTO', 'CONCLUIDO']) {
    const ciclo = CicloLeitura.build(dadosValidos({ situacao }));
    await ciclo.validate();
    assert.equal(ciclo.situacao, situacao);
  }
  for (const situacao of [null, '', 'EM_CURSO', 'planejado']) {
    await assert.rejects(CicloLeitura.build(dadosValidos({ situacao })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('índice único parcial usa uma constante global em vez de livro_id', () => {
  const indice = CicloLeitura.options.indexes.find((item) => item.name === 'ciclos_leitura_unico_em_andamento');
  assert.equal(indice.unique, true);
  assert.deepEqual(indice.where, { situacao: 'EM_ANDAMENTO' });
  const sql = sequelize.getQueryInterface().queryGenerator.addIndexQuery('ciclos_leitura', indice);
  assert.match(sql, /CREATE UNIQUE INDEX/);
  assert.match(sql, /\(\(1\)\)/);
  assert.match(sql, /WHERE "situacao" = 'EM_ANDAMENTO'/);
  assert.doesNotMatch(sql, /livro_id/);
});

test('uma obra possui vários ciclos com FK explícita e sem colunas duplicadas', () => {
  assert.equal(Livro.associations.ciclosLeitura.target, CicloLeitura);
  assert.equal(CicloLeitura.associations.livro.target, Livro);
  assert.equal(Livro.associations.ciclosLeitura.foreignKey, 'livroId');
  assert.equal(CicloLeitura.associations.livro.foreignKey, 'livroId');
  assert.equal(CicloLeitura.rawAttributes.livroId.onDelete, 'RESTRICT');
  assert.equal(CicloLeitura.rawAttributes.dataInicio.type.key, 'DATEONLY');
  assert.equal(CicloLeitura.rawAttributes.dataFim.type.key, 'DATEONLY');
  const campos = Object.values(CicloLeitura.rawAttributes).map((atributo) => atributo.field);
  assert.deepEqual(campos.sort(), [
    'id', 'nome', 'livro_id', 'data_inicio', 'data_fim', 'orientacoes', 'situacao', 'criado_em', 'atualizado_em',
  ].sort());
  assert.equal(new Set(campos).size, campos.length);
  assert.equal(Livro.rawAttributes.cicloLeituraId, undefined);
});
