'use strict';

const { DataTypes } = require('sequelize');

function definirGenero(sequelize) {
  return sequelize.define('Genero', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false, field: 'id' },
    nome: {
      type: DataTypes.STRING(60),
      allowNull: false,
      unique: 'generos_nome_unico',
      field: 'nome',
      validate: {
        len: [1, 60],
        nomeNaoVazio(valor) {
          if (typeof valor !== 'string' || valor.trim().length === 0) {
            throw new Error('Nome do gênero não pode ser vazio.');
          }
        },
      },
    },
    criadoEm: { type: DataTypes.DATE, allowNull: false, field: 'criado_em' },
    atualizadoEm: { type: DataTypes.DATE, allowNull: false, field: 'atualizado_em' },
  }, {
    tableName: 'generos',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
  });
}

module.exports = { definirGenero };
