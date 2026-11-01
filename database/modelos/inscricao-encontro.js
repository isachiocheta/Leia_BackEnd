'use strict';

const { DataTypes } = require('sequelize');

function definirInscricaoEncontro(sequelize) {
  return sequelize.define('InscricaoEncontro', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false, field: 'id' },
    usuarioId: {
      type: DataTypes.INTEGER, allowNull: false, field: 'usuario_id',
      references: { model: 'usuarios', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
    },
    encontroId: {
      type: DataTypes.INTEGER, allowNull: false, field: 'encontro_id',
      references: { model: 'encontros', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
    },
    // Os helpers M:N validam o lote antes da atribuição automática de timestamps.
    // O valor é aplicado em memória, sem mudar os defaults definidos no banco.
    criadoEm: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'criado_em' },
    atualizadoEm: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'atualizado_em' },
  }, {
    tableName: 'inscricoes_encontro',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
    indexes: [{ unique: true, name: 'inscricoes_encontro_usuario_encontro_unico', fields: ['usuario_id', 'encontro_id'] }],
    // Inscrição é intenção de comparecer, não presença. Usuário ativo e vínculo
    // com o mesmo ciclo são verificados no serviço, sob locks dos pais. Não há
    // campos de presença, lotação ou contadores armazenados.
  });
}

module.exports = { definirInscricaoEncontro };
