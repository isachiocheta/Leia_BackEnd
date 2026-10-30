'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { Sequelize } = require('sequelize');
const { definirModelos } = require('../database/modelos/definir-modelos');

const sequelize = new Sequelize({ dialect: 'postgres', logging: false });
const { CicloLeitura, Encontro } = definirModelos(sequelize);
const auditoria = {
  criadoEm: new Date('2026-10-30T12:00:00Z'),
  atualizadoEm: new Date('2026-10-30T12:00:00Z'),
};

after(async () => sequelize.close());

function dadosValidos(alteracoes = {}) {
  return {
    cicloId: 1,
    titulo: 'Conversa sobre a obra',
    inicioEm: '2026-11-01T15:00:00-03:00',
    local: 'Biblioteca da escola',
    ...auditoria,
    ...alteracoes,
  };
}

test('encontro começa agendado sem derivar situação do instante', async () => {
  for (const inicioEm of ['2000-01-01T10:00:00Z', '2090-01-01T10:00:00Z']) {
    const encontro = Encontro.build(dadosValidos({ inicioEm }));
    await encontro.validate();
    assert.equal(encontro.situacao, 'AGENDADO');
  }
});

test('início preserva o mesmo instante fornecido por offsets diferentes', async () => {
  for (const inicioEm of ['2026-11-01T15:00:00-03:00', '2026-11-01T18:00:00Z', '2026-11-02T08:00:00+14:00']) {
    const encontro = Encontro.build(dadosValidos({ inicioEm }));
    await encontro.validate();
    assert.ok(encontro.inicioEm instanceof Date);
    assert.equal(encontro.inicioEm.toISOString(), '2026-11-01T18:00:00.000Z');
  }
});

test('ciclo e instante são obrigatórios e o início deve ser válido', async () => {
  for (const campo of ['cicloId', 'inicioEm']) {
    for (const valor of [undefined, null]) {
      await assert.rejects(Encontro.build(dadosValidos({ [campo]: valor })).validate(), { name: 'SequelizeValidationError' });
    }
  }
  await assert.rejects(Encontro.build(dadosValidos({ inicioEm: new Date(NaN) })).validate(), { name: 'SequelizeValidationError' });
});

test('título e local exigem texto não vazio e respeitam os limites', async () => {
  await Encontro.build(dadosValidos({ titulo: 't'.repeat(120), local: 'l'.repeat(180) })).validate();
  for (const [campo, tamanho] of [['titulo', 120], ['local', 180]]) {
    for (const valor of [undefined, null, '', ' \t\n ', 'x'.repeat(tamanho + 1)]) {
      await assert.rejects(Encontro.build(dadosValidos({ [campo]: valor })).validate(), { name: 'SequelizeValidationError' });
    }
  }
});

test('descrição é opcional e aceita até 2000 caracteres', async () => {
  for (const descricao of [undefined, null, '', 'd'.repeat(2000)]) {
    await Encontro.build(dadosValidos({ descricao })).validate();
  }
  await assert.rejects(Encontro.build(dadosValidos({ descricao: 'd'.repeat(2001) })).validate(), { name: 'SequelizeValidationError' });
});

test('encontro aceita somente as situações declaradas', async () => {
  for (const situacao of ['AGENDADO', 'REALIZADO', 'CANCELADO']) {
    await Encontro.build(dadosValidos({ situacao })).validate();
  }
  for (const situacao of [null, '', 'PENDENTE', 'agendado']) {
    await assert.rejects(Encontro.build(dadosValidos({ situacao })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('associações e campos usam cicloId uma única vez e mapeiam timestamps', () => {
  assert.equal(CicloLeitura.associations.encontros.target, Encontro);
  assert.equal(Encontro.associations.ciclo.target, CicloLeitura);
  assert.equal(CicloLeitura.associations.encontros.foreignKey, 'cicloId');
  assert.equal(Encontro.associations.ciclo.foreignKey, 'cicloId');
  assert.equal(Encontro.rawAttributes.cicloId.onDelete, 'RESTRICT');
  assert.equal(Encontro.rawAttributes.inicioEm.type.key, 'DATE');
  assert.equal(Encontro.options.createdAt, 'criadoEm');
  assert.equal(Encontro.options.updatedAt, 'atualizadoEm');
  const campos = Object.values(Encontro.rawAttributes).map((atributo) => atributo.field);
  assert.deepEqual(campos.sort(), [
    'id', 'ciclo_id', 'titulo', 'inicio_em', 'local', 'descricao', 'situacao', 'criado_em', 'atualizado_em',
  ].sort());
  assert.equal(new Set(campos).size, campos.length);
  assert.equal(Encontro.rawAttributes.cicloLeituraId, undefined);
  assert.equal(Encontro.rawAttributes.dataHora, undefined);
});

test('índices atendem ordem por ciclo e ordem global sem índice de ciclo redundante', () => {
  const indices = Encontro.options.indexes;
  assert.deepEqual(indices.map(({ name, fields }) => ({ name, fields })), [
    { name: 'encontros_ciclo_inicio_indice', fields: ['ciclo_id', 'inicio_em'] },
    { name: 'encontros_inicio_indice', fields: ['inicio_em'] },
  ]);
  const sql = indices.map((indice) => sequelize.getQueryInterface().queryGenerator.addIndexQuery('encontros', indice));
  assert.match(sql[0], /\("ciclo_id", "inicio_em"\)/);
  assert.match(sql[1], /\("inicio_em"\)/);
  assert.equal(indices.some((indice) => indice.fields.length === 1 && indice.fields[0] === 'ciclo_id'), false);
});

test('validação local não consulta o período de outra tabela', async (t) => {
  const consulta = t.mock.method(sequelize, 'query', async () => {
    throw new Error('Validação local não deve consultar o banco.');
  });
  const ciclo = CicloLeitura.build({
    id: 1, nome: 'Ciclo de novembro', livroId: 1,
    dataInicio: '2026-11-01', dataFim: '2026-11-30', ...auditoria,
  });
  const encontro = Encontro.build(dadosValidos({ inicioEm: '2027-01-01T10:00:00Z' }));
  encontro.setDataValue('ciclo', ciclo);
  await encontro.validate();
  assert.equal(consulta.mock.callCount(), 0);
});
