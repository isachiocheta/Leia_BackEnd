'use strict';

const { validarOperacaoCli } = require('../configuracao/operacoes-banco');

try {
  // Executa antes de o CLI poder selecionar outro arquivo de opções.
  validarOperacaoCli();
  require('sequelize-cli/lib/sequelize');
} catch {
  console.error('Comando de banco bloqueado. Confira NODE_ENV, as URLs e as opções permitidas.');
  process.exitCode = 1;
}
