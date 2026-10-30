'use strict';

const { DataTypes } = require('sequelize');
const { definirUsuario } = require('./usuario');
const { definirGenero } = require('./genero');
const { definirLivro } = require('./livro');
const { definirAssociacoes } = require('./associacoes');

// A estrutura física é definida pelas migrations. Estes modelos apenas a descrevem.
// Um autor informado e um gênero por livro; associações M:N usam tabelas próprias.
// Percentuais e contadores são derivados, portanto não são armazenados.
function definirModelos(sequelize) {
  const opcoes = (tableName) => ({
    tableName,
    freezeTableName: true,
    timestamps: true,
    createdAt: 'criadoEm',
    updatedAt: 'atualizadoEm',
    underscored: true,
  });
  const identificador = () => ({
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false,
  });
  const chaveEstrangeira = (field) => ({
    type: DataTypes.INTEGER,
    allowNull: false,
    field,
  });

  const Usuario = definirUsuario(sequelize);

  const Genero = definirGenero(sequelize);
  const Livro = definirLivro(sequelize);

  const CicloLeitura = sequelize.define('CicloLeitura', {
    id: identificador(),
    livroId: chaveEstrangeira('livro_id'),
    dataInicio: { type: DataTypes.DATEONLY, allowNull: false, field: 'data_inicio' },
    dataFim: { type: DataTypes.DATEONLY, allowNull: false, field: 'data_fim' },
  }, opcoes('ciclos_leitura'));

  const Encontro = sequelize.define('Encontro', {
    id: identificador(),
    cicloLeituraId: chaveEstrangeira('ciclo_leitura_id'),
    titulo: { type: DataTypes.STRING(200), allowNull: false },
    dataHora: { type: DataTypes.DATE, allowNull: false, field: 'data_hora' },
    local: { type: DataTypes.STRING(200), allowNull: false },
  }, opcoes('encontros'));

  const ParticipacaoLeitura = sequelize.define('ParticipacaoLeitura', {
    id: identificador(),
    usuarioId: chaveEstrangeira('usuario_id'),
    cicloLeituraId: chaveEstrangeira('ciclo_leitura_id'),
  }, {
    ...opcoes('participacoes_leitura'),
    indexes: [{ unique: true, name: 'participacoes_leitura_usuario_ciclo_unico', fields: ['usuario_id', 'ciclo_leitura_id'] }],
  });

  const InscricaoEncontro = sequelize.define('InscricaoEncontro', {
    id: identificador(),
    usuarioId: chaveEstrangeira('usuario_id'),
    encontroId: chaveEstrangeira('encontro_id'),
  }, {
    ...opcoes('inscricoes_encontro'),
    indexes: [{ unique: true, name: 'inscricoes_encontro_usuario_encontro_unico', fields: ['usuario_id', 'encontro_id'] }],
  });

  const modelos = { Usuario, Genero, Livro, CicloLeitura, Encontro, ParticipacaoLeitura, InscricaoEncontro };
  definirAssociacoes(modelos);
  return modelos;
}

module.exports = { definirModelos };
