'use strict';

const { Client } = require('pg');
const { validarBancoTeste } = require('../../configuracao/banco');

async function reservarCiclosAtivos() {
  const { url } = validarBancoTeste(process.env);
  const cliente = new Client({ connectionString: url, connectionTimeoutMillis: 3000, statement_timeout: 30000, query_timeout: 30000 });
  await cliente.connect();
  try { await cliente.query('SELECT pg_advisory_lock(hashtext($1))', ['leia+:fixtures:ciclo-ativo']); }
  catch (erro) { await cliente.end(); throw erro; }
  // Só coordena suítes que disputam o índice global no mesmo banco de teste.
  // As requisições HTTP concorrentes da suíte continuam sem esta trava de teste.
  return () => cliente.end();
}

module.exports = { reservarCiclosAtivos };
