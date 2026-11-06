'use strict';

const { verificarConexao, encerrarConexao } = require('./conexao');

async function verificar() {
  try {
    await verificarConexao();
    console.info('Conexão PostgreSQL disponível.');
  } catch {
    console.error('PostgreSQL indisponível. Verifique a configuração do banco no ambiente.');
    process.exitCode = 1;
  } finally {
    await encerrarConexao();
  }
}

if (require.main === module && !require('../utilitarios/ajuda').exibirAjuda('db:verificar')) verificar().catch(() => {
  console.error('Não foi possível encerrar a conexão PostgreSQL.');
  process.exitCode = 1;
});
