'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };

      // Não inventa nomes para ciclos legados. Se houver dados sem esse campo,
      // a adição NOT NULL falha e a transação preserva todo o schema anterior.
      await queryInterface.addColumn('ciclos_leitura', 'nome', {
        type: Sequelize.STRING(120), allowNull: false,
      }, opcoes);
      await queryInterface.addColumn('ciclos_leitura', 'orientacoes', {
        type: Sequelize.STRING(2000), allowNull: true,
      }, opcoes);
      await queryInterface.addColumn('ciclos_leitura', 'situacao', {
        type: Sequelize.STRING(20), allowNull: false, defaultValue: 'PLANEJADO',
      }, opcoes);
      await queryInterface.addConstraint('ciclos_leitura', {
        fields: ['nome'], type: 'check', name: 'ciclos_leitura_nome_nao_vazio',
        where: Sequelize.literal('"nome" ~ \'[^[:space:]]\''), transaction,
      });
      await queryInterface.addConstraint('ciclos_leitura', {
        fields: ['situacao'], type: 'check', name: 'ciclos_leitura_situacao_valida',
        where: { situacao: { [Sequelize.Op.in]: ['PLANEJADO', 'EM_ANDAMENTO', 'CONCLUIDO'] } }, transaction,
      });

      // A chave é uma constante, não livro_id: a unicidade é global e só afeta
      // os ciclos explicitamente em andamento, inclusive em escritas concorrentes.
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX "ciclos_leitura_unico_em_andamento"
        ON "ciclos_leitura" ((1))
        WHERE "situacao" = 'EM_ANDAMENTO'
      `, opcoes);

      // DATE, NOT NULL, FK livro_id RESTRICT, PK, timestamps e o CHECK
      // ciclos_leitura_periodo_valido vêm da migration original, sem alteração.
      // A situação não é derivada das datas e nenhum indicador é armazenado.
    });
  },

  async down(queryInterface) {
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };
      await queryInterface.removeIndex('ciclos_leitura', 'ciclos_leitura_unico_em_andamento', opcoes);
      await queryInterface.removeConstraint('ciclos_leitura', 'ciclos_leitura_situacao_valida', opcoes);
      await queryInterface.removeConstraint('ciclos_leitura', 'ciclos_leitura_nome_nao_vazio', opcoes);

      // Reversão estrutural: dados destes campos são descartados; datas civis,
      // referências e a restrição de intervalo da etapa original permanecem.
      for (const campo of ['situacao', 'orientacoes', 'nome']) {
        await queryInterface.removeColumn('ciclos_leitura', campo, opcoes);
      }
    });
  },
};
