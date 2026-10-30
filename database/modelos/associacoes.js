'use strict';

// Todos os modelos já estão definidos quando suas associações são registradas.
// Os arquivos das entidades não importam uns aos outros.
function definirAssociacoes(modelos) {
  const { Usuario, Genero, Livro, CicloLeitura, Encontro, ParticipacaoLeitura, InscricaoEncontro } = modelos;
  const integridade = { onDelete: 'RESTRICT', onUpdate: 'CASCADE' };
  const generoId = () => ({ name: 'generoId', field: 'genero_id', allowNull: false });
  const livroId = () => ({ name: 'livroId', field: 'livro_id', allowNull: false });
  const cicloId = () => ({ name: 'cicloId', field: 'ciclo_id', allowNull: false });

  Genero.hasMany(Livro, { as: 'livros', foreignKey: generoId(), ...integridade });
  Livro.belongsTo(Genero, { as: 'genero', foreignKey: generoId(), ...integridade });
  // A obra cadastrada pode fundamentar vários ciclos sem duplicar o livro.
  Livro.hasMany(CicloLeitura, { as: 'ciclosLeitura', foreignKey: livroId(), ...integridade });
  CicloLeitura.belongsTo(Livro, { as: 'livro', foreignKey: livroId(), ...integridade });
  CicloLeitura.hasMany(Encontro, { as: 'encontros', foreignKey: cicloId(), ...integridade });
  Encontro.belongsTo(CicloLeitura, { as: 'ciclo', foreignKey: cicloId(), ...integridade });

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
}

module.exports = { definirAssociacoes };
