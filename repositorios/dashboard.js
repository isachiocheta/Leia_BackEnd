'use strict';

const { executarConsulta } = require('./consultas');

async function consultarTotais(conexao, instante, transaction) {
  const [totais] = await executarConsulta('totaisDashboard', conexao, { agora: instante }, { transaction });
  return totais;
}

function consultarCicloAtual(conexao, transaction) {
  // O índice parcial garante no máximo um. Nunca usa PLANEJADO como substituto.
  return conexao.models.CicloLeitura.findOne({
    where: { situacao: 'EM_ANDAMENTO' }, attributes: ['id', 'nome', 'situacao', 'dataInicio', 'dataFim'],
    include: [{ model: conexao.models.Livro, as: 'livro', attributes: ['id', 'titulo', 'autor', 'totalPaginas'], required: true }],
    transaction,
  });
}

module.exports = { consultarTotais, consultarCicloAtual };
