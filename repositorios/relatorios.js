'use strict';

const { executarConsulta, validarId, paginar } = require('./consultas');
const { exigirRecurso } = require('../utilitarios/persistencia');

async function resumoCiclo(cicloId, conexao, opcoes = {}) {
  validarId(cicloId);
  const linhas = await executarConsulta('resumoCiclo', conexao, { ciclo: cicloId }, opcoes);
  return exigirRecurso(linhas[0]);
}

async function livrosMinimoCiclos(minimo, conexao, opcoes = {}) {
  validarId(minimo);
  return executarConsulta('livrosMinimoCiclos', conexao, { minimo, ...paginar(opcoes) }, opcoes);
}

async function leitoresSemParticipacao(cicloId, conexao, opcoes = {}) {
  validarId(cicloId);
  exigirRecurso(await conexao.models.CicloLeitura.findByPk(cicloId, { attributes: ['id'], transaction: opcoes.transaction }));
  return executarConsulta('leitoresSemParticipacao', conexao, { ciclo: cicloId, ...paginar(opcoes) }, opcoes);
}

module.exports = { resumoCiclo, livrosMinimoCiclos, leitoresSemParticipacao };
