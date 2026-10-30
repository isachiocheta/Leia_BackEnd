'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };
      // A renomeação conserva registros, ambas as FKs RESTRICT e a constraint
      // participacoes_leitura_usuario_ciclo_unico, sem criar outra unicidade.
      await queryInterface.renameColumn('participacoes_leitura', 'ciclo_leitura_id', 'ciclo_id', opcoes);
      await queryInterface.addColumn('participacoes_leitura', 'pagina_atual', {
        type: Sequelize.INTEGER, allowNull: false, defaultValue: 0,
      }, opcoes);
      await queryInterface.addColumn('participacoes_leitura', 'concluida_em', {
        type: Sequelize.DATE, allowNull: true,
      }, opcoes);
      await queryInterface.addConstraint('participacoes_leitura', {
        fields: ['pagina_atual'], type: 'check', name: 'participacoes_leitura_pagina_nao_negativa',
        where: Sequelize.literal('"pagina_atual" >= 0'), transaction,
      });

      // Participação é adesão ao ciclo. Usuário ativo e limite superior da página
      // exigem serviços; não há percentual, contador ou indicador de presença.
    });
  },

  async down(queryInterface) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };
      await queryInterface.removeConstraint('participacoes_leitura', 'participacoes_leitura_pagina_nao_negativa', opcoes);
      // O rollback pode descartar apenas no banco de teste os campos adicionados;
      // a adesão original, seus identificadores, unicidade e FKs são preservados.
      await queryInterface.removeColumn('participacoes_leitura', 'concluida_em', opcoes);
      await queryInterface.removeColumn('participacoes_leitura', 'pagina_atual', opcoes);
      await queryInterface.renameColumn('participacoes_leitura', 'ciclo_id', 'ciclo_leitura_id', opcoes);
    });
  },
};
