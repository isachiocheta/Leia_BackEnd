'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { criarCenarioTransversal, disputarComBloqueio, comPrazo } = require('../apoio/cenario-transversal');
const { dataEmSaoPaulo } = require('../../utilitarios/datas-civis');

describe('Concorrência transversal: HTTP real e bloqueios observados no PostgreSQL', { timeout: 90_000 }, () => {
  let c;
  before(async () => { c = await criarCenarioTransversal(); });
  beforeEach(async () => c.resetar());
  after(async () => { if (c) await c.encerrar(); });
  const situacoes = (respostas, esperadas) => assert.deepEqual(respostas.map((resposta) => resposta.status), esperadas);

  it('duas ativações em conexões distintas passam a mesma barreira; o índice parcial deixa exatamente uma ativa', async (contexto) => {
    const a = await c.ciclo(await c.obra(), 'PLANEJADO'); const b = await c.ciclo(await c.obra(), 'PLANEJADO');
    const admin = await c.entrar(); const outra = await c.entrar(); const pids = new Set(); let chegou = 0; let liberar;
    const ambas = new Promise((resolver) => { liberar = resolver; }); const original = c.conexao.models.CicloLeitura.findOne;
    contexto.mock.method(c.conexao.models.CicloLeitura, 'findOne', async function (opcoes) {
      const resultado = await original.call(this, opcoes);
      if (opcoes.where?.situacao === 'EM_ANDAMENTO') {
        assert.equal(resultado, null); pids.add(opcoes.transaction.connection.processID);
        if (++chegou === 2) liberar(); await comPrazo(ambas);
      }
      return resultado;
    });
    const respostas = await comPrazo(Promise.all([c.pedir(admin, 'patch', `/api/ciclos/${a.id}`, { situacao: 'EM_ANDAMENTO' }), c.pedir(outra, 'patch', `/api/ciclos/${b.id}`, { situacao: 'EM_ANDAMENTO' })]));
    assert.deepEqual(respostas.map((resposta) => resposta.status).sort(), [200, 409]); assert.equal(pids.size, 2);
    const ciclos = await c.conexao.models.CicloLeitura.findAll({ order: [['id', 'ASC']] });
    assert.equal(ciclos.filter((registro) => registro.situacao === 'EM_ANDAMENTO').length, 1);
    assert.equal(ciclos.filter((registro) => registro.situacao === 'PLANEJADO').length, 1);
  });

  for (const tipo of ['participacoes', 'inscricoes']) it(`duplicidade de ${tipo} bloqueia realmente e persiste uma única linha`, async (contexto) => {
    const leitura = await c.ciclo(await c.obra()); const a = await c.entrar(c.contas.a); const b = await c.entrar(c.contas.a);
    let caminho; let modelo; let padrao;
    if (tipo === 'participacoes') { caminho = `/api/ciclos/${leitura.id}/participacoes`; modelo = 'ParticipacaoLeitura'; padrao = /^INSERT INTO "participacoes_leitura"/; }
    else { await c.participar(c.contas.a, leitura); const evento = await c.encontro(leitura); caminho = `/api/encontros/${evento.id}/inscricoes`; modelo = 'InscricaoEncontro'; padrao = /^INSERT INTO "inscricoes_encontro"/; }
    situacoes(await disputarComBloqueio(contexto, c, padrao, () => c.pedir(a, 'post', caminho), () => c.pedir(b, 'post', caminho)), [201, 409]);
    const linhas = await c.conexao.models[modelo].findAll(); assert.equal(linhas.length, 1); assert.equal(linhas[0].usuarioId, c.contas.a.id);
    if (tipo === 'participacoes') { assert.equal(linhas[0].paginaAtual, 0); assert.equal(linhas[0].concluidaEm, null); }
  });

  for (const primeiro of ['paginas', 'ciclo']) it(`páginas versus criação de ciclo: ${primeiro} primeiro, com vínculo e total finais válidos`, async (contexto) => {
    const obra = await c.obra(); const a = await c.entrar(); const b = await c.entrar();
    const paginas = () => c.pedir(a, 'patch', `/api/livros/${obra.id}`, { totalPaginas: 600 });
    const criar = () => c.pedir(b, 'post', '/api/ciclos', c.dadosCiclo(obra));
    const respostas = primeiro === 'paginas'
      ? await disputarComBloqueio(contexto, c, /^UPDATE "livros"/, paginas, criar)
      : await disputarComBloqueio(contexto, c, /^INSERT INTO "ciclos_leitura"/, criar, paginas);
    situacoes(respostas, primeiro === 'paginas' ? [200, 201] : [201, 409]);
    await obra.reload(); assert.equal(obra.totalPaginas, primeiro === 'paginas' ? 600 : 300);
    const ciclos = await c.conexao.models.CicloLeitura.findAll(); assert.equal(ciclos.length, 1); assert.equal(ciclos[0].livroId, obra.id);
    assert.equal((await c.pedir(a, 'get', `/api/ciclos/${ciclos[0].id}`)).body.data.livro.totalPaginas, obra.totalPaginas);
  });

  for (const primeiro of ['encontro', 'periodo']) it(`período versus encontro: ${primeiro} primeiro nunca deixa encontro fora do intervalo`, async (contexto) => {
    const leitura = await c.ciclo(await c.obra(), 'PLANEJADO'); const a = await c.entrar(); const b = await c.entrar();
    const encontro = () => c.pedir(a, 'post', '/api/encontros', c.dadosEncontro(leitura));
    const periodo = () => c.pedir(b, 'patch', `/api/ciclos/${leitura.id}`, { dataFim: dataEmSaoPaulo(c.base) });
    const respostas = primeiro === 'encontro'
      ? await disputarComBloqueio(contexto, c, /^INSERT INTO "encontros"/, encontro, periodo)
      : await disputarComBloqueio(contexto, c, /^UPDATE "ciclos_leitura"/, periodo, encontro);
    situacoes(respostas, primeiro === 'encontro' ? [201, 409] : [200, 422]);
    const [fora] = await c.conexao.query(`SELECT e.id FROM encontros e JOIN ciclos_leitura l ON l.id = e.ciclo_id
      WHERE timezone('America/Sao_Paulo', e.inicio_em)::date NOT BETWEEN l.data_inicio AND l.data_fim`);
    assert.deepEqual(fora, []); assert.equal(await c.conexao.models.Encontro.count(), primeiro === 'encontro' ? 1 : 0);
    await leitura.reload(); assert.equal(leitura.dataFim, primeiro === 'periodo' ? dataEmSaoPaulo(c.base) : c.dadosCiclo({ id: 1 }).dataFim);
  });

  for (const dependencia of ['participacao', 'encontro']) for (const primeiro of ['dependencia', 'livro']) {
    it(`troca de livro versus ${dependencia}: ${primeiro} primeiro, sem histórico transferido por corrida`, async (contexto) => {
      const original = await c.obra(); const destino = await c.obra(600); const leitura = await c.ciclo(original);
      const admin = await c.entrar(); const leitor = await c.entrar(c.contas.a);
      const criar = dependencia === 'participacao'
        ? () => c.pedir(leitor, 'post', `/api/ciclos/${leitura.id}/participacoes`)
        : () => c.pedir(admin, 'post', '/api/encontros', c.dadosEncontro(leitura));
      const trocar = () => c.pedir(admin, 'patch', `/api/ciclos/${leitura.id}`, { livroId: destino.id });
      const padrao = dependencia === 'participacao' ? /^INSERT INTO "participacoes_leitura"/ : /^INSERT INTO "encontros"/;
      const respostas = primeiro === 'dependencia'
        ? await disputarComBloqueio(contexto, c, padrao, criar, trocar)
        : await disputarComBloqueio(contexto, c, /^UPDATE "ciclos_leitura"/, trocar, criar);
      situacoes(respostas, primeiro === 'dependencia' ? [201, 409] : [200, 409]);
      await leitura.reload(); assert.equal(leitura.livroId, primeiro === 'dependencia' ? original.id : destino.id);
      assert.equal(await c.conexao.models[dependencia === 'participacao' ? 'ParticipacaoLeitura' : 'Encontro'].count(), primeiro === 'dependencia' ? 1 : 0);
      assert.equal(await c.conexao.models.Livro.count(), 2); assert.equal(await c.conexao.models.Usuario.count(), 5);
    });
  }

  for (const primeiro of ['progresso', 'encerramento']) it(`encerramento versus progresso: ${primeiro} primeiro, sem escrita posterior ao fechamento`, async (contexto) => {
    const leitura = await c.ciclo(await c.obra()); const participacao = await c.participar(c.contas.a, leitura);
    const admin = await c.entrar(); const leitor = await c.entrar(c.contas.a);
    const progresso = () => c.pedir(leitor, 'patch', `/api/ciclos/${leitura.id}/meu-progresso`, { paginaAtual: 300 });
    const encerrar = () => c.pedir(admin, 'patch', `/api/ciclos/${leitura.id}`, { situacao: 'CONCLUIDO' });
    const respostas = primeiro === 'progresso'
      ? await disputarComBloqueio(contexto, c, /^UPDATE "participacoes_leitura"/, progresso, encerrar)
      : await disputarComBloqueio(contexto, c, /^UPDATE "ciclos_leitura"/, encerrar, progresso);
    situacoes(respostas, primeiro === 'progresso' ? [200, 200] : [200, 409]);
    await leitura.reload(); await participacao.reload(); assert.equal(leitura.situacao, 'CONCLUIDO');
    assert.equal(participacao.paginaAtual, primeiro === 'progresso' ? 300 : 0);
    assert.equal(participacao.concluidaEm !== null, primeiro === 'progresso');
    assert.equal(await c.conexao.models.ParticipacaoLeitura.count(), 1);
  });

  for (const acao of ['cancelamento', 'exclusao']) for (const primeiro of ['inscricao', 'administracao']) {
    it(`inscrição versus ${acao}: ${primeiro} primeiro, com intenção histórica ou cascata exata`, async (contexto) => {
      const leitura = await c.ciclo(await c.obra()); const evento = await c.encontro(leitura); const participacao = await c.participar(c.contas.a, leitura);
      const admin = await c.entrar(); const leitor = await c.entrar(c.contas.a);
      const inscrever = () => c.pedir(leitor, 'post', `/api/encontros/${evento.id}/inscricoes`);
      const alterar = () => acao === 'cancelamento' ? c.pedir(admin, 'patch', `/api/encontros/${evento.id}`, { situacao: 'CANCELADO' }) : c.pedir(admin, 'delete', `/api/encontros/${evento.id}`);
      const padrao = acao === 'cancelamento' ? /^UPDATE "encontros"/ : /^DELETE FROM "encontros"/;
      const respostas = primeiro === 'inscricao'
        ? await disputarComBloqueio(contexto, c, /^INSERT INTO "inscricoes_encontro"/, inscrever, alterar)
        : await disputarComBloqueio(contexto, c, padrao, alterar, inscrever);
      situacoes(respostas, primeiro === 'inscricao' ? [201, acao === 'cancelamento' ? 200 : 204] : [acao === 'cancelamento' ? 200 : 204, acao === 'cancelamento' ? 409 : 404]);
      assert.equal(await c.conexao.models.InscricaoEncontro.count(), acao === 'cancelamento' && primeiro === 'inscricao' ? 1 : 0);
      const persistido = await c.conexao.models.Encontro.findByPk(evento.id);
      if (acao === 'exclusao') assert.equal(persistido, null); else assert.equal(persistido.situacao, 'CANCELADO');
      const [orfas] = await c.conexao.query('SELECT i.id FROM inscricoes_encontro i LEFT JOIN encontros e ON e.id = i.encontro_id WHERE e.id IS NULL'); assert.deepEqual(orfas, []);
      assert.equal((await participacao.reload()).cicloId, leitura.id); assert.ok(await leitura.reload()); assert.equal(await c.conexao.models.Usuario.count(), 5);
    });
  }
});
