'use strict';

// Todos os modelos já estão definidos quando suas associações são registradas.
// Os arquivos das entidades não importam uns aos outros.
function definirAssociacoes(modelos) {
  const { Usuario, Genero, Livro, CicloLeitura, Encontro, ParticipacaoLeitura, InscricaoEncontro } = modelos;
  const integridade = { onDelete: 'RESTRICT', onUpdate: 'CASCADE' };
  const generoId = () => ({ name: 'generoId', field: 'genero_id', allowNull: false });
  const livroId = () => ({ name: 'livroId', field: 'livro_id', allowNull: false });
  const cicloId = () => ({ name: 'cicloId', field: 'ciclo_id', allowNull: false });
  const usuarioId = () => ({ name: 'usuarioId', field: 'usuario_id', allowNull: false });
  const encontroId = () => ({ name: 'encontroId', field: 'encontro_id', allowNull: false });

  Genero.hasMany(Livro, { as: 'livros', foreignKey: generoId(), ...integridade });
  Livro.belongsTo(Genero, { as: 'genero', foreignKey: generoId(), ...integridade });
  // A obra cadastrada pode fundamentar vários ciclos sem duplicar o livro.
  Livro.hasMany(CicloLeitura, { as: 'ciclosLeitura', foreignKey: livroId(), ...integridade });
  CicloLeitura.belongsTo(Livro, { as: 'livro', foreignKey: livroId(), ...integridade });
  CicloLeitura.hasMany(Encontro, { as: 'encontros', foreignKey: cicloId(), ...integridade });
  Encontro.belongsTo(CicloLeitura, { as: 'ciclo', foreignKey: cicloId(), ...integridade });

  Usuario.hasMany(ParticipacaoLeitura, { as: 'participacoesLeitura', foreignKey: usuarioId(), ...integridade });
  ParticipacaoLeitura.belongsTo(Usuario, { as: 'usuario', foreignKey: usuarioId(), ...integridade });
  CicloLeitura.hasMany(ParticipacaoLeitura, { as: 'participacoesLeitura', foreignKey: cicloId(), ...integridade });
  ParticipacaoLeitura.belongsTo(CicloLeitura, { as: 'ciclo', foreignKey: cicloId(), ...integridade });
  // As FKs e os índices pertencem aos modelos de junção/migrations. O Sequelize
  // não deve substituir ações distintas por CASCADE nem gerar outra unicidade.
  Usuario.belongsToMany(CicloLeitura, {
    as: 'ciclosLeitura', through: { model: ParticipacaoLeitura, unique: false },
    foreignKey: usuarioId(), otherKey: cicloId(), constraints: false,
  });
  CicloLeitura.belongsToMany(Usuario, {
    as: 'usuariosParticipantes', through: { model: ParticipacaoLeitura, unique: false },
    foreignKey: cicloId(), otherKey: usuarioId(), constraints: false,
  });

  // A inscrição é intenção de comparecer. A validação de adesão ao mesmo ciclo
  // pertence ao serviço; no schema apenas excluir o encontro elimina inscrições.
  Usuario.hasMany(InscricaoEncontro, { as: 'inscricoesEncontro', foreignKey: usuarioId(), ...integridade });
  InscricaoEncontro.belongsTo(Usuario, { as: 'usuario', foreignKey: usuarioId(), ...integridade });
  const exclusaoEncontro = { onDelete: 'CASCADE', onUpdate: 'CASCADE' };
  Encontro.hasMany(InscricaoEncontro, { as: 'inscricoesEncontro', foreignKey: encontroId(), ...exclusaoEncontro });
  InscricaoEncontro.belongsTo(Encontro, { as: 'encontro', foreignKey: encontroId(), ...exclusaoEncontro });
  Usuario.belongsToMany(Encontro, {
    as: 'encontrosInscritos', through: { model: InscricaoEncontro, unique: false },
    foreignKey: usuarioId(), otherKey: encontroId(), constraints: false,
  });
  Encontro.belongsToMany(Usuario, {
    as: 'usuariosInscritos', through: { model: InscricaoEncontro, unique: false },
    foreignKey: encontroId(), otherKey: usuarioId(), constraints: false,
  });
}

module.exports = { definirAssociacoes };
