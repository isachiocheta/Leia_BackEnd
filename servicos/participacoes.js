'use strict';

const { QueryTypes, Transaction } = require('sequelize');
const { bloquearCiclo } = require('../database/bloqueio-ciclo');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const { exigirRecurso, comContextoPersistencia } = require('../utilitarios/persistencia');
const { lerOpcoesListagem } = require('../utilitarios/listagem');
const { dataEmSaoPaulo } = require('../utilitarios/datas-civis');

const CAMPOS_PROGRESSO = `p.id, p.ciclo_id AS "cicloId", p.pagina_atual AS "paginaAtual",
  ROUND(p.pagina_atual::numeric * 100 / l.total_paginas, 2)::double precision AS percentual,
  (p.pagina_atual = l.total_paginas) AS concluida, p.concluida_em AS "concluidaEm",
  p.criado_em AS "criadoEm", p.atualizado_em AS "atualizadoEm"`;
const VINCULOS = `FROM participacoes_leitura p JOIN ciclos_leitura c ON c.id = p.ciclo_id JOIN livros l ON l.id = c.livro_id`;
const CONSULTA_PROPRIA = `SELECT ${CAMPOS_PROGRESSO},
  json_build_object('id', c.id, 'nome', c.nome, 'situacao', c.situacao, 'dataInicio', c.data_inicio::text, 'dataFim', c.data_fim::text) AS ciclo,
  json_build_object('id', l.id, 'titulo', l.titulo, 'totalPaginas', l.total_paginas) AS livro ${VINCULOS}`;

function conferirCicloLiberado(ciclo, instante) {
  const hoje = dataEmSaoPaulo(instante);
  if (ciclo.situacao !== 'EM_ANDAMENTO' || hoje < ciclo.dataInicio || hoje > ciclo.dataFim) throw new ErroAplicacao('CONFLICT');
}

async function conferirLeitor(identidade, conexao, transaction) {
  if (!Number.isInteger(identidade?.id) || identidade.id < 1 || !Number.isInteger(identidade?.sessionVersion) || identidade.sessionVersion < 0) {
    throw new ErroAplicacao('UNAUTHORIZED');
  }
  // Livros -> ciclo -> usuário -> participação. SHARE mantém a situação e a
  // versão válidas até o commit, inclusive diante de desativação/troca de senha.
  const usuario = await conexao.models.Usuario.findByPk(identidade.id, {
    attributes: ['id', 'perfil', 'situacao', 'sessionVersion'], transaction, lock: transaction.LOCK.SHARE,
  });
  if (!usuario || usuario.situacao !== 'ATIVO' || usuario.sessionVersion !== identidade.sessionVersion) throw new ErroAplicacao('UNAUTHORIZED');
  if (usuario.perfil !== 'LEITOR') throw new ErroAplicacao('FORBIDDEN');
}

async function consultarMinhaParticipacao(cicloId, usuarioId, conexao, transaction) {
  return comContextoPersistencia('buscar', async () => {
    const linhas = await conexao.query(`${CONSULTA_PROPRIA} WHERE p.ciclo_id = $ciclo AND p.usuario_id = $usuario`, {
      type: QueryTypes.SELECT, bind: { ciclo: cicloId, usuario: usuarioId }, transaction,
    });
    return exigirRecurso(linhas[0]);
  });
}

async function aderirAoCiclo(cicloId, identidade, conexao, { agora = Date.now } = {}) {
  return comContextoPersistencia('criar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const ciclo = await bloquearCiclo(conexao, cicloId, transaction);
    await conferirLeitor(identidade, conexao, transaction);
    conferirCicloLiberado(ciclo, agora());
    // A unicidade do banco arbitra também pedidos simultâneos. Nunca recebe
    // usuário, página inicial ou conclusão do corpo da requisição.
    await conexao.models.ParticipacaoLeitura.create({ usuarioId: identidade.id, cicloId, paginaAtual: 0, concluidaEm: null }, {
      fields: ['usuarioId', 'cicloId', 'paginaAtual', 'concluidaEm'], transaction,
    });
    return consultarMinhaParticipacao(cicloId, identidade.id, conexao, transaction);
  }));
}

