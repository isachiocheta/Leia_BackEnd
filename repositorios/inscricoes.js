'use strict';

const { executarConsulta, validarId, paginar } = require('./consultas');

function inscricaoPublica(linha) {
  const { inicioEm, ...dados } = linha;
  return { ...dados, encontro: { ...dados.encontro, inicioEm } };
}

function filtros(usuarioId, { futuros = true, somenteAgendados = false, agora = Date.now(), encontroId = null } = {}) {
  validarId(usuarioId); if (encontroId !== null) validarId(encontroId);
  if (typeof futuros !== 'boolean' || typeof somenteAgendados !== 'boolean' || !Number.isFinite(new Date(agora).getTime())) throw new TypeError('Filtro de agenda inválido.');
  return { usuario: usuarioId, encontro: encontroId, somenteFuturos: futuros, somenteAgendados, agora: new Date(agora) };
}

async function agendaLeitor(usuarioId, conexao, opcoes = {}) {
  const bind = filtros(usuarioId, opcoes);
  const [linhas, totais] = await Promise.all([
    executarConsulta('agendaLeitor', conexao, { ...bind, ...paginar(opcoes) }, opcoes),
    executarConsulta('contarAgenda', conexao, bind, opcoes),
  ]);
  return { data: linhas.map(inscricaoPublica), total: Number(totais[0].total) };
}

async function inscricaoPropria(encontroId, usuarioId, conexao, transaction) {
  const linhas = await executarConsulta('agendaLeitor', conexao, {
    ...filtros(usuarioId, { encontroId, futuros: false }), limite: 1, deslocamento: 0,
  }, { transaction });
  return linhas.length ? inscricaoPublica(linhas[0]) : null;
}

module.exports = { agendaLeitor, inscricaoPropria };
