'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { listarLivros, criarLivro, editarLivro, excluirLivro, anoAtual } = require('../servicos/catalogo');
const { bloquearLivro } = require('../database/bloqueio-livro');

test('busca usa valores vinculados, mapa interno e anos nulos ao final nas duas direções', async () => {
  for (const direction of ['asc', 'desc']) {
    const consultas = [];
    const conexao = { async query(sql, opcoes) {
      consultas.push({ sql, opcoes });
      return sql.startsWith('SELECT count') ? [{ total: '0' }] : [];
    } };
    const q = "x%' OR 1=1 --_";
    const resultado = await listarLivros({ q, generoId: 7, sort: 'anoPublicacao', direction }, conexao);
    assert.equal(resultado.meta.pageSize, 12);
    const busca = consultas.find((consulta) => !consulta.sql.startsWith('SELECT count'));
    assert.ok(!busca.sql.includes(q));
    assert.equal(busca.opcoes.bind.genero, 7);
    assert.equal(busca.opcoes.bind.termo, "%x\\%' OR 1=1 --\\_%");
    assert.match(busca.sql, new RegExp(`l\."ano_publicacao" ${direction.toUpperCase()} NULLS LAST, l\."id" ${direction.toUpperCase()}`));
    await assert.rejects(listarLivros({ sort: 'titulo; DROP TABLE livros' }, conexao), (erro) => erro.status === 422);
  }
});

test('serviço rejeita ano futuro antes de acessar banco, mesmo sem o validador HTTP', async () => {
  await assert.rejects(criarLivro({ anoPublicacao: anoAtual() + 1 }, {}), (erro) => erro.status === 422);
});

test('dependências são verificadas sob lock do livro antes de alterar páginas ou excluir', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  let bloqueado = false;
  let escritas = 0;
  const conexao = {
    async transaction(opcoes, executar) { assert.equal(opcoes.isolationLevel, 'READ COMMITTED'); return executar(transaction); },
    models: {
      Livro: { async findByPk(id, opcoes) {
        assert.equal(opcoes.transaction, transaction);
        assert.equal(opcoes.lock, transaction.LOCK.UPDATE);
        bloqueado = true;
        return { totalPaginas: 100, async update() { escritas += 1; }, async destroy() { escritas += 1; } };
      } },
      CicloLeitura: { async findOne(opcoes) {
        assert.equal(bloqueado, true);
        assert.deepEqual(opcoes.where, { livroId: 7 });
        assert.equal(opcoes.transaction, transaction);
        return { id: 9 };
      } },
    },
  };
  await assert.rejects(editarLivro(7, { totalPaginas: 200, titulo: 'Não gravar parcialmente' }, conexao), (erro) => erro.status === 409);
  bloqueado = false;
  await assert.rejects(excluirLivro(7, conexao), (erro) => erro.status === 409);
  assert.equal(escritas, 0);
  await assert.rejects(bloquearLivro(conexao, 7), TypeError);
});

test('FK durante exclusão continua traduzida para dependência 409', async () => {
  const { ForeignKeyConstraintError } = require('sequelize');
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const conexao = {
    async transaction(opcoes, executar) { return executar(transaction); },
    models: {
      Livro: { async findByPk() { return { async destroy() { throw new ForeignKeyConstraintError({}); } }; } },
      CicloLeitura: { async findOne() { return null; } },
    },
  };
  await assert.rejects(excluirLivro(7, conexao), (erro) => erro.status === 409 && erro.codigo === 'RESOURCE_IN_USE');
});
