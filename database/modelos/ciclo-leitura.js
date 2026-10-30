'use strict';

const { DataTypes, literal } = require('sequelize');

function validarDataCivil(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new Error('Informe a data civil no formato AAAA-MM-DD.');
  }
}

function definirCicloLeitura(sequelize) {
  return sequelize.define('CicloLeitura', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false, field: 'id' },
    nome: {
      type: DataTypes.STRING(120),
      allowNull: false,
      field: 'nome',
      validate: {
        len: [1, 120],
        nomeNaoVazio(valor) {
          if (typeof valor !== 'string' || valor.trim().length === 0) {
            throw new Error('Nome do ciclo não pode ser vazio.');
          }
        },
      },
    },
    livroId: { type: DataTypes.INTEGER, allowNull: false, field: 'livro_id' },
    // Datas civis entram e saem como strings; não passam por conversões Date/UTC.
    dataInicio: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      field: 'data_inicio',
      validate: { isDate: true, dataCivil: validarDataCivil },
    },
    dataFim: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      field: 'data_fim',
      validate: { isDate: true, dataCivil: validarDataCivil },
    },
    orientacoes: {
      type: DataTypes.STRING(2000),
      allowNull: true,
      field: 'orientacoes',
      validate: { len: [0, 2000] },
    },
    situacao: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'PLANEJADO',
      field: 'situacao',
      validate: { isIn: [['PLANEJADO', 'EM_ANDAMENTO', 'CONCLUIDO']] },
    },
    criadoEm: { type: DataTypes.DATE, allowNull: false, field: 'criado_em' },
    atualizadoEm: { type: DataTypes.DATE, allowNull: false, field: 'atualizado_em' },
  }, {
    tableName: 'ciclos_leitura',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
    validate: {
      intervaloValido() {
        // AAAA-MM-DD ordena cronologicamente sem interpretar fuso horário.
        if (typeof this.dataInicio === 'string' && typeof this.dataFim === 'string' && this.dataInicio > this.dataFim) {
          throw new Error('Data de início deve ser anterior ou igual à data de fim.');
        }
      },
    },
    // A migration cria este índice global; não é uma unicidade por obra.
    indexes: [{
      name: 'ciclos_leitura_unico_em_andamento',
      unique: true,
      fields: [literal('(1)')],
      where: { situacao: 'EM_ANDAMENTO' },
    }],
  });
}

module.exports = { definirCicloLeitura };
