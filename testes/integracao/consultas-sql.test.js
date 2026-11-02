'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcrypt');
const { QueryTypes } = require('sequelize');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { criarTabelasTemporarias, popularAvaliacao } = require('../apoio/tabelas-consultas');
const { carregarConsulta } = require('../../database/consultas/carregar');
const participacoes = require('../../repositorios/participacoes');
const { agendaLeitor } = require('../../repositorios/inscricoes');
const { resumoCiclo, livrosMinimoCiclos, leitoresSemParticipacao } = require('../../repositorios/relatorios');
const { demonstrarEscritasEmTeste } = require('../../repositorios/exemplos');

validarBancoTeste(process.env);

describe('Arquivos SQL executados pelos repositórios em PostgreSQL isolado', { timeout: 60_000 }, () => {
  let conexao; let transaction; let hash;
  const opcoes = () => ({ transaction, limit: 50 });
  before(async () => {
    conexao = criarConexao(); validarDestinoTeste(conexao); await conexao.authenticate(); hash = await bcrypt.hash('Senha exclusiva das fixtures SQL', 4);
    transaction = await conexao.transaction(); await criarTabelasTemporarias(conexao, transaction);
    const criar = (modelo, dados) => conexao.models[modelo].create(dados, { transaction });
    for (const [id, nome] of [[1, 'Romance'], [2, 'Ciência']]) await criar('Genero', { id, nome });
    for (const [id, totalPaginas, generoId] of [[1, 100, 1], [2, 20000, 2], [3, 50, 1]]) await criar('Livro', { id, titulo: `Obra ${id}`, autor: 'Autora', totalPaginas, generoId });
    for (const [id, situacao, perfil] of [[1, 'ATIVO', 'LEITOR'], [2, 'ATIVO', 'LEITOR'], [3, 'ATIVO', 'LEITOR'], [4, 'ATIVO', 'LEITOR'], [5, 'INATIVO', 'LEITOR'], [6, 'PENDENTE', 'LEITOR'], [7, 'ATIVO', 'ADMIN_CLUBE']]) {
      await criar('Usuario', { id, nome: `Pessoa ${id}`, email: `pessoa${id}@fixture.example`, senhaHash: hash, situacao, perfil, sessionVersion: 0 });
    }
    for (const [id, livroId] of [[1, 1], [2, 1], [3, 2], [4, 2]]) await criar('CicloLeitura', { id, livroId, nome: `Ciclo ${id}`, dataInicio: '2026-10-01', dataFim: '2026-11-30', situacao: id === 1 ? 'CONCLUIDO' : 'PLANEJADO' });
    let id = 0;
    for (const [usuarioId, cicloId, paginaAtual] of [[1, 1, 100], [2, 1, 50], [3, 1, 0], [1, 2, 10], [2, 2, 0], [3, 2, 0], [4, 2, 0], [1, 3, 19999]]) {
      await criar('ParticipacaoLeitura', { id: ++id, usuarioId, cicloId, paginaAtual, concluidaEm: paginaAtual === 100 ? new Date('2026-11-01T12:00:00Z') : null });
    }
    for (const [id, cicloId, inicioEm, situacao] of [[1, 1, '2026-11-02T15:00:00Z', 'AGENDADO'], [2, 1, '2026-11-03T15:00:00Z', 'CANCELADO'], [3, 2, '2026-10-31T15:00:00Z', 'REALIZADO'], [4, 1, '2026-10-30T15:00:00Z', 'REALIZADO']]) {
      await criar('Encontro', { id, cicloId, inicioEm, situacao, titulo: `Encontro ${id}`, local: 'Biblioteca' });
    }
    id = 0;
    for (const [usuarioId, encontroId] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 4]]) await criar('InscricaoEncontro', { id: ++id, usuarioId, encontroId });
  });
  after(async () => {
    try { if (transaction && !transaction.finished) { validarDestinoTeste(conexao); await transaction.rollback(); } }
    finally { if (conexao) await conexao.close(); }
  });

  it('1: participantes com livro/páginas/progresso são únicos apesar de vários encontros e inscritos', async () => {
    const resultado = await participacoes.participantesCiclo(1, conexao, opcoes());
    assert.equal(resultado.total, 3); assert.deepEqual(resultado.data.map((linha) => linha.usuario.id), [1, 2, 3]);
    assert.equal(new Set(resultado.data.map((linha) => linha.id)).size, 3);
    assert.deepEqual(resultado.data.map((linha) => linha.percentual), [100, 50, 0]);
    assert.equal(resultado.data[0].livro.totalPaginas, 100);
    const vazio = await participacoes.participantesCiclo(4, conexao, opcoes()); assert.deepEqual(vazio, { data: [], total: 0 });
    const pagina = await participacoes.participantesCiclo(1, conexao, { transaction, limit: 1, offset: 1 }); assert.equal(pagina.total, 3); assert.equal(pagina.data[0].usuario.id, 2);
  });

  it('2: resumo agrega uma vez, calcula divisão decimal e retorna zeros para ciclo vazio', async () => {
    const resumo = await resumoCiclo(1, conexao, opcoes());
    assert.equal(resumo.participantes, 3); assert.equal(resumo.conclusoes, 1); assert.equal(resumo.taxaConclusao, 33.33); assert.equal(resumo.mediaProgresso, 50);
    const longo = await resumoCiclo(3, conexao, opcoes()); assert.equal(longo.mediaProgresso, 100); assert.equal(longo.conclusoes, 0); assert.equal(longo.taxaConclusao, 0);
    const vazio = await resumoCiclo(4, conexao, opcoes()); for (const campo of ['participantes', 'conclusoes', 'taxaConclusao', 'mediaProgresso']) assert.equal(vazio[campo], 0);
    await assert.rejects(resumoCiclo(2147483647, conexao, opcoes()), (erro) => erro.status === 404);
  });

  it('3: agenda futura e histórico preservam titularidade, relacionamentos e situação explícita', async () => {
    const resultado = await agendaLeitor(1, conexao, { ...opcoes(), agora: Date.parse('2026-11-01T15:00:00Z') });
    assert.equal(resultado.total, 2); assert.deepEqual(resultado.data.map((linha) => linha.encontro.id), [1, 2]);
    assert.equal(resultado.data[0].encontro.inicioEm.toISOString(), '2026-11-02T15:00:00.000Z'); assert.equal(resultado.data[1].encontro.situacao, 'CANCELADO');
    assert.equal(resultado.data[0].ciclo.id, 1); assert.equal(resultado.data[0].livro.id, 1);
    const historico = await agendaLeitor(1, conexao, { ...opcoes(), futuros: false }); assert.equal(historico.total, 3);
    assert.deepEqual(await agendaLeitor(7, conexao, { ...opcoes(), futuros: false }), { data: [], total: 0 });
  });

  it('4: GROUP BY/HAVING contam ciclos da obra sem multiplicar por participantes e inscrições', async () => {
    const dados = await livrosMinimoCiclos(2, conexao, opcoes()); assert.deepEqual(dados.map((linha) => [linha.id, linha.totalCiclos]), [[1, 2], [2, 2]]);
    assert.deepEqual(await livrosMinimoCiclos(3, conexao, opcoes()), []);
    assert.deepEqual((await livrosMinimoCiclos(1, conexao, opcoes())).map((linha) => linha.id), [1, 2]);
    await assert.rejects(livrosMinimoCiclos(0, conexao, opcoes()), TypeError);
  });

  it('5: NOT EXISTS retorna só leitores ativos sem adesão no ciclo, inclusive resultado vazio', async () => {
    assert.deepEqual(await leitoresSemParticipacao(1, conexao, opcoes()), [{ id: 4, nome: 'Pessoa 4' }]);
    assert.deepEqual(await leitoresSemParticipacao(2, conexao, opcoes()), []);
    await assert.rejects(leitoresSemParticipacao(2147483647, conexao, opcoes()), (erro) => erro.status === 404);
  });

  it('6: histórico mantém cada leitura da mesma obra e seu gênero após encerramento', async () => {
    const resultado = await participacoes.historicoLeituras(1, conexao, opcoes()); assert.equal(resultado.total, 3);
    assert.deepEqual(resultado.data.map((linha) => linha.cicloId), [3, 2, 1]);
    assert.deepEqual(resultado.data.map((linha) => linha.genero.id), [2, 1, 1]);
    assert.equal(resultado.data[2].ciclo.situacao, 'CONCLUIDO'); assert.equal(resultado.data[0].percentual, 100); assert.equal(resultado.data[0].concluida, false);
    assert.deepEqual(await participacoes.historicoLeituras(7, conexao, opcoes()), { data: [], total: 0 });
  });

  it('exemplos INSERT/UPDATE/DELETE executam os arquivos e sempre fazem rollback, até após falha', async () => {
    const nome = `SQL 'teste' ${process.pid}-${Date.now()}`;
    const resultado = await demonstrarEscritasEmTeste(conexao, { nome, novoNome: `${nome} novo` });
    assert.equal(resultado.inserido.nome, nome); assert.equal(resultado.atualizado.nome, `${nome} novo`); assert.equal(resultado.excluido.id, resultado.inserido.id);
    assert.equal(await conexao.models.Genero.findByPk(resultado.inserido.id), null);
    await assert.rejects(demonstrarEscritasEmTeste(conexao, { nome, novoNome: 'x'.repeat(61) }));
    assert.equal(await conexao.models.Genero.count({ where: { nome } }), 0);
  });

  it('EXPLAIN ANALYZE dos mesmos arquivos avalia índices em tabelas temporárias com volumes maiores', async (contexto) => {
    validarDestinoTeste(conexao); const tx = await conexao.transaction();
    try {
      await popularAvaliacao(conexao, tx, hash);
      const paginas = { limite: 12, deslocamento: 0 };
      const consultas = {
        participantesCiclo: { ciclo: 5000, ...paginas }, resumoCiclo: { ciclo: 5000 },
        agendaLeitor: { usuario: 4, encontro: null, somenteFuturos: true, somenteAgendados: false, agora: new Date('2026-11-01T15:00:00Z'), ...paginas },
        livrosMinimoCiclos: { minimo: 4, ...paginas }, leitoresSemParticipacao: { ciclo: 5000, ...paginas },
        historicoLeituras: { usuario: 1, ciclo: null, ...paginas },
      };
      async function avaliar(nome, bind) {
        const linhas = await conexao.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n${carregarConsulta(nome)}`, { type: QueryTypes.SELECT, bind, transaction: tx });
        const plano = linhas[0]['QUERY PLAN'][0]; const nos = new Set(); const indices = new Set();
        function visitar(no) { nos.add(no['Node Type']); if (no['Index Name']) indices.add(no['Index Name']); (no.Plans || []).forEach(visitar); }
        visitar(plano.Plan); assert.ok(plano['Execution Time'] >= 0); assert.ok(plano.Plan['Actual Rows'] > 0);
        return { consulta: nome, linhas: plano.Plan['Actual Rows'], nos: [...nos], indices: [...indices], tempoMs: plano['Execution Time'] };
      }
      for (const [nome, bind] of Object.entries(consultas)) contexto.diagnostic(`PLANO_BASE ${JSON.stringify(await avaliar(nome, bind))}`);
      // Candidato somente temporário. Não cria índices nem estatísticas em tabelas públicas.
      await conexao.query('CREATE INDEX avaliacao_participacoes_ciclo_id ON pg_temp.participacoes_leitura (ciclo_id, id)', { transaction: tx });
      await conexao.query('ANALYZE pg_temp.participacoes_leitura', { transaction: tx });
      for (const nome of ['participantesCiclo', 'resumoCiclo']) contexto.diagnostic(`PLANO_CANDIDATO ${JSON.stringify(await avaliar(nome, consultas[nome]))}`);
    } finally { validarDestinoTeste(conexao); await tx.rollback(); }
  });
});
