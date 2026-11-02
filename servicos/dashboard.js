'use strict';

const { Transaction } = require('sequelize');
const { consultarTotais, consultarCicloAtual } = require('../repositorios/dashboard');
const relatorios = require('../repositorios/relatorios');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');
const { comContextoPersistencia } = require('../utilitarios/persistencia');

const LIMITE_LIVROS = 5;
const LIMITE_LEITORES = 12;
const MINIMO_CICLOS = 1;

function lista(data, total, pageSize) {
  return { data, meta: { page: 1, pageSize, total } };
}

async function consultarDashboardAdmin(conexao, { agora = Date.now } = {}) {
  const instante = new Date(agora());
  const generatedAt = instante.toISOString();
  const hoje = dataEmSaoPaulo(instante);
  return comContextoPersistencia('buscar', () => conexao.transaction({
    // Uma única conexão/snapshot para totais, detalhe, agregações e listas.
    // Nenhuma escrita ou lock de domínio é necessário para este relatório.
    isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
    readOnly: true,
  }, async (transaction) => {
    // No Sequelize 6, readOnly seleciona o pool de leitura; o PostgreSQL também
    // recebe explicitamente a restrição para impedir escritas neste relatório.
    await conexao.query('SET TRANSACTION READ ONLY', { transaction });
    const opcoes = { transaction };
    const totais = await consultarTotais(conexao, instante, transaction);
    const ciclo = await consultarCicloAtual(conexao, transaction);
    const livros = await relatorios.livrosMinimoCiclos(MINIMO_CICLOS, conexao, { ...opcoes, limit: LIMITE_LIVROS });
    const totalLivrosUtilizados = await relatorios.contarLivrosMinimoCiclos(MINIMO_CICLOS, conexao, opcoes);
    let cicloAtual = null;
    let leitoresSemParticipacao = lista([], 0, LIMITE_LEITORES);
    if (ciclo) {
      // A consulta da etapa 18 considera todo o histórico, sem filtrar situação
      // do usuário, e arredonda somente os resultados finais de AVG e da taxa.
      const resumo = await relatorios.resumoCiclo(ciclo.id, conexao, opcoes);
      cicloAtual = {
        id: ciclo.id, nome: ciclo.nome, situacao: ciclo.situacao, livro: ciclo.livro.get({ plain: true }),
        dataInicio: ciclo.dataInicio, dataFim: ciclo.dataFim,
        dentroDoPeriodo: ciclo.dataInicio <= hoje && hoje <= ciclo.dataFim,
        indicadores: {
          participantes: resumo.participantes, leiturasConcluidas: resumo.conclusoes,
          taxaConclusao: resumo.taxaConclusao, progressoMedio: resumo.mediaProgresso,
        },
      };
      const leitores = await relatorios.leitoresSemParticipacao(ciclo.id, conexao, { ...opcoes, limit: LIMITE_LEITORES });
      const total = await relatorios.contarLeitoresSemParticipacao(ciclo.id, conexao, opcoes);
      leitoresSemParticipacao = lista(leitores, total, LIMITE_LEITORES);
    }
    return {
      generatedAt, leitores: { ativos: totais.leitoresAtivos, pendentes: totais.leitoresPendentes },
      totalLivros: totais.totalLivros, totalCiclos: totais.totalCiclos,
      encontrosAgendadosFuturos: totais.encontrosAgendadosFuturos, cicloAtual,
      livrosMaisUtilizados: { ...lista(livros, totalLivrosUtilizados, LIMITE_LIVROS), minimoCiclos: MINIMO_CICLOS },
      leitoresSemParticipacao,
    };
  }));
}

module.exports = { consultarDashboardAdmin };
