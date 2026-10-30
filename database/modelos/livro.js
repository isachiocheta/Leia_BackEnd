'use strict';

const { DataTypes } = require('sequelize');

function definirLivro(sequelize) {
  return sequelize.define('Livro', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false, field: 'id' },
    titulo: {
      type: DataTypes.STRING(160),
      allowNull: false,
      field: 'titulo',
      validate: {
        len: [1, 160],
        tituloNaoVazio(valor) {
          if (typeof valor !== 'string' || valor.trim().length === 0) {
            throw new Error('Título não pode ser vazio.');
          }
        },
      },
    },
    autor: {
      type: DataTypes.STRING(120),
      allowNull: false,
      field: 'autor',
      validate: {
        len: [1, 120],
        autorNaoVazio(valor) {
          if (typeof valor !== 'string' || valor.trim().length === 0) {
            throw new Error('Autor não pode ser vazio.');
          }
        },
      },
    },
    generoId: { type: DataTypes.INTEGER, allowNull: false, field: 'genero_id' },
    totalPaginas: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'total_paginas',
      validate: { isInt: true, min: 1 },
    },
    // A validação do limite superior pelo ano corrente pertence ao serviço.
    anoPublicacao: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'ano_publicacao',
      validate: { isInt: true, min: 1 },
    },
    descricao: {
      type: DataTypes.STRING(2000),
      allowNull: true,
      field: 'descricao',
      validate: { len: [0, 2000] },
    },
    capaUrl: { type: DataTypes.TEXT, allowNull: true, field: 'capa_url' },
    criadoEm: { type: DataTypes.DATE, allowNull: false, field: 'criado_em' },
    atualizadoEm: { type: DataTypes.DATE, allowNull: false, field: 'atualizado_em' },
  }, {
    tableName: 'livros',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
  });
}

module.exports = { definirLivro };
