'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { atualizarProgresso, listarMinhasParticipacoes } = require('../servicos/participacoes');

function bancoSimulado() {
  const transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const gravacoes = [];
  const usuario = { id: 7, perfil: 'LEITOR', situacao: 'ATIVO', sessionVersion: 0 };
  const ciclo = { id: 9, livroId: 3, situacao: 'EM_ANDAMENTO', dataInicio: '2026-11-01', dataFim: '2026-11-03' };
  const participacao = { paginaAtual: 99, concluidaEm: null, async update(dados, opcoes) { gravacoes.push({ dados, opcoes }); Object.assign(this, dados); } };
  const conexao = {
    async transaction(opcoes, executar) { assert.equal(opcoes.isolationLevel, 'READ COMMITTED'); return executar(transaction); },
    async query() { return [{ id: 5 }]; },
    models: {
      CicloLeitura: { async findByPk() { return ciclo; } },
      Livro: { async findByPk() { return { id: 3, totalPaginas: 100 }; } },
      Usuario: { async findByPk(id, opcoes) { assert.equal(id, 7); assert.equal(opcoes.lock, transaction.LOCK.SHARE); assert.ok(!opcoes.attributes.includes('senhaHash')); return usuario; } },
      ParticipacaoLeitura: { async findOne(opcoes) { assert.deepEqual(opcoes.where, { cicloId: 9, usuarioId: 7 }); assert.equal(opcoes.lock, transaction.LOCK.UPDATE); return participacao; } },
    },
  };
  return { conexao, gravacoes, participacao, usuario, ciclo, transaction };
}

test('página e conclusão são atômicas: repetição preserva, recuo limpa e nova conclusão tem nova data', async () => {
  const { conexao, gravacoes, participacao, transaction } = bancoSimulado();
  let agora = Date.parse('2026-11-01T15:00:00Z');
  const atualizar = (pagina) => atualizarProgresso(9, { id: 7, sessionVersion: 0 }, pagina, conexao, { agora: () => agora });
  await atualizar(100); const primeira = participacao.concluidaEm.getTime();
  agora += 1000; await atualizar(100); assert.equal(participacao.concluidaEm.getTime(), primeira);
  await atualizar(50); assert.equal(participacao.concluidaEm, null);
  agora += 1000; await atualizar(100); assert.equal(participacao.concluidaEm.getTime(), agora); assert.notEqual(agora, primeira);
  assert.equal(gravacoes.length, 3);
  for (const escrita of gravacoes) {
    assert.deepEqual(escrita.opcoes, { fields: ['paginaAtual', 'concluidaEm'], transaction });
    assert.deepEqual(Object.keys(escrita.dados), ['paginaAtual', 'concluidaEm']);
  }
});

test('situação, perfil e versão são reconferidos sob lock; ciclo vencido e página excessiva não gravam', async () => {
  for (const [mudanca, status] of [[{ situacao: 'INATIVO' }, 401], [{ perfil: 'ADMIN_CLUBE' }, 403], [{ sessionVersion: 1 }, 401]]) {
    const { conexao, gravacoes, usuario } = bancoSimulado(); Object.assign(usuario, mudanca);
    await assert.rejects(atualizarProgresso(9, { id: 7, sessionVersion: 0 }, 1, conexao), (erro) => erro.status === status);
    assert.equal(gravacoes.length, 0);
  }
  for (const [pagina, instante, status] of [[101, '2026-11-01T15:00:00Z', 422], [1, '2026-11-04T03:00:00Z', 409]]) {
    const { conexao, gravacoes } = bancoSimulado();
    await assert.rejects(atualizarProgresso(9, { id: 7, sessionVersion: 0 }, pagina, conexao, { agora: () => Date.parse(instante) }), (erro) => erro.status === status);
    assert.equal(gravacoes.length, 0);
  }
});

test('histórico usa identidade vinculada, divisão numeric e conclusão exata independente do arredondamento', async () => {
  const consultas = [];
  const conexao = { async query(sql, opcoes) { consultas.push({ sql, opcoes }); return sql.startsWith('SELECT count') ? [{ total: '0' }] : []; } };
  const resultado = await listarMinhasParticipacoes(7, {}, conexao);
  assert.equal(resultado.meta.pageSize, 12);
  assert.match(consultas[0].sql, /pagina_atual::numeric \* 100 \/ l.total_paginas/);
  assert.match(consultas[0].sql, /\(p.pagina_atual = l.total_paginas\) AS concluida/);
  assert.match(consultas[0].sql, /WHERE p.usuario_id = \$usuario/);
  assert.equal(consultas[0].opcoes.bind.usuario, 7);
  assert.ok(!consultas[0].sql.includes('EM_ANDAMENTO'));
});
