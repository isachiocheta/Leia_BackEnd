'use strict';

const { DataTypes } = require('sequelize');

function definirParticipacaoLeitura(sequelize) {
  return sequelize.define('ParticipacaoLeitura', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false, field: 'id' },
    usuarioId: {
      type: DataTypes.INTEGER, allowNull: false, field: 'usuario_id',
      references: { model: 'usuarios', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
    },
    cicloId: {
      type: DataTypes.INTEGER, allowNull: false, field: 'ciclo_id',
      references: { model: 'ciclos_leitura', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
    },
    paginaAtual: {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'pagina_atual',
      validate: { isInt: true, min: 0 },
    },
    concluidaEm: { type: DataTypes.DATE, allowNull: true, field: 'concluida_em', validate: { isDate: true } },
    // bulkCreate dos helpers M:N valida antes de atribuir os timestamps do ORM.
    // NOW preenche a instância em memória; não acrescenta DEFAULT ao schema.
    criadoEm: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'criado_em' },
    atualizadoEm: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'atualizado_em' },
  }, {
    tableName: 'participacoes_leitura',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
    indexes: [{ unique: true, name: 'participacoes_leitura_usuario_ciclo_unico', fields: ['usuario_id', 'ciclo_id'] }],
    // Participação é adesão ao ciclo. Usuário ativo e limite superior da página
    // dependem de outras entidades e pertencem aos serviços. Não há percentual
    // ou contadores armazenados, nem conclusão derivada automaticamente da página.
  });
}

module.exports = { definirParticipacaoLeitura };
