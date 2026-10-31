'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { criarArmazenamentoSessoes } = require('../autenticacao/armazenamento-sessoes');

function executar(armazenamento, metodo, ...argumentos) {
  return new Promise((resolve, reject) => {
    armazenamento[metodo](...argumentos, (erro, resultado) => erro ? reject(erro) : resolve(resultado));
  });
}

test('armazenamento exige pool explícito e não abre conexão durante a criação', async () => {
  assert.throws(() => criarArmazenamentoSessoes({}), /pool PostgreSQL/);
  let consultas = 0;
  const armazenamento = criarArmazenamentoSessoes({ pool: { async query() { consultas += 1; } } });
  assert.equal(consultas, 0);
  assert.equal(armazenamento.pruneTimer, undefined);
  await armazenamento.close();
});

test('grava somente o contrato técnico existente usando parâmetros e prazo recebido', async () => {
  const consultas = [];
  const armazenamento = criarArmazenamentoSessoes({ pool: {
    async query(sql, parametros) {
      consultas.push({ sql, parametros });
      return { rows: [] };
    },
  } });
  const sessao = { cookie: { expires: '2030-01-01T12:30:00.000Z' }, expiraEm: 1893491400000 };
  await executar(armazenamento, 'set', "sid'parametrizado", sessao);
  assert.equal(consultas.length, 1);
  assert.match(consultas[0].sql, /^INSERT INTO "sessoes" \(sess, expire, sid\)/);
  assert.doesNotMatch(consultas[0].sql, /CREATE|ALTER|sid'parametrizado/);
  assert.deepEqual(consultas[0].parametros, [sessao, Date.parse(sessao.cookie.expires) / 1000, "sid'parametrizado"]);
  assert.equal(armazenamento.pruneTimer, undefined);
  await armazenamento.close();
});

test('touch não grava nem renova expiração e pool externo permanece sob controle do chamador', async () => {
  let consultas = 0;
  let encerramentos = 0;
  const armazenamento = criarArmazenamentoSessoes({ pool: {
    async query() { consultas += 1; },
    async end() { encerramentos += 1; },
  } });
  await executar(armazenamento, 'touch', 'sid', { cookie: { expires: new Date() } });
  assert.equal(consultas, 0);
  await armazenamento.close();
  assert.equal(encerramentos, 0);
});

test('tabela ausente causa falha e não é criada automaticamente', async () => {
  const consultas = [];
  const ausencia = Object.assign(new Error('tabela ausente'), { code: '42P01' });
  const armazenamento = criarArmazenamentoSessoes({ pool: {
    async query(sql) {
      consultas.push(sql);
      throw ausencia;
    },
  } });
  await assert.rejects(executar(armazenamento, 'get', 'sid'), (erro) => erro === ausencia);
  assert.equal(consultas.length, 1);
  assert.match(consultas[0], /^SELECT sess FROM "sessoes"/);
  assert.doesNotMatch(consultas.join(' '), /CREATE|ALTER/);
  await armazenamento.close();
});
