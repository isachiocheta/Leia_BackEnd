'use strict';

const { definirUsuario } = require('./usuario');
const { definirGenero } = require('./genero');
const { definirLivro } = require('./livro');
const { definirCicloLeitura } = require('./ciclo-leitura');
const { definirEncontro } = require('./encontro');
const { definirParticipacaoLeitura } = require('./participacao-leitura');
const { definirInscricaoEncontro } = require('./inscricao-encontro');
const { definirAssociacoes } = require('./associacoes');

// A estrutura física é definida pelas migrations. Estes modelos apenas a descrevem.
// Um autor informado e um gênero por livro; associações M:N usam tabelas próprias.
// Percentuais e contadores são derivados, portanto não são armazenados.
function definirModelos(sequelize) {
  const Usuario = definirUsuario(sequelize);
  const Genero = definirGenero(sequelize);
  const Livro = definirLivro(sequelize);
  const CicloLeitura = definirCicloLeitura(sequelize);
  const Encontro = definirEncontro(sequelize);
  const ParticipacaoLeitura = definirParticipacaoLeitura(sequelize);
  const InscricaoEncontro = definirInscricaoEncontro(sequelize);

  const modelos = { Usuario, Genero, Livro, CicloLeitura, Encontro, ParticipacaoLeitura, InscricaoEncontro };
  definirAssociacoes(modelos);
  return modelos;
}

module.exports = { definirModelos };
