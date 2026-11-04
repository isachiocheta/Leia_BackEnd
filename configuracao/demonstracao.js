'use strict';

const { senhaValida } = require('../utilitarios/senha');
const { dataCivilReal } = require('../utilitarios/datas-civis');

const variaveisSenhas = Object.freeze({
  inicio: 'DEMO_SENHA_INICIO', metade: 'DEMO_SENHA_METADE', final: 'DEMO_SENHA_FINAL',
  semParticipacao: 'DEMO_SENHA_SEM_PARTICIPACAO', pendente: 'DEMO_SENHA_PENDENTE',
});

function configuracaoInvalida() {
  const erro = new Error('Confira DEMO_DATA_BASE e as cinco senhas DEMO_SENHA_*: mínimo 10 caracteres e máximo 72 bytes UTF-8.');
  erro.codigo = 'CONFIGURACAO_DEMONSTRACAO_INVALIDA';
  return erro;
}

function carregarDemonstracao(variaveis = process.env) {
  const dataBase = variaveis.DEMO_DATA_BASE || null;
  if (dataBase !== null && !dataCivilReal(dataBase)) throw configuracaoInvalida();
  const senhas = {};
  for (const [papel, nome] of Object.entries(variaveisSenhas)) {
    if (!senhaValida(variaveis[nome])) throw configuracaoInvalida();
    senhas[papel] = variaveis[nome]; // Preserva espaços, Unicode e bytes originais.
  }
  return { dataBase, senhas };
}

module.exports = { carregarDemonstracao, configuracaoInvalida };
