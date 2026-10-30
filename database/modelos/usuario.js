'use strict';

const { DataTypes } = require('sequelize');

function definirUsuario(sequelize) {
  return sequelize.define('Usuario', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
      field: 'id',
    },
    nome: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: 'nome',
      validate: {
        len: [1, 100],
        nomeNaoVazio(valor) {
          if (typeof valor !== 'string' || valor.trim().length === 0) {
            throw new Error('Nome não pode ser vazio.');
          }
        },
      },
    },
    email: {
      type: DataTypes.STRING(254),
      allowNull: false,
      unique: 'usuarios_email_unico',
      field: 'email',
      set(valor) {
        this.setDataValue('email', typeof valor === 'string' ? valor.trim().toLowerCase() : valor);
      },
      validate: { notEmpty: true, isEmail: true, len: [1, 254] },
    },
    senhaHash: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'senha_hash',
      validate: { notEmpty: true },
    },
    perfil: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'LEITOR',
      field: 'perfil',
      validate: { isIn: [['ADMIN_CLUBE', 'LEITOR']] },
    },
    situacao: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'PENDENTE',
      field: 'situacao',
      validate: { isIn: [['PENDENTE', 'ATIVO', 'INATIVO']] },
    },
    sessionVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'session_version',
      validate: { isInt: true, min: 0 },
    },
    criadoEm: { type: DataTypes.DATE, allowNull: false, field: 'criado_em' },
    atualizadoEm: { type: DataTypes.DATE, allowNull: false, field: 'atualizado_em' },
  }, {
    tableName: 'usuarios',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
    defaultScope: { attributes: { exclude: ['senhaHash'] } },
    scopes: {
      publico: { attributes: { exclude: ['senhaHash'] } },
      // Apenas a consulta deliberada de credenciais recupera o hash.
      credenciais: {
        attributes: ['id', 'nome', 'email', 'senhaHash', 'perfil', 'situacao', 'sessionVersion', 'criadoEm', 'atualizadoEm'],
      },
    },
  });
}

module.exports = { definirUsuario };
