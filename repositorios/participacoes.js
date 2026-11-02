'use strict';

const { executarConsulta, validarId, paginar } = require('./consultas');

async function participantesCiclo(cicloId, conexao, opcoes = {}) {
  validarId(cicloId);
  const [data, totais] = await Promise.all([
    executarConsulta('participantesCiclo', conexao, { ciclo: cicloId, ...paginar(opcoes) }, opcoes),
    executarConsulta('contarParticipantes', conexao, { ciclo: cicloId }, opcoes),
  ]);
  return { data, total: Number(totais[0].total) };
}

async function historicoLeituras(usuarioId, conexao, opcoes = {}) {
  validarId(usuarioId);
  const bind = { usuario: usuarioId, ciclo: null };
  const [data, totais] = await Promise.all([
    executarConsulta('historicoLeituras', conexao, { ...bind, ...paginar(opcoes) }, opcoes),
    executarConsulta('contarHistorico', conexao, bind, opcoes),
  ]);
  return { data, total: Number(totais[0].total) };
}

async function participacaoPropria(cicloId, usuarioId, conexao, transaction) {
  validarId(cicloId); validarId(usuarioId);
  const linhas = await executarConsulta('historicoLeituras', conexao, { usuario: usuarioId, ciclo: cicloId, limite: 1, deslocamento: 0 }, { transaction });
  return linhas[0] ?? null;
}

module.exports = { participantesCiclo, historicoLeituras, participacaoPropria };
