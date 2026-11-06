'use strict';

function exibirAjuda(comando) {
  if (!process.argv.some((valor) => ['--help', '-h'].includes(valor))) return false;
  const pacote = require('../package.json');
  console.info(`Leia+ — npm run ${comando}\n\n${pacote.descricoesComandos[comando]}\n`);
  return true;
}

module.exports = { exibirAjuda };
