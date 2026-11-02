'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const arquivos = Object.freeze({
  participantesCiclo: 'participantes-ciclo.sql', resumoCiclo: 'resumo-ciclo.sql', agendaLeitor: 'agenda-leitor.sql',
  livrosMinimoCiclos: 'livros-minimo-ciclos.sql', leitoresSemParticipacao: 'leitores-sem-participacao.sql',
  historicoLeituras: 'historico-leituras.sql', contarParticipantes: 'contar-participantes.sql', contarHistorico: 'contar-historico.sql', contarAgenda: 'contar-agenda.sql',
  inserirGenero: 'exemplos/inserir-genero.sql', atualizarGenero: 'exemplos/atualizar-genero.sql', excluirGenero: 'exemplos/excluir-genero.sql',
  totaisDashboard: 'totais-dashboard.sql', contarLivrosMinimoCiclos: 'contar-livros-minimo-ciclos.sql',
  contarLeitoresSemParticipacao: 'contar-leitores-sem-participacao.sql',
});
const cache = new Map();

function carregarConsulta(nome) {
  // O chamador escolhe uma chave interna, nunca um caminho vindo da requisição.
  if (!Object.hasOwn(arquivos, nome)) throw new TypeError('Consulta SQL não cadastrada.');
  if (!cache.has(nome)) cache.set(nome, readFileSync(join(__dirname, arquivos[nome]), 'utf8'));
  return cache.get(nome);
}

module.exports = { carregarConsulta };
