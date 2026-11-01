'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dataCivilReal, dataEmSaoPaulo } = require('../utilitarios/datas-civis');
const { bloquearCiclo } = require('../database/bloqueio-ciclo');
const { criarCiclo, listarCiclos } = require('../servicos/ciclos');

test('datas civis reais e dia final de São Paulo não são tratados como meia-noite UTC', () => {
  assert.equal(dataCivilReal('2024-02-29'), true);
  for (const data of ['2025-02-29', '1900-02-29', '2026-04-31', '0000-01-01', '2026-1-01']) assert.equal(dataCivilReal(data), false);
  assert.equal(dataCivilReal('2000-02-29'), true);
  assert.equal(dataEmSaoPaulo('2026-11-01T02:59:59.999Z'), '2026-10-31');
  assert.equal(dataEmSaoPaulo('2026-11-01T03:00:00Z'), '2026-11-01');
});

test('locks seguem livros crescentes antes do ciclo; vínculo alterado durante espera causa conflito', async () => {
  for (const livroAtual of [9, 4]) {
    const ordem = [];
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    const conexao = { models: {
      Livro: { async findByPk(id, opcoes) { assert.equal(opcoes.lock, 'UPDATE'); ordem.push(`livro:${id}`); return { id }; } },
      CicloLeitura: { async findByPk(id, opcoes) {
        if (!opcoes.lock) return { id, livroId: 9 };
        ordem.push(`ciclo:${id}`);
        return { id, livroId: livroAtual };
      } },
    } };
    if (livroAtual === 9) assert.equal((await bloquearCiclo(conexao, 7, transaction, 3)).livroId, 9);
    else await assert.rejects(bloquearCiclo(conexao, 7, transaction, 3), (erro) => erro.status === 409);
    assert.deepEqual(ordem, ['livro:3', 'livro:9', 'ciclo:7']);
  }
});

test('serviço recusa intervalo invertido ou data inexistente antes de escrever', async () => {
  for (const [dataInicio, dataFim] of [['2026-02-29', '2026-03-01'], ['2026-11-02', '2026-11-01']]) {
    await assert.rejects(criarCiclo({ dataInicio, dataFim }, {}), (erro) => erro.status === 422);
  }
});

test('listagem combina filtros vinculados e ordenação de mapa interno com id no desempate', async () => {
  const consultas = [];
  const conexao = { async query(sql, opcoes) {
    consultas.push({ sql, opcoes });
    return sql.startsWith('SELECT count') ? [{ total: '0' }] : [];
  } };
  const q = "x%' OR 1=1 --_";
  const resultado = await listarCiclos({ q, situacao: 'PLANEJADO', sort: 'nome', direction: 'desc' }, conexao);
  assert.equal(resultado.meta.pageSize, 12);
  const busca = consultas[0];
  assert.ok(!busca.sql.includes(q));
  assert.equal(busca.opcoes.bind.situacao, 'PLANEJADO');
  assert.match(busca.sql, /c\."nome" DESC, c\."id" DESC/);
  await assert.rejects(listarCiclos({ sort: 'id' }, conexao), (erro) => erro.status === 422);
});
