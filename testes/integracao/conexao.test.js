'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const { after, before, describe, it } = require('node:test');
const { Client } = require('pg');
const { QueryTypes } = require('sequelize');
const { validarBancoTeste } = require('../../configuracao/banco');
const {
  criarConexao,
  verificarConexao,
  encerrarConexao,
} = require('../../database/conexao');

// A integração exige um banco explicitamente separado; nunca usa DATABASE_URL
// como alternativa ao banco de teste e não cria nem remove tabelas.
const configuracao = validarBancoTeste(process.env);
const aplicacao = require('../../app');

async function listarTabelas(cliente) {
  // As suítes paralelas criam/removem estes schemas exclusivos. Seu DDL não
  // pertence a verificarConexao/ready. Mantém public e qualquer outro schema
  // observado, sem atribuir ao endpoint as tabelas das fixtures concorrentes.
  const resultado = await cliente.query(`
    SELECT n.nspname AS esquema, c.relname AS tabela
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname !~ '^leia_(dashboard|transversal)_[0-9]+_[0-9]+$'
     ORDER BY n.nspname, c.relname
  `);
  return resultado.rows;
}

describe('Conexão real com PostgreSQL', { timeout: 15_000 }, () => {
  let observador;
  let conexao;
  let servidor;
  let endereco;
  let tabelasAntes;

  before(async () => {
    observador = new Client({
      connectionString: configuracao.url,
      connectionTimeoutMillis: 3000,
      statement_timeout: 3000,
    });
    await observador.connect();
    tabelasAntes = await listarTabelas(observador);
    conexao = criarConexao(process.env);
    servidor = aplicacao.listen(0, '127.0.0.1');
    await once(servidor, 'listening');
    endereco = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    if (servidor) {
      await new Promise((resolver, rejeitar) => {
        servidor.close((erro) => (erro ? rejeitar(erro) : resolver()));
        servidor.closeAllConnections();
      });
    }
    if (conexao) await conexao.close();
    await encerrarConexao();
    if (observador) await observador.end();
  });

  it('autentica e consulta exclusivamente o banco de teste validado', async () => {
    await verificarConexao(conexao);
    const resultado = await conexao.query('SELECT current_database() AS banco', {
      type: QueryTypes.SELECT,
    });
    assert.equal(conexao.getDialect(), 'postgres');
    assert.deepEqual(resultado, [{ banco: configuracao.nomeBanco }]);
  });

  it('mantém health disponível e responde ready 200 com a conexão real', async () => {
    const health = await fetch(`${endereco}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { data: { aplicacao: 'Leia+', status: 'ok' } });

    const ready = await fetch(`${endereco}/api/ready`);
    assert.equal(ready.status, 200);
    assert.match(ready.headers.get('content-type'), /application\/json/);
    const corpo = await ready.json();
    assert.deepEqual(corpo, { data: { aplicacao: 'Leia+', status: 'pronto' } });
  });

  it('não cria tabelas ao verificar a conexão ou consultar ready', async () => {
    await verificarConexao(conexao);
    const ready = await fetch(`${endereco}/api/ready`);
    assert.equal(ready.status, 200);
    await ready.json();
    assert.deepEqual(await listarTabelas(observador), tabelasAntes);
  });

  it('propaga a indisponibilidade de uma conexão PostgreSQL recusada', async () => {
    const reserva = net.createServer();
    reserva.listen(0, '127.0.0.1');
    await once(reserva, 'listening');
    const porta = reserva.address().port;
    await new Promise((resolver, rejeitar) => {
      reserva.close((erro) => (erro ? rejeitar(erro) : resolver()));
    });

    const destino = new URL(configuracao.url);
    destino.hostname = '127.0.0.1';
    destino.port = String(porta);
    const indisponivel = criarConexao({
      ...process.env,
      TEST_DATABASE_URL: destino.href,
    });

    try {
      await assert.rejects(verificarConexao(indisponivel), {
        name: 'SequelizeConnectionRefusedError',
      });
    } finally {
      await indisponivel.close();
    }
  });
});
