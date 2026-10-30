'use strict';

const { carregarAmbiente } = require('./configuracao/ambiente');
const banco = require('./database/conexao');

function iniciarServidor() {
  const { porta } = carregarAmbiente();
  const app = require('./app');
  const servidor = app.listen(porta);
  let encerrando = false;

  function removerSinais() {
    process.off('SIGINT', encerrar);
    process.off('SIGTERM', encerrar);
  }

  function encerrar(sinal) {
    if (encerrando) return;
    encerrando = true;
    console.info(`Encerrando Leia+ (${sinal})...`);

    const prazo = setTimeout(() => {
      console.error('Prazo de encerramento excedido.');
      servidor.closeAllConnections();
      process.exit(1);
    }, 10_000);
    prazo.unref();

    servidor.close(async (erro) => {
      try {
        await banco.encerrarConexao();
        if (erro) throw erro;
        console.info('Leia+ encerrado.');
      } catch {
        console.error('Não foi possível encerrar o servidor e suas conexões.');
        process.exitCode = 1;
      } finally {
        clearTimeout(prazo);
        removerSinais();
      }
    });
  }

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  servidor.once('listening', () => {
    console.info(`Leia+ disponível em http://localhost:${porta}.`);
    banco.verificarConexao()
      .then(() => console.info('Conexão PostgreSQL disponível.'))
      .catch(() => console.warn('PostgreSQL indisponível; consulte /api/ready.'));
  });

  servidor.once('error', (erro) => {
    removerSinais();
    console.error('Não foi possível iniciar o servidor:', erro.message);
    process.exitCode = 1;
    banco.encerrarConexao().catch(() => {
      console.error('Não foi possível encerrar as conexões PostgreSQL.');
    });
  });

  return servidor;
}

if (require.main === module) {
  try {
    iniciarServidor();
  } catch (erro) {
    console.error('Não foi possível iniciar o servidor:', erro.message);
    process.exitCode = 1;
  }
}

module.exports = { iniciarServidor };
