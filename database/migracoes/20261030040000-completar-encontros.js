'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };

      // Renomeações preservam os dados e a FK original RESTRICT, inclusive
      // referências de inscrições. data_hora já é TIMESTAMPTZ no PostgreSQL;
      // não há conversão de fuso ou de precisão ao passar para inicio_em.
      await queryInterface.renameColumn('encontros', 'ciclo_leitura_id', 'ciclo_id', opcoes);
      await queryInterface.renameColumn('encontros', 'data_hora', 'inicio_em', opcoes);
      await queryInterface.changeColumn('encontros', 'titulo', {
        type: Sequelize.STRING(120), allowNull: false,
      }, opcoes);
      await queryInterface.changeColumn('encontros', 'local', {
        type: Sequelize.STRING(180), allowNull: false,
      }, opcoes);
      await queryInterface.addColumn('encontros', 'descricao', {
        type: Sequelize.STRING(2000), allowNull: true,
      }, opcoes);
      await queryInterface.addColumn('encontros', 'situacao', {
        type: Sequelize.STRING(20), allowNull: false, defaultValue: 'AGENDADO',
      }, opcoes);

      for (const [nome, campo, expressao] of [
        ['encontros_titulo_nao_vazio', 'titulo', '"titulo" ~ \'[^[:space:]]\''],
        ['encontros_local_nao_vazio', 'local', '"local" ~ \'[^[:space:]]\''],
        ['encontros_situacao_valida', 'situacao', '"situacao" IN (\'AGENDADO\', \'REALIZADO\', \'CANCELADO\')'],
      ]) {
        await queryInterface.addConstraint('encontros', {
          fields: [campo], type: 'check', name: nome,
          where: Sequelize.literal(expressao), transaction,
        });
      }

      // O composto atende listagem/ordenação dentro do ciclo e já cobre ciclo_id.
      // O índice só de início atende a agenda geral; não repetimos ciclo_id isolado.
      // A migration original possui apenas o índice da PK nesta tabela.
      await queryInterface.addIndex('encontros', ['ciclo_id', 'inicio_em'], {
        name: 'encontros_ciclo_inicio_indice', transaction,
      });
      await queryInterface.addIndex('encontros', ['inicio_em'], {
        name: 'encontros_inicio_indice', transaction,
      });

      // Verificar se o instante está no período do ciclo requer outra tabela
      // e uma convenção de fuso. Essa regra pertence ao serviço, não a um CHECK.
    });
  },

  async down(queryInterface, Sequelize) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };
      await queryInterface.removeIndex('encontros', 'encontros_inicio_indice', opcoes);
      await queryInterface.removeIndex('encontros', 'encontros_ciclo_inicio_indice', opcoes);
      for (const nome of [
        'encontros_situacao_valida', 'encontros_local_nao_vazio', 'encontros_titulo_nao_vazio',
      ]) {
        await queryInterface.removeConstraint('encontros', nome, opcoes);
      }

      // Só o banco de teste validado pode perder os novos campos no rollback.
      await queryInterface.removeColumn('encontros', 'situacao', opcoes);
      await queryInterface.removeColumn('encontros', 'descricao', opcoes);
      await queryInterface.changeColumn('encontros', 'local', {
        type: Sequelize.STRING(200), allowNull: false,
      }, opcoes);
      await queryInterface.changeColumn('encontros', 'titulo', {
        type: Sequelize.STRING(200), allowNull: false,
      }, opcoes);
      await queryInterface.renameColumn('encontros', 'inicio_em', 'data_hora', opcoes);
      await queryInterface.renameColumn('encontros', 'ciclo_id', 'ciclo_leitura_id', opcoes);
    });
  },
};
