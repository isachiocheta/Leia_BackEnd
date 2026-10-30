'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { Sequelize } = require('sequelize');
const { definirModelos } = require('../database/modelos/definir-modelos');

const sequelize = new Sequelize({ dialect: 'postgres', logging: false });
const { Usuario, CicloLeitura, Encontro, ParticipacaoLeitura, InscricaoEncontro } = definirModelos(sequelize);
const auditoria = { criadoEm: new Date('2026-10-30T12:00:00Z'), atualizadoEm: new Date('2026-10-30T12:00:00Z') };

after(async () => sequelize.close());

function participacao(alteracoes = {}) {
  return ParticipacaoLeitura.build({ usuarioId: 1, cicloId: 2, ...auditoria, ...alteracoes });
}

function inscricao(alteracoes = {}) {
  return InscricaoEncontro.build({ usuarioId: 1, encontroId: 3, ...auditoria, ...alteracoes });
}

test('participação começa na página zero e aceita apenas inteiros não negativos', async () => {
  const inicial = participacao();
  assert.equal(inicial.paginaAtual, 0);
  await inicial.validate();
  for (const paginaAtual of [0, 1, 2147483647]) {
    await participacao({ paginaAtual }).validate();
  }
  for (const paginaAtual of [null, -1, 0.5, 'invalida']) {
    await assert.rejects(participacao({ paginaAtual }).validate(), { name: 'SequelizeValidationError' });
  }
});

test('conclusão é opcional e preserva o instante com offset quando informado', async () => {
  for (const concluidaEm of [undefined, null]) {
    await participacao({ concluidaEm }).validate();
  }
  const concluida = participacao({ concluidaEm: '2026-11-10T10:30:00-03:00' });
  await concluida.validate();
  assert.equal(concluida.concluidaEm.toISOString(), '2026-11-10T13:30:00.000Z');
  assert.equal(concluida.paginaAtual, 0);
});

test('ambas as adesões exigem suas duas chaves estrangeiras', async () => {
  for (const campo of ['usuarioId', 'cicloId']) {
    for (const valor of [undefined, null]) {
      await assert.rejects(participacao({ [campo]: valor }).validate(), { name: 'SequelizeValidationError' });
    }
  }
  for (const campo of ['usuarioId', 'encontroId']) {
    for (const valor of [undefined, null]) {
      await assert.rejects(inscricao({ [campo]: valor }).validate(), { name: 'SequelizeValidationError' });
    }
  }
});

test('validação local não consulta situação do usuário, livro ou adesão ao ciclo', async (t) => {
  const consulta = t.mock.method(sequelize, 'query', async () => {
    throw new Error('A regra entre entidades pertence ao serviço.');
  });
  await participacao({ paginaAtual: 2147483647 }).validate();
  await inscricao().validate();
  assert.equal(consulta.mock.callCount(), 0);
});

test('bulkCreate validado preenche auditoria sem exigir timestamps nos helpers M:N', async (t) => {
  const lotes = [];
  const queryInterface = sequelize.getQueryInterface();
  t.mock.method(queryInterface, 'bulkInsert', async (tabela, registros) => {
    lotes.push({ tabela, registros });
    return registros.map((registro, indice) => ({ ...registro, id: indice + 1 }));
  });
  const consulta = t.mock.method(sequelize, 'query', async () => {
    throw new Error('O teste unitário não deve abrir conexão.');
  });

  await ParticipacaoLeitura.bulkCreate([{ usuarioId: 1, cicloId: 2 }], { validate: true });
  await InscricaoEncontro.bulkCreate([{ usuarioId: 1, encontroId: 3 }], { validate: true });

  assert.deepEqual(lotes.map((lote) => lote.tabela), ['participacoes_leitura', 'inscricoes_encontro']);
  for (const { registros } of lotes) {
    assert.equal(registros.length, 1);
    assert.ok(registros[0].criado_em instanceof Date);
    assert.ok(registros[0].atualizado_em instanceof Date);
    assert.ok(Number.isFinite(registros[0].criado_em.getTime()));
    assert.ok(Number.isFinite(registros[0].atualizado_em.getTime()));
  }
  assert.equal(consulta.mock.callCount(), 0);

  const gerador = queryInterface.queryGenerator;
  for (const modelo of [ParticipacaoLeitura, InscricaoEncontro]) {
    const sql = gerador.createTableQuery(modelo.tableName, gerador.attributesToSQL(modelo.rawAttributes));
    assert.match(sql, /"criado_em" TIMESTAMP WITH TIME ZONE NOT NULL[,)]/);
    assert.match(sql, /"atualizado_em" TIMESTAMP WITH TIME ZONE NOT NULL[,)]/);
    assert.doesNotMatch(sql, /"(?:criado_em|atualizado_em)"[^,)]*DEFAULT/);
    assert.equal(modelo.rawAttributes.criadoEm.allowNull, false);
    assert.equal(modelo.rawAttributes.atualizadoEm.allowNull, false);
  }
});

