'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { Sequelize } = require('sequelize');
const { definirModelos } = require('../database/modelos/definir-modelos');

const sequelize = new Sequelize({ dialect: 'postgres', logging: false });
const { Genero, Livro, CicloLeitura } = definirModelos(sequelize);
const auditoria = {
  criadoEm: new Date('2026-10-30T12:00:00Z'),
  atualizadoEm: new Date('2026-10-30T12:00:00Z'),
};

after(async () => sequelize.close());

function livroValido(alteracoes = {}) {
  return { titulo: 'Livro escolar', autor: 'Autora informada', generoId: 1, totalPaginas: 100, ...auditoria, ...alteracoes };
}

test('gênero exige nome não vazio e respeita o limite de 60 caracteres', async () => {
  await Genero.build({ nome: 'n'.repeat(60), ...auditoria }).validate();
  for (const nome of [undefined, null, '', ' \t\n ', 'n'.repeat(61)]) {
    await assert.rejects(Genero.build({ nome, ...auditoria }).validate(), { name: 'SequelizeValidationError' });
  }
});

test('livro exige título e autor não vazios e respeita seus limites', async () => {
  await Livro.build(livroValido({ titulo: 't'.repeat(160), autor: 'a'.repeat(120) })).validate();
  for (const [campo, limite] of [['titulo', 160], ['autor', 120]]) {
    for (const valor of [undefined, null, '', ' \t\n ', 'x'.repeat(limite + 1)]) {
      await assert.rejects(Livro.build(livroValido({ [campo]: valor })).validate(), { name: 'SequelizeValidationError' });
    }
  }
});

test('livro exige gênero e total de páginas inteiro maior que zero, sem valor inventado', async () => {
  for (const generoId of [undefined, null]) {
    await assert.rejects(Livro.build(livroValido({ generoId })).validate(), { name: 'SequelizeValidationError' });
  }
  for (const totalPaginas of [undefined, null, 0, -1, 0.5, 'invalido']) {
    await assert.rejects(Livro.build(livroValido({ totalPaginas })).validate(), { name: 'SequelizeValidationError' });
  }
  await Livro.build(livroValido({ totalPaginas: 1 })).validate();
});

test('campos opcionais podem estar ausentes ou nulos', async () => {
  await Livro.build(livroValido()).validate();
  await Livro.build(livroValido({ anoPublicacao: null, descricao: null, capaUrl: null })).validate();
  await Livro.build(livroValido({ descricao: '', capaUrl: '' })).validate();
});

test('ano informado deve ser inteiro positivo, sem impor limite pelo ano corrente no model', async () => {
  const anoFuturo = new Date().getFullYear() + 20;
  await Livro.build(livroValido({ anoPublicacao: anoFuturo })).validate();
  for (const anoPublicacao of [0, -1, 2026.5, 'invalido']) {
    await assert.rejects(Livro.build(livroValido({ anoPublicacao })).validate(), { name: 'SequelizeValidationError' });
  }
});

test('descrição respeita 2000 caracteres e capa não recebe limite arbitrário', async () => {
  await Livro.build(livroValido({ descricao: 'd'.repeat(2000), capaUrl: `https://escola.exemplo/${'c'.repeat(3000)}` })).validate();
  await assert.rejects(Livro.build(livroValido({ descricao: 'd'.repeat(2001) })).validate(), { name: 'SequelizeValidationError' });
});

test('associações usam os aliases e reutilizam somente genero_id sem criar colunas extras', () => {
  assert.equal(Genero.associations.livros.target, Livro);
  assert.equal(Genero.associations.livros.foreignKey, 'generoId');
  assert.equal(Livro.associations.genero.target, Genero);
  assert.equal(Livro.associations.genero.foreignKey, 'generoId');
  assert.equal(Livro.rawAttributes.generoId.field, 'genero_id');
  assert.equal(Livro.rawAttributes.generoId.allowNull, false);
  assert.equal(Livro.rawAttributes.generoId.onDelete, 'RESTRICT');
  const campos = Object.values(Livro.rawAttributes).map((atributo) => atributo.field);
  assert.deepEqual(campos.sort(), [
    'id', 'titulo', 'autor', 'genero_id', 'total_paginas', 'ano_publicacao',
    'descricao', 'capa_url', 'criado_em', 'atualizado_em',
  ].sort());
  assert.equal(new Set(campos).size, campos.length);
});

test('obra cadastrada mantém associação própria com ciclos de leitura', () => {
  assert.equal(Livro.associations.ciclosLeitura.target, CicloLeitura);
  assert.equal(CicloLeitura.associations.livro.target, Livro);
  assert.equal(CicloLeitura.associations.livro.foreignKey, 'livroId');
  assert.equal(CicloLeitura.rawAttributes.livroId.field, 'livro_id');
  assert.equal(Livro.rawAttributes.cicloLeituraId, undefined);
});
