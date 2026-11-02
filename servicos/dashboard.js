'use strict';

const { Transaction } = require('sequelize');
const { consultarTotais, consultarCicloAtual, consultarTotaisLeitor } = require('../repositorios/dashboard');
const relatorios = require('../repositorios/relatorios');
const { participacaoPropria } = require('../repositorios/participacoes');
const { agendaLeitor } = require('../repositorios/inscricoes');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');
const { comContextoPersistencia } = require('../utilitarios/persistencia');

const LIMITE_LIVROS = 5;
const LIMITE_LEITORES = 12;
const MINIMO_CICLOS = 1;
const LIMITE_AGENDA = 5;

function lista(data, total, pageSize) {
  return { data, meta: { page: 1, pageSize, total } };
}

function cicloPublico(ciclo, hoje) {
  return {
    id: ciclo.id, nome: ciclo.nome, situacao: ciclo.situacao, livro: ciclo.livro.get({ plain: true }),
    dataInicio: ciclo.dataInicio, dataFim: ciclo.dataFim,
    dentroDoPeriodo: ciclo.dataInicio <= hoje && hoje <= ciclo.dataFim,
  };
}

function emSnapshot(conexao, consultar) {
  return comContextoPersistencia('buscar', () => conexao.transaction({
    // Uma única conexão/snapshot para totais, detalhe, agregações e listas.
    // Nenhuma escrita ou lock de domínio é necessário para este relatório.
    isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
    readOnly: true,
  }, async (transaction) => {
    // No Sequelize 6, readOnly seleciona o pool de leitura; o PostgreSQL também
    // recebe explicitamente a restrição para impedir escritas neste relatório.
    await conexao.query('SET TRANSACTION READ ONLY', { transaction });
    return consultar(transaction);
  }));
}

async function consultarDashboardAdmin(conexao, { agora = Date.now } = {}) {
  const instante = new Date(agora());
  const generatedAt = instante.toISOString();
  const hoje = dataEmSaoPaulo(instante);
  return emSnapshot(conexao, async (transaction) => {
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
        ...cicloPublico(ciclo, hoje),
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
  });
}

async function consultarDashboardLeitor(usuarioId, conexao, { agora = Date.now } = {}) {
  const instante = new Date(agora());
  const generatedAt = instante.toISOString();
  const hoje = dataEmSaoPaulo(instante);
  return emSnapshot(conexao, async (transaction) => {
    const totais = await consultarTotaisLeitor(usuarioId, conexao, transaction);
    const ciclo = await consultarCicloAtual(conexao, transaction);
    const cicloAtual = ciclo ? cicloPublico(ciclo, hoje) : null;
    let minhaParticipacao = null;
    if (ciclo) {
      // Reutiliza o histórico parametrizado da etapa 18; ausência é null e
      // nunca provoca criação. A autorização de escrita continua no serviço.
      const participacao = await participacaoPropria(ciclo.id, usuarioId, conexao, transaction);
      if (participacao) minhaParticipacao = {
        id: participacao.id, cicloId: participacao.cicloId, paginaAtual: participacao.paginaAtual,
        totalPaginas: participacao.livro.totalPaginas, percentual: participacao.percentual,
        concluida: participacao.concluida, concluidaEm: participacao.concluidaEm,
        // Apenas indicação para a interface: escrita reconfere conta/versão,
        // participação, estado e período sob os locks existentes.
        podeAtualizarProgresso: cicloAtual.situacao === 'EM_ANDAMENTO' && cicloAtual.dentroDoPeriodo,
      };
    }
    const agenda = await agendaLeitor(usuarioId, conexao, {
      transaction, agora: instante, futuros: true, somenteAgendados: true, limit: LIMITE_AGENDA,
    });
    return {
      generatedAt, totalParticipacoes: totais.totalParticipacoes, leiturasConcluidas: totais.leiturasConcluidas,
      cicloAtual, minhaParticipacao, agendaFutura: agenda.data, totalInscricoesFuturas: agenda.total,
    };
  });
}

module.exports = { consultarDashboardAdmin, consultarDashboardLeitor };
