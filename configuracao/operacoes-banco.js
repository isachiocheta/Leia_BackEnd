'use strict';

const { carregarAmbiente } = require('./ambiente');
const { validarBancoTeste } = require('./banco');

function normalizarHost(host) {
  return String(host).replace(/^\[|\]$/g, '').toLowerCase();
}

function validarDestinoTeste(conexao, variaveis = process.env) {
  const configuracao = validarBancoTeste(variaveis);
  const esperado = new URL(configuracao.url);
  const destino = conexao?.config;
  const porta = Number(destino?.port);

  if (
    !destino ||
    typeof conexao.getDialect !== 'function' ||
    conexao.getDialect() !== 'postgres' ||
    destino.database !== configuracao.nomeBanco ||
    normalizarHost(destino.host) !== normalizarHost(esperado.hostname) ||
    !Number.isInteger(porta) ||
    porta < 1 ||
    porta > 65535 ||
    porta !== Number(esperado.port || 5432)
  ) {
    throw new Error('Operação destrutiva bloqueada: conexão diferente do banco de teste validado.');
  }

  return configuracao;
}

function validarOperacaoCli(argumentos = process.argv.slice(2), variaveis = process.env) {
  const { ambiente } = carregarAmbiente(variaveis);
  const destrutivos = new Set([
    'db:drop', 'db:migrate:undo', 'db:migrate:undo:all',
    'db:seed', 'db:seed:all', 'db:seed:undo', 'db:seed:undo:all',
    'db:migrate:schema:timestamps:add',
  ]);

  for (let indice = 0; indice < argumentos.length; indice += 1) {
    const argumento = argumentos[indice];
    const opcao = argumento.split('=')[0];

    // Impede que o destino validado seja substituído por outra URL/configuração.
    if (['--url', '--config', '--options-path', '--optionsPath'].includes(opcao)) {
      throw new Error('Use a configuração de banco do projeto e as URLs do ambiente, sem sobrescrever o destino.');
    }

    if (opcao === '--env') {
      const informado = argumento.includes('=') ? argumento.slice(argumento.indexOf('=') + 1) : argumentos[indice + 1];
      if (informado !== ambiente) {
        throw new Error('--env deve coincidir com NODE_ENV.');
      }
    }
  }

  if (argumentos.some((argumento) => destrutivos.has(argumento))) {
    validarBancoTeste(variaveis);
  }
}

module.exports = { validarDestinoTeste, validarOperacaoCli };
