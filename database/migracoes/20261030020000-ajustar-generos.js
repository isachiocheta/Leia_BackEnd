'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.changeColumn('generos', 'nome', {
        type: Sequelize.STRING(60),
        allowNull: false,
      }, { transaction });
      await queryInterface.addConstraint('generos', {
        fields: ['nome'],
        type: 'check',
        name: 'generos_nome_nao_vazio',
        where: Sequelize.literal('"nome" ~ \'[^[:space:]]\''),
        transaction,
      });
      // A PK, os timestamps e generos_nome_unico pertencem à migration original.
    });
  },

  async down(queryInterface, Sequelize) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeConstraint('generos', 'generos_nome_nao_vazio', { transaction });
      await queryInterface.changeColumn('generos', 'nome', {
        type: Sequelize.STRING(80),
        allowNull: false,
      }, { transaction });
    });
  },
};
