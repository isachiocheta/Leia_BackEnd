'use strict';

const { DataTypes } = require('sequelize');

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

  const Usuario = sequelize.define('Usuario', {
    id: identificador(),
    nome: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(254), allowNull: false, unique: 'usuarios_email_unico' },
    perfil: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'LEITOR',
      validate: { isIn: [['ADMIN_CLUBE', 'LEITOR']] },
    },
  }, opcoes('usuarios'));

  const Genero = sequelize.define('Genero', {
    id: identificador(),
    nome: { type: DataTypes.STRING(80), allowNull: false, unique: 'generos_nome_unico' },
  }, opcoes('generos'));

  const Livro = sequelize.define('Livro', {
    id: identificador(),
    titulo: { type: DataTypes.STRING(200), allowNull: false },
    autorInformado: { type: DataTypes.STRING(200), allowNull: false, field: 'autor_informado' },
    generoId: chaveEstrangeira('genero_id'),
  }, opcoes('livros'));

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

  const integridade = { onDelete: 'RESTRICT', onUpdate: 'CASCADE' };

  Genero.hasMany(Livro, { as: 'livros', foreignKey: 'generoId', ...integridade });
  Livro.belongsTo(Genero, { as: 'genero', foreignKey: 'generoId', ...integridade });
  Livro.hasMany(CicloLeitura, { as: 'ciclosLeitura', foreignKey: 'livroId', ...integridade });
  CicloLeitura.belongsTo(Livro, { as: 'livro', foreignKey: 'livroId', ...integridade });
  CicloLeitura.hasMany(Encontro, { as: 'encontros', foreignKey: 'cicloLeituraId', ...integridade });
  Encontro.belongsTo(CicloLeitura, { as: 'cicloLeitura', foreignKey: 'cicloLeituraId', ...integridade });

  Usuario.hasMany(ParticipacaoLeitura, { as: 'participacoesLeitura', foreignKey: 'usuarioId', ...integridade });
  ParticipacaoLeitura.belongsTo(Usuario, { as: 'usuario', foreignKey: 'usuarioId', ...integridade });
  CicloLeitura.hasMany(ParticipacaoLeitura, { as: 'participacoesLeitura', foreignKey: 'cicloLeituraId', ...integridade });
  ParticipacaoLeitura.belongsTo(CicloLeitura, { as: 'cicloLeitura', foreignKey: 'cicloLeituraId', ...integridade });
  Usuario.belongsToMany(CicloLeitura, {
    as: 'ciclosLeitura', through: { model: ParticipacaoLeitura, unique: false },
    foreignKey: 'usuarioId', otherKey: 'cicloLeituraId', ...integridade,
  });
  CicloLeitura.belongsToMany(Usuario, {
    as: 'usuariosParticipantes', through: { model: ParticipacaoLeitura, unique: false },
    foreignKey: 'cicloLeituraId', otherKey: 'usuarioId', ...integridade,
  });

  // A inscrição em encontro independe da participação no ciclo nesta modelagem.
  Usuario.hasMany(InscricaoEncontro, { as: 'inscricoesEncontro', foreignKey: 'usuarioId', ...integridade });
  InscricaoEncontro.belongsTo(Usuario, { as: 'usuario', foreignKey: 'usuarioId', ...integridade });
  Encontro.hasMany(InscricaoEncontro, { as: 'inscricoesEncontro', foreignKey: 'encontroId', ...integridade });
  InscricaoEncontro.belongsTo(Encontro, { as: 'encontro', foreignKey: 'encontroId', ...integridade });
  Usuario.belongsToMany(Encontro, {
    as: 'encontrosInscritos', through: { model: InscricaoEncontro, unique: false },
    foreignKey: 'usuarioId', otherKey: 'encontroId', ...integridade,
  });
  Encontro.belongsToMany(Usuario, {
    as: 'usuariosInscritos', through: { model: InscricaoEncontro, unique: false },
    foreignKey: 'encontroId', otherKey: 'usuarioId', ...integridade,
  });

  return { Usuario, Genero, Livro, CicloLeitura, Encontro, ParticipacaoLeitura, InscricaoEncontro };
}

module.exports = { definirModelos };