async function atualizarProgresso(cicloId, identidade, paginaAtual, conexao, { agora = Date.now } = {}) {
  if (!Number.isInteger(paginaAtual) || paginaAtual < 0 || paginaAtual > 2147483647) {
    throw new ErroAplicacao('VALIDATION_ERROR', { fields: [{ field: 'paginaAtual', message: MENSAGENS_CAMPOS.INVALID_VALUE }] });
  }
  return comContextoPersistencia('atualizar', () => conexao.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const ciclo = await bloquearCiclo(conexao, cicloId, transaction);
    await conferirLeitor(identidade, conexao, transaction);
    const participacao = exigirRecurso(await conexao.models.ParticipacaoLeitura.findOne({
      where: { cicloId, usuarioId: identidade.id }, transaction, lock: transaction.LOCK.UPDATE,
    }));
    const instante = agora();
    conferirCicloLiberado(ciclo, instante);
    // O livro já foi bloqueado pelo protocolo do ciclo. A releitura usa esse
    // mesmo vínculo e transação; não adquire um livro novo depois do ciclo.
    const livro = exigirRecurso(await conexao.models.Livro.findByPk(ciclo.livroId, { attributes: ['id', 'totalPaginas'], transaction }));
    if (paginaAtual > livro.totalPaginas) throw new ErroAplicacao('VALIDATION_ERROR', {
      fields: [{ field: 'paginaAtual', message: MENSAGENS_CAMPOS.INVALID_VALUE }],
    });
    if (paginaAtual === livro.totalPaginas && participacao.paginaAtual === livro.totalPaginas) {
      // Repetição é leitura: preserva inclusive a precisão original do timestamp
      // no PostgreSQL, sem regravar uma data já existente pelo parser do Date.
      return consultarMinhaParticipacao(cicloId, identidade.id, conexao, transaction);
    }
    const concluidaEm = paginaAtual === livro.totalPaginas ? new Date(instante) : null;
    // Conclusão se baseia na página exata, jamais no percentual arredondado.
    await participacao.update({ paginaAtual, concluidaEm }, { fields: ['paginaAtual', 'concluidaEm'], transaction });
    return consultarMinhaParticipacao(cicloId, identidade.id, conexao, transaction);
  }));
}

async function listarMinhasParticipacoes(usuarioId, consulta, conexao) {
  const { page, pageSize, limit, offset } = lerOpcoesListagem(consulta, { id: 'id' });
  return comContextoPersistencia('buscar', async () => {
    const [data, totais] = await Promise.all([
      conexao.query(`${CONSULTA_PROPRIA} WHERE p.usuario_id = $usuario ORDER BY p.id DESC LIMIT $limite OFFSET $deslocamento`, {
        type: QueryTypes.SELECT, bind: { usuario: usuarioId, limite: limit, deslocamento: offset },
      }),
      conexao.query('SELECT count(*) AS total FROM participacoes_leitura WHERE usuario_id = $usuario', { type: QueryTypes.SELECT, bind: { usuario: usuarioId } }),
    ]);
    // O histórico não depende do estado nem do prazo atual do ciclo.
    return { data, meta: { page, pageSize, total: Number(totais[0].total) } };
  });
}

async function listarParticipantes(cicloId, consulta, conexao) {
  const { page, pageSize, limit, offset } = lerOpcoesListagem(consulta, { id: 'id' });
  return comContextoPersistencia('buscar', async () => {
    exigirRecurso(await conexao.models.CicloLeitura.findByPk(cicloId, { attributes: ['id'] }));
    const [data, totais] = await Promise.all([
      conexao.query(`SELECT ${CAMPOS_PROGRESSO}, json_build_object('id', u.id, 'nome', u.nome) AS usuario
        ${VINCULOS} JOIN usuarios u ON u.id = p.usuario_id WHERE p.ciclo_id = $ciclo
        ORDER BY p.id ASC LIMIT $limite OFFSET $deslocamento`, {
        type: QueryTypes.SELECT, bind: { ciclo: cicloId, limite: limit, deslocamento: offset },
      }),
      conexao.query('SELECT count(*) AS total FROM participacoes_leitura WHERE ciclo_id = $ciclo', { type: QueryTypes.SELECT, bind: { ciclo: cicloId } }),
    ]);
    return { data, meta: { page, pageSize, total: Number(totais[0].total) } };
  });
}

module.exports = { aderirAoCiclo, consultarMinhaParticipacao, atualizarProgresso, listarMinhasParticipacoes, listarParticipantes };
