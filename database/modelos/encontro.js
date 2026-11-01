'use strict';

const { DataTypes } = require('sequelize');

function definirEncontro(sequelize) {
  return sequelize.define('Encontro', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false, field: 'id' },
    cicloId: { type: DataTypes.INTEGER, allowNull: false, field: 'ciclo_id' },
    titulo: {
      type: DataTypes.STRING(120),
      allowNull: false,
      field: 'titulo',
      validate: {
        len: [1, 120],
        tituloNaoVazio(valor) {
          if (typeof valor !== 'string' || valor.trim().length === 0) {
            throw new Error('Título do encontro não pode ser vazio.');
          }
        },
      },
    },
    // DATE representa um instante; no PostgreSQL corresponde a timestamp com fuso.
    inicioEm: { type: DataTypes.DATE, allowNull: false, field: 'inicio_em', validate: { isDate: true } },
    local: {
      type: DataTypes.STRING(180),
      allowNull: false,
      field: 'local',
      validate: {
        len: [1, 180],
        localNaoVazio(valor) {
          if (typeof valor !== 'string' || valor.trim().length === 0) {
            throw new Error('Local do encontro não pode ser vazio.');
          }
        },
      },
    },
    descricao: {
      type: DataTypes.STRING(2000),
      allowNull: true,
      field: 'descricao',
      validate: { len: [0, 2000] },
    },
    situacao: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'AGENDADO',
      field: 'situacao',
      validate: { isIn: [['AGENDADO', 'REALIZADO', 'CANCELADO']] },
    },
    criadoEm: { type: DataTypes.DATE, allowNull: false, field: 'criado_em' },
    atualizadoEm: { type: DataTypes.DATE, allowNull: false, field: 'atualizado_em' },
  }, {
    tableName: 'encontros',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
    // Início dentro do período e transições são validados no serviço, sob locks
    // dos livros/ciclos/encontro; não cabe CHECK entre tabelas neste model.
    indexes: [
      { name: 'encontros_ciclo_inicio_indice', fields: ['ciclo_id', 'inicio_em'] },
      { name: 'encontros_inicio_indice', fields: ['inicio_em'] },
    ],
  });
}

module.exports = { definirEncontro };
