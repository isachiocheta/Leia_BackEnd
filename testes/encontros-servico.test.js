'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { instanteIsoComOffset } = require('../utilitarios/instantes');
const { bloquearEncontro } = require('../database/bloqueio-encontro');
const { listarEncontros } = require('../servicos/encontros');

test('instantes exigem offset, data real e precisão representável sem normalização silenciosa', () => {
  for (const valor of ['2024-02-29T23:59:59.999-03:00', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00+04:00']) assert.equal(instanteIsoComOffset(valor), true);
  for (const valor of [null, '2025-02-29T12:00:00Z', '2026-11-01', '2026-11-01T12:00:00', '2026-11-01T24:00:00Z', '2026-11-01T12:00:60Z', '2026-11-01T12:00:00-03:99', '2026-11-01T12:00:00.1234Z']) assert.equal(instanteIsoComOffset(valor), false);
});

test('livros e ciclos envolvidos são ordenados antes do encontro e o vínculo é relido', async () => {
  for (const cicloAtual of [9, 4]) {
    const ordem = [];
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    const conexao = { models: {
      Livro: { async findByPk(id) { ordem.push(`livro:${id}`); return { id }; } },
      CicloLeitura: { async findByPk(id, opcoes) {
        if (opcoes.lock) ordem.push(`ciclo:${id}`);
        return { id, livroId: id === 2 ? 8 : 3 };
      } },
      Encontro: { async findByPk(id, opcoes) {
        if (opcoes.lock) { ordem.push(`encontro:${id}`); return { id, cicloId: cicloAtual }; }
        return { id, cicloId: 9 };
      } },
    } };
    if (cicloAtual === 9) assert.equal((await bloquearEncontro(conexao, 7, transaction, 2)).destino.id, 2);
    else await assert.rejects(bloquearEncontro(conexao, 7, transaction, 2), (erro) => erro.status === 409);
    assert.deepEqual(ordem, ['livro:3', 'livro:8', 'ciclo:2', 'ciclo:9', 'encontro:7']);
  }
});

test('listagem vincula busca e filtros e usa somente ordenação interna com desempate', async () => {
  const consultas = [];
  const conexao = { async query(sql, opcoes) {
    consultas.push({ sql, opcoes }); return sql.startsWith('SELECT count') ? [{ total: '0' }] : [];
  } };
  const ataque = "x%' OR 1=1 --_";
  const resultado = await listarEncontros({ q: ataque, cicloId: 7, situacao: 'AGENDADO', sort: 'inicioEm', direction: 'desc' }, conexao);
  assert.equal(resultado.meta.pageSize, 12);
  assert.ok(!consultas[0].sql.includes(ataque));
  assert.equal(consultas[0].opcoes.bind.ciclo, 7);
  assert.equal(consultas[0].opcoes.bind.situacao, 'AGENDADO');
  assert.match(consultas[0].sql, /e\."inicio_em" DESC, e\."id" DESC/);
  assert.match(consultas[0].sql, /quantidadeInscritos/);
  await assert.rejects(listarEncontros({ sort: 'id' }, conexao), (erro) => erro.status === 422);
});
