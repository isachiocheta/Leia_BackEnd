'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inscreverNoEncontro, cancelarMinhaInscricao, listarMinhasInscricoes } = require('../servicos/inscricoes');

function bancoSimulado() {
  let criacoes = 0;
  const ciclo = { id: 9, livroId: 3, situacao: 'EM_ANDAMENTO', dataInicio: '2026-11-01', dataFim: '2026-11-03' };
  const encontro = { id: 5, cicloId: 9, situacao: 'AGENDADO', inicioEm: new Date('2026-11-02T15:00:00Z') };
  const transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const conexao = {
    async transaction(opcoes, executar) { assert.equal(opcoes.isolationLevel, 'READ COMMITTED'); return executar(transaction); },
    models: {
      CicloLeitura: { async findByPk() { return ciclo; } }, Livro: { async findByPk() { return { id: 3 }; } }, Encontro: { async findByPk() { return encontro; } },
      Usuario: { async findByPk(id, opcoes) { assert.equal(id, 7); assert.equal(opcoes.lock, 'SHARE'); return { id: 7, perfil: 'LEITOR', situacao: 'ATIVO', sessionVersion: 0 }; } },
      ParticipacaoLeitura: { async findOne(opcoes) { assert.deepEqual(opcoes.where, { usuarioId: 7, cicloId: 9 }); return null; } },
      InscricaoEncontro: { async create() { criacoes += 1; }, async findOne(opcoes) { assert.deepEqual(opcoes.where, { usuarioId: 7, encontroId: 5 }); return null; } },
    },
  };
  return { conexao, ciclo, encontro, criacoes: () => criacoes };
}

test('participação é conferida no ciclo relido, usando somente o titular da sessão', async () => {
  const { conexao, criacoes } = bancoSimulado();
  await assert.rejects(inscreverNoEncontro(5, { id: 7, sessionVersion: 0 }, conexao, { agora: () => Date.parse('2026-11-01T15:00:00Z') }), (erro) => erro.status === 403);
  assert.equal(criacoes(), 0);
});

test('ausência própria no cancelamento é 404 mesmo em encontro finalizado e ciclo encerrado', async () => {
  const { conexao, ciclo, encontro } = bancoSimulado(); ciclo.situacao = 'CONCLUIDO'; encontro.situacao = 'REALIZADO';
  await assert.rejects(cancelarMinhaInscricao(5, { id: 7, sessionVersion: 0 }, conexao), (erro) => erro.status === 404);
});

test('filtro de futuros usa parâmetro temporal e a identidade, sem excluir histórico por situação', async () => {
  const consultas = [];
  const conexao = { async query(sql, opcoes) { consultas.push({ sql, opcoes }); return sql.startsWith('SELECT count') ? [{ total: '0' }] : []; } };
  const agora = Date.parse('2026-11-01T15:00:00Z');
  const resultado = await listarMinhasInscricoes(7, { futuros: 'true' }, conexao, { agora: () => agora });
  assert.equal(resultado.meta.pageSize, 12);
  assert.match(consultas[0].sql, /i.usuario_id = \$usuario AND e.inicio_em > \$agora/);
  assert.equal(consultas[0].opcoes.bind.usuario, 7); assert.equal(consultas[0].opcoes.bind.agora.getTime(), agora);
  assert.doesNotMatch(consultas[0].sql, /e.situacao =/);
  await assert.rejects(listarMinhasInscricoes(7, { futuros: '1' }, conexao), (erro) => erro.status === 422);
});
