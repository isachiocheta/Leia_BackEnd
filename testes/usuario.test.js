'use strict';

const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { after, test } = require('node:test');
const { Sequelize } = require('sequelize');
const { definirUsuario } = require('../database/modelos/usuario');

const sequelize = new Sequelize({ dialect: 'postgres', logging: false });
const Usuario = definirUsuario(sequelize);
const senhaHash = `scrypt$sal-fixo-de-teste$${scryptSync('entrada-exclusiva-do-teste', 'sal-fixo-de-teste', 32).toString('hex')}`;

after(async () => sequelize.close());

function dadosValidos(alteracoes = {}) {
  return {
    nome: 'Leitora da escola',
    email: 'leitora@escola.exemplo',
    senhaHash,
    criadoEm: new Date('2026-10-30T12:00:00Z'),
    atualizadoEm: new Date('2026-10-30T12:00:00Z'),
    ...alteracoes,
  };
}

test('normaliza email e começa como leitor pendente com versão zero válida', async () => {
  const usuario = Usuario.build(dadosValidos({ email: '  LEITORA@ESCOLA.EXEMPLO  ' }));

  assert.equal(usuario.email, 'leitora@escola.exemplo');
  assert.equal(usuario.perfil, 'LEITOR');
  assert.equal(usuario.situacao, 'PENDENTE');
  assert.equal(usuario.sessionVersion, 0);
  await usuario.validate();
});

test('rejeita nome obrigatório vazio, só espaços ou acima de 100 caracteres', async () => {
  for (const nome of [null, '', ' \t\n ', 'a'.repeat(101)]) {
    await assert.rejects(Usuario.build(dadosValidos({ nome })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('rejeita email obrigatório vazio, inválido ou acima de 254 caracteres', async () => {
  for (const email of [null, '', ' \t ', 'sem-arroba', `${'a'.repeat(245)}@escola.exemplo`]) {
    await assert.rejects(Usuario.build(dadosValidos({ email })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('exige o hash da senha sem fornecer credencial por padrão', async () => {
  for (const valor of [undefined, null, '', '   ']) {
    await assert.rejects(Usuario.build(dadosValidos({ senhaHash: valor })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('aceita somente os perfis e situações definidos', async () => {
  for (const perfil of ['ADMIN_CLUBE', 'LEITOR']) {
    for (const situacao of ['PENDENTE', 'ATIVO', 'INATIVO']) {
      await Usuario.build(dadosValidos({ perfil, situacao })).validate();
    }
  }

  for (const perfil of [null, '', 'ADMIN', 'leitor']) {
    await assert.rejects(Usuario.build(dadosValidos({ perfil })).validate(), { name: 'SequelizeValidationError' });
  }
  for (const situacao of [null, '', 'APROVADO', 'ativo']) {
    await assert.rejects(Usuario.build(dadosValidos({ situacao })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('rejeita versões de sessão negativas, fracionárias e ausentes explicitamente', async () => {
  await Usuario.build(dadosValidos({ sessionVersion: 1 })).validate();
  for (const sessionVersion of [null, -1, 0.5, 'invalida']) {
    await assert.rejects(Usuario.build(dadosValidos({ sessionVersion })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('consultas públicas não selecionam hash e o escopo de credenciais o inclui', async (t) => {
  const consultas = [];
  t.mock.method(sequelize, 'query', async (sql) => {
    consultas.push(sql);
    return [];
  });

  await Usuario.findAll();
  await Usuario.scope('publico').findAll();
  await Usuario.scope('credenciais').findAll();

  assert.equal(consultas.length, 3);
  assert.doesNotMatch(consultas[0], /senha_hash/);
  assert.doesNotMatch(consultas[1], /senha_hash/);
  assert.match(consultas[2], /"senha_hash" AS "senhaHash"/);
  assert.match(consultas[0], /"session_version" AS "sessionVersion"/);
  assert.match(consultas[0], /"criado_em" AS "criadoEm"/);
  assert.match(consultas[0], /"atualizado_em" AS "atualizadoEm"/);
  assert.doesNotMatch(consultas[0], /created_at|updated_at|createdAt|updatedAt/);
});
