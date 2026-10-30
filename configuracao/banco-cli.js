'use strict';

const { carregarAmbiente } = require('./ambiente');
const { criarOpcoesConexao } = require('../database/conexao');

const { ambiente } = carregarAmbiente();

module.exports = {
  [ambiente]: {
    ...criarOpcoesConexao(),
    migrationStorage: 'sequelize',
    migrationStorageTableName: 'sequelize_meta',
    seederStorage: 'none',
  },
};
