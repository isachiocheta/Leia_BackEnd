'use strict';

const { carregarAmbiente } = require('./configuracao/ambiente');

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

    servidor.close((erro) => {
      clearTimeout(prazo);
      removerSinais();

      if (erro) {
        console.error('Não foi possível encerrar o servidor:', erro.message);
        process.exitCode = 1;
        return;
      }

      console.info('Leia+ encerrado.');
    });
  }

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  servidor.once('listening', () => {
    console.info(`Leia+ disponível em http://localhost:${porta}.`);
  });

  servidor.once('error', (erro) => {
    removerSinais();
    console.error('Não foi possível iniciar o servidor:', erro.message);
    process.exitCode = 1;
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
