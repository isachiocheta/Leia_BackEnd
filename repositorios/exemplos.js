'use strict';

const { carregarConsulta } = require('../database/consultas/carregar');
const { validarDestinoTeste } = require('../configuracao/operacoes-banco');

async function demonstrarEscritasEmTeste(conexao, { nome, novoNome }) {
  validarDestinoTeste(conexao);
  const transaction = await conexao.transaction();
  async function executar(nomeConsulta, bind) {
    validarDestinoTeste(conexao);
    const [linhas] = await conexao.query(carregarConsulta(nomeConsulta), { bind, transaction });
    return linhas[0];
  }
  try {
    const inserido = await executar('inserirGenero', { nome });
    const atualizado = await executar('atualizarGenero', { id: inserido.id, nome: novoNome });
    const excluido = await executar('excluirGenero', { id: inserido.id });
    return { inserido, atualizado, excluido };
  } finally {
    // O exemplo nunca confirma alterações, mesmo se uma escrita intermediária falhar.
    if (!transaction.finished) await transaction.rollback();
  }
}

module.exports = { demonstrarEscritasEmTeste };
