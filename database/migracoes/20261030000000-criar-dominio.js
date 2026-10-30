'use strict';

const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');

// Autoridade do schema: alterações estruturais devem ser feitas por migrations.
// Domínio em 3FN: associações M:N em junções, sem percentuais ou contadores redundantes.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const opcoes = { transaction };
      const identificador = () => ({
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      });
      const auditoria = () => ({
        criado_em: { type: Sequelize.DATE, allowNull: false },
        atualizado_em: { type: Sequelize.DATE, allowNull: false },
      });
      const referencia = (tabela) => ({
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: tabela, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      });

      await queryInterface.createTable('usuarios', {
        id: identificador(),
        nome: { type: Sequelize.STRING(120), allowNull: false },
        email: { type: Sequelize.STRING(254), allowNull: false },
        perfil: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'LEITOR' },
        ...auditoria(),
      }, opcoes);
      await queryInterface.addConstraint('usuarios', {
        fields: ['email'], type: 'unique', name: 'usuarios_email_unico', transaction,
      });
      await queryInterface.addConstraint('usuarios', {
        fields: ['perfil'], type: 'check', name: 'usuarios_perfil_valido',
        where: { perfil: { [Sequelize.Op.in]: ['ADMIN_CLUBE', 'LEITOR'] } }, transaction,
      });

      await queryInterface.createTable('generos', {
        id: identificador(),
        nome: { type: Sequelize.STRING(80), allowNull: false },
        ...auditoria(),
      }, opcoes);
      await queryInterface.addConstraint('generos', {
        fields: ['nome'], type: 'unique', name: 'generos_nome_unico', transaction,
      });

      await queryInterface.createTable('livros', {
        id: identificador(),
        titulo: { type: Sequelize.STRING(200), allowNull: false },
        autor_informado: { type: Sequelize.STRING(200), allowNull: false },
        genero_id: referencia('generos'),
        ...auditoria(),
      }, opcoes);

      await queryInterface.createTable('ciclos_leitura', {
        id: identificador(),
        livro_id: referencia('livros'),
        data_inicio: { type: Sequelize.DATEONLY, allowNull: false },
        data_fim: { type: Sequelize.DATEONLY, allowNull: false },
        ...auditoria(),
      }, opcoes);
      await queryInterface.addConstraint('ciclos_leitura', {
        fields: ['data_inicio', 'data_fim'], type: 'check', name: 'ciclos_leitura_periodo_valido',
        where: Sequelize.literal('"data_fim" >= "data_inicio"'), transaction,
      });

      await queryInterface.createTable('encontros', {
        id: identificador(),
        ciclo_leitura_id: referencia('ciclos_leitura'),
        titulo: { type: Sequelize.STRING(200), allowNull: false },
        data_hora: { type: Sequelize.DATE, allowNull: false },
        local: { type: Sequelize.STRING(200), allowNull: false },
        ...auditoria(),
      }, opcoes);

      await queryInterface.createTable('participacoes_leitura', {
        id: identificador(),
        usuario_id: referencia('usuarios'),
        ciclo_leitura_id: referencia('ciclos_leitura'),
        ...auditoria(),
      }, opcoes);
      await queryInterface.addConstraint('participacoes_leitura', {
        fields: ['usuario_id', 'ciclo_leitura_id'], type: 'unique',
        name: 'participacoes_leitura_usuario_ciclo_unico', transaction,
      });

      await queryInterface.createTable('inscricoes_encontro', {
        id: identificador(),
        usuario_id: referencia('usuarios'),
        encontro_id: referencia('encontros'),
        ...auditoria(),
      }, opcoes);
      await queryInterface.addConstraint('inscricoes_encontro', {
        fields: ['usuario_id', 'encontro_id'], type: 'unique',
        name: 'inscricoes_encontro_usuario_encontro_unico', transaction,
      });
    });
  },

  async down(queryInterface) {
    // Rollback apaga dados: só pode atingir o banco de testes validado e isolado.
    validarDestinoTeste(queryInterface.sequelize);

    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const tabela of [
        'inscricoes_encontro', 'participacoes_leitura', 'encontros',
        'ciclos_leitura', 'livros', 'generos', 'usuarios',
      ]) {
        await queryInterface.dropTable(tabela, { transaction });
      }
    });
  },
};
