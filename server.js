'use strict';

const { carregarAmbiente } = require('./configuracao/ambiente');
const { carregarConfiguracaoSessao } = require('./configuracao/sessao');
const { encerrarAutenticacao } = require('./autenticacao/servico');
const banco = require('./database/conexao');

function iniciarServidor() {
  const { porta } = carregarAmbiente();
  carregarConfiguracaoSessao();
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
        const resultados = await Promise.allSettled([encerrarAutenticacao(), banco.encerrarConexao()]);
        if (resultados.some((resultado) => resultado.status === 'rejected')) {
          throw new Error('Falha ao encerrar conexões.');
        }
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
    Promise.allSettled([encerrarAutenticacao(), banco.encerrarConexao()]).then((resultados) => {
      if (resultados.every((resultado) => resultado.status === 'fulfilled')) return;
      console.error('Não foi possível encerrar as conexões PostgreSQL.');
    });
  });

  return servidor;
}

if (require.main === module && !require('./utilitarios/ajuda').exibirAjuda('start')) {
  try {
    iniciarServidor();
  } catch (erro) {
    console.error('Não foi possível iniciar o servidor:', erro.message);
    process.exitCode = 1;
  }
}

module.exports = { iniciarServidor };