test('campos e timestamps são explícitos e não armazenam presença ou agregações', () => {
  const esperados = [
    [ParticipacaoLeitura, ['id', 'usuario_id', 'ciclo_id', 'pagina_atual', 'concluida_em', 'criado_em', 'atualizado_em']],
    [InscricaoEncontro, ['id', 'usuario_id', 'encontro_id', 'criado_em', 'atualizado_em']],
  ];
  for (const [modelo, colunas] of esperados) {
    const campos = Object.values(modelo.rawAttributes).map((atributo) => atributo.field);
    assert.deepEqual(campos.sort(), colunas.sort());
    assert.equal(new Set(campos).size, campos.length);
    assert.equal(modelo.options.createdAt, 'criadoEm');
    assert.equal(modelo.options.updatedAt, 'atualizadoEm');
    assert.equal(modelo.rawAttributes.criadoEm.field, 'criado_em');
    assert.equal(modelo.rawAttributes.atualizadoEm.field, 'atualizado_em');
    assert.deepEqual(modelo.primaryKeyAttributes, ['id']);
    assert.equal(modelo.rawAttributes.id.autoIncrement, true);
  }
  assert.equal(ParticipacaoLeitura.rawAttributes.cicloLeituraId, undefined);
});

test('associações preservam RESTRICT para usuários/ciclos e CASCADE somente para encontro', () => {
  for (const [modelo, atributo, tabela, acao] of [
    [ParticipacaoLeitura, 'usuarioId', 'usuarios', 'RESTRICT'],
    [ParticipacaoLeitura, 'cicloId', 'ciclos_leitura', 'RESTRICT'],
    [InscricaoEncontro, 'usuarioId', 'usuarios', 'RESTRICT'],
    [InscricaoEncontro, 'encontroId', 'encontros', 'CASCADE'],
  ]) {
    const coluna = modelo.rawAttributes[atributo];
    assert.deepEqual(coluna.references, { model: tabela, key: 'id' });
    assert.equal(coluna.onDelete, acao);
    assert.equal(coluna.onUpdate, 'CASCADE');
    assert.equal(coluna.allowNull, false);
    assert.equal(coluna.unique, undefined);
  }

  const gerador = sequelize.getQueryInterface().queryGenerator;
  const participacaoSql = gerador.createTableQuery(ParticipacaoLeitura.tableName, gerador.attributesToSQL(ParticipacaoLeitura.rawAttributes));
  const inscricaoSql = gerador.createTableQuery(InscricaoEncontro.tableName, gerador.attributesToSQL(InscricaoEncontro.rawAttributes));
  assert.match(participacaoSql, /"usuario_id" INTEGER NOT NULL REFERENCES "usuarios" \("id"\) ON DELETE RESTRICT/);
  assert.match(participacaoSql, /"ciclo_id" INTEGER NOT NULL REFERENCES "ciclos_leitura" \("id"\) ON DELETE RESTRICT/);
  assert.match(inscricaoSql, /"usuario_id" INTEGER NOT NULL REFERENCES "usuarios" \("id"\) ON DELETE RESTRICT/);
  assert.match(inscricaoSql, /"encontro_id" INTEGER NOT NULL REFERENCES "encontros" \("id"\) ON DELETE CASCADE/);
  assert.doesNotMatch(participacaoSql, /UNIQUE|ON DELETE CASCADE/);
  assert.doesNotMatch(inscricaoSql, /UNIQUE/);
});

test('belongsToMany reutiliza as junções sem criar constraints, colunas ou unicidades adicionais', () => {
  for (const [associacao, modelo, chave, outraChave] of [
    [Usuario.associations.ciclosLeitura, ParticipacaoLeitura, 'usuarioId', 'cicloId'],
    [CicloLeitura.associations.usuariosParticipantes, ParticipacaoLeitura, 'cicloId', 'usuarioId'],
    [Usuario.associations.encontrosInscritos, InscricaoEncontro, 'usuarioId', 'encontroId'],
    [Encontro.associations.usuariosInscritos, InscricaoEncontro, 'encontroId', 'usuarioId'],
  ]) {
    assert.equal(associacao.through.model, modelo);
    assert.equal(associacao.through.unique, false);
    assert.equal(associacao.options.constraints, false);
    assert.equal(associacao.foreignKey, chave);
    assert.equal(associacao.otherKey, outraChave);
    assert.deepEqual(modelo.uniqueKeys, {});
  }
  for (const [modelo, nome, campos] of [
    [ParticipacaoLeitura, 'participacoes_leitura_usuario_ciclo_unico', ['usuario_id', 'ciclo_id']],
    [InscricaoEncontro, 'inscricoes_encontro_usuario_encontro_unico', ['usuario_id', 'encontro_id']],
  ]) {
    assert.equal(modelo.options.indexes.length, 1);
    const [indice] = modelo.options.indexes;
    assert.equal(indice.name, nome);
    assert.equal(indice.unique, true);
    assert.deepEqual(indice.fields, campos);
  }
});

test('aliases diretos mantêm o vínculo de adesão sem acoplar a inscrição à presença', () => {
  assert.equal(Usuario.associations.participacoesLeitura.target, ParticipacaoLeitura);
  assert.equal(CicloLeitura.associations.participacoesLeitura.target, ParticipacaoLeitura);
  assert.equal(ParticipacaoLeitura.associations.usuario.target, Usuario);
  assert.equal(ParticipacaoLeitura.associations.ciclo.target, CicloLeitura);
  assert.equal(Usuario.associations.inscricoesEncontro.target, InscricaoEncontro);
  assert.equal(Encontro.associations.inscricoesEncontro.target, InscricaoEncontro);
  assert.equal(InscricaoEncontro.associations.usuario.target, Usuario);
  assert.equal(InscricaoEncontro.associations.encontro.target, Encontro);
  assert.equal(Encontro.associations.inscricoesEncontro.options.onDelete, 'CASCADE');
  assert.equal(Usuario.associations.inscricoesEncontro.options.onDelete, 'RESTRICT');
});
