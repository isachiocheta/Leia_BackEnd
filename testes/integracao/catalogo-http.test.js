'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcrypt');
const express = require('express');
const supertest = require('supertest');
const { Pool } = require('pg');
const { criarConexao } = require('../../database/conexao');
const { validarBancoTeste } = require('../../configuracao/banco');
const { validarDestinoTeste } = require('../../configuracao/operacoes-banco');
const { carregarConfiguracaoSessao } = require('../../configuracao/sessao');
const { criarAutenticacao } = require('../../autenticacao/rotas');
const { criarRotasGeneros, criarRotasLivros } = require('../../catalogo/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');
const { bloquearLivro } = require('../../database/bloqueio-livro');
const { anoAtual } = require('../../servicos/catalogo');

const destino = validarBancoTeste(process.env);
const configuracao = carregarConfiguracaoSessao({
  NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo das fixtures HTTP do catálogo Leia+', SESSION_COOKIE_SECURE: 'false',
});
const senha = 'Senha da fixture do catálogo';
const prefixo = `catalogo-http-${process.pid}-${Date.now()}`;

describe('Catálogo HTTP real com PostgreSQL e sessões', { timeout: 60_000 }, () => {
  let conexao;
  let hash;
  let sequencia = 0;
  const ids = Object.fromEntries(['Usuario', 'Genero', 'Livro', 'CicloLeitura', 'Encontro', 'ParticipacaoLeitura', 'InscricaoEncontro'].map((modelo) => [modelo, new Set()]));
  const sids = new Set();
  before(async () => {
    conexao = criarConexao();
    validarDestinoTeste(conexao);
    await conexao.authenticate();
    hash = await bcrypt.hash(senha, 4);
  });
  after(async () => {
    if (!conexao) return;
    try {
      validarDestinoTeste(conexao);
      await conexao.query('DELETE FROM sessoes WHERE sid = ANY($1::varchar[])', { bind: [[...sids]] });
      for (const modelo of ['InscricaoEncontro', 'ParticipacaoLeitura', 'Encontro', 'CicloLeitura', 'Livro', 'Genero', 'Usuario']) {
        validarDestinoTeste(conexao);
        if (ids[modelo].size) await conexao.models[modelo].destroy({ where: { id: [...ids[modelo]] } });
      }
    } finally { await conexao.close(); }
  });
  async function criar(modelo, dados, transaction) {
    const registro = await conexao.models[modelo].create(dados, { transaction });
    ids[modelo].add(registro.id);
    return registro;
  }
  function genero() { sequencia += 1; return criar('Genero', { nome: `${prefixo}-${sequencia}` }); }
  function livro(generoId, dados = {}) {
    return criar('Livro', { titulo: 'Obra da fixture', autor: 'Autora', generoId, totalPaginas: 100, ...dados });
  }
  function usuario(perfil = 'ADMIN_CLUBE') {
    sequencia += 1;
    return criar('Usuario', { nome: 'Pessoa do catálogo', email: `${prefixo}-${sequencia}@escola.example`, senhaHash: hash, perfil, situacao: 'ATIVO', sessionVersion: 0 });
  }
  function registrar(resposta) {
    for (const cookie of resposta.headers['set-cookie'] || []) {
      const valor = decodeURIComponent(cookie.split(';')[0].slice('leia.sid='.length));
      if (cookie.startsWith('leia.sid=') && valor.startsWith('s:')) sids.add(valor.slice(2, valor.lastIndexOf('.')));
    }
    assert.doesNotMatch(JSON.stringify(resposta.body), /senhaHash|senha_hash|"sql"|"stack"/);
    assert.ok(!JSON.stringify(resposta.body).includes(hash));
    return resposta;
  }
  async function token(agente) {
    const resposta = registrar(await agente.get('/api/auth/csrf'));
    assert.equal(resposta.status, 200);
    return resposta.body.data.csrfToken;
  }
  async function entrar(agente, conta = null) {
    const pessoa = conta || await usuario();
    const csrf = await token(agente);
    const resposta = registrar(await agente.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: pessoa.email, senha }));
    assert.equal(resposta.status, 200);
    return { conta: pessoa, csrf: await token(agente) };
  }
  async function post(agente, csrf, dados) {
    const resposta = registrar(await agente.post('/api/livros').set('X-CSRF-Token', csrf).send(dados));
    if (resposta.status === 201) ids.Livro.add(resposta.body.data.id);
    return resposta;
  }
  async function patch(agente, csrf, id, dados) {
    return registrar(await agente.patch(`/api/livros/${id}`).set('X-CSRF-Token', csrf).send(dados));
  }
  async function excluir(agente, csrf, id) {
    return registrar(await agente.delete(`/api/livros/${id}`).set('X-CSRF-Token', csrf));
  }
  async function emAplicacao(executar) {
    const pool = new Pool({ connectionString: destino.url, max: 3 });
    const autenticacao = criarAutenticacao({ configuracao, pool, obterUsuario: () => conexao.models.Usuario });
    const app = express();
    configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use('/api/generos', autenticacao.identificar, criarRotasGeneros({ obterConexao: () => conexao }));
    app.use('/api/livros', autenticacao.identificar, criarRotasLivros({ obterConexao: () => conexao }));
    app.use(rotaNaoEncontrada);
    app.use(tratarErros);
    try { await executar({ app, agente: supertest.agent(app) }); }
    finally { await autenticacao.encerrar(); await pool.end(); }
  }

  it('CRUD físico persiste, retorna contratos e não busca capa no servidor', async (contexto) => {
    const primeiroGenero = await genero();
    const segundoGenero = await genero();
    const buscar = contexto.mock.method(globalThis, 'fetch', () => { throw new Error('Não buscar capa.'); });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const criada = await post(agente, csrf, {
        titulo: '  Obra cadastrada  ', autor: 'Autora', generoId: primeiroGenero.id, totalPaginas: 123,
        anoPublicacao: anoAtual(), descricao: 'Descrição', capaUrl: 'https://127.0.0.1:1/capa.png',
      });
      assert.equal(criada.status, 201);
      const id = criada.body.data.id;
      assert.equal(criada.body.data.titulo, 'Obra cadastrada');
      assert.deepEqual(criada.body.data.genero, { id: primeiroGenero.id, nome: primeiroGenero.nome });
      assert.equal((await conexao.models.Livro.findByPk(id)).totalPaginas, 123);
      assert.equal(registrar(await agente.get(`/api/livros/${id}`)).status, 200);
      const editada = await patch(agente, csrf, id, { titulo: 'Título revisto', generoId: segundoGenero.id });
      assert.equal(editada.status, 200);
      assert.equal(editada.body.data.autor, 'Autora');
      assert.equal(editada.body.data.totalPaginas, 123);
      assert.equal(editada.body.data.descricao, 'Descrição');
      assert.equal(editada.body.data.genero.id, segundoGenero.id);
      const limpa = await patch(agente, csrf, id, { anoPublicacao: null, descricao: null, capaUrl: null });
      assert.equal(limpa.status, 200);
      for (const campo of ['anoPublicacao', 'descricao', 'capaUrl']) assert.equal(limpa.body.data[campo], null);
      assert.equal(limpa.body.data.titulo, 'Título revisto');
      const removida = await excluir(agente, csrf, id);
      assert.equal(removida.status, 204);
      assert.equal(removida.text, '');
      assert.equal(removida.headers['content-type'], undefined);
      assert.equal(removida.headers['content-length'], undefined);
      assert.equal(await conexao.models.Livro.findByPk(id), null);
      assert.equal(registrar(await agente.get(`/api/livros/${id}`)).status, 404);
      assert.equal(buscar.mock.callCount(), 0);
    });
  });

  it('consultas são para contas ativas; escrita é exclusiva do administrador com CSRF', async () => {
    const g = await genero();
    const obra = await livro(g.id);
    await emAplicacao(async ({ app, agente }) => {
      for (const caminho of ['/api/generos', '/api/livros', `/api/livros/${obra.id}`]) assert.equal(registrar(await agente.get(caminho)).status, 401);
      const leitor = await usuario('LEITOR');
      const { csrf } = await entrar(agente, leitor);
      for (const caminho of ['/api/generos?pageSize=50', '/api/livros', `/api/livros/${obra.id}`]) assert.equal(registrar(await agente.get(caminho)).status, 200);
      assert.equal((await post(agente, csrf, { titulo: 'Obra', autor: 'Autor', generoId: g.id, totalPaginas: 1 })).status, 403);
      assert.equal((await patch(agente, csrf, obra.id, { titulo: 'Outro' })).status, 403);
      assert.equal((await excluir(agente, csrf, obra.id)).status, 403);
      const administrador = supertest.agent(app);
      await entrar(administrador);
      assert.equal(registrar(await administrador.post('/api/livros').send({ titulo: 'Obra', autor: 'Autora', generoId: g.id, totalPaginas: 1 })).status, 403);
      assert.equal(registrar(await administrador.patch(`/api/livros/${obra.id}`).send({ titulo: 'Outro' })).status, 403);
      assert.equal(registrar(await administrador.delete(`/api/livros/${obra.id}`)).status, 403);
      await leitor.update({ situacao: 'INATIVO', sessionVersion: 1 });
      assert.equal(registrar(await agente.get('/api/livros')).status, 401);
      assert.equal((await obra.reload()).titulo, 'Obra da fixture');
    });
  });

  it('valida campos, referências, ano corrente e URL HTTPS sem aceitar atributos extras', async () => {
    const g = await genero();
    const obra = await livro(g.id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const dados = { titulo: 'Obra', autor: 'Autora', generoId: g.id, totalPaginas: 100 };
      for (const alteracao of [
        { titulo: '' }, { titulo: '  ' }, { titulo: 't'.repeat(161) }, { titulo: null },
        { autor: ' ' }, { autor: 'a'.repeat(121) }, { generoId: null }, { generoId: 2147483647 },
        { totalPaginas: 0 }, { totalPaginas: -1 }, { totalPaginas: 1.5 }, { totalPaginas: '100' },
        { anoPublicacao: 0 }, { anoPublicacao: anoAtual() + 1 }, { anoPublicacao: 2020.5 },
        { descricao: 'd'.repeat(2001) }, { descricao: 1 }, { capaUrl: 'http://escola.example/capa' },
        { capaUrl: 'data:image/png;base64,a' }, { capaUrl: 'javascript:alert(1)' },
        { capaUrl: 'https://usuario:senha@escola.example/capa' }, { capaUrl: '' }, { capaUrl: 123 },
        { id: 1 }, { criadoEm: '2026-01-01' },
      ]) assert.equal((await post(agente, csrf, { ...dados, ...alteracao })).status, 422);
      for (const campo of ['titulo', 'autor', 'generoId', 'totalPaginas']) {
        const incompleta = { ...dados };
        delete incompleta[campo];
        assert.equal((await post(agente, csrf, incompleta)).status, 422);
      }
      assert.equal((await patch(agente, csrf, obra.id, {})).status, 422);
      assert.equal((await patch(agente, csrf, obra.id, { generoId: 2147483647, titulo: 'Não gravar' })).status, 422);
      assert.equal((await obra.reload()).titulo, 'Obra da fixture');
      assert.equal((await patch(agente, csrf, 2147483647, { titulo: 'Ausente' })).status, 404);
      assert.equal((await excluir(agente, csrf, 2147483647)).status, 404);
      assert.equal(registrar(await agente.get('/api/livros/0')).status, 422);
      const limites = await post(agente, csrf, { ...dados, titulo: 't'.repeat(160), autor: 'a'.repeat(120), descricao: 'd'.repeat(2000), anoPublicacao: 1 });
      assert.equal(limites.status, 201);
    });
  });

  it('combina q por título/autor, gênero, ordenação e páginas; anos nulos sempre ficam no fim', async () => {
    const g = await genero();
    const outro = await genero();
    const alfa = await livro(g.id, { titulo: 'Alfa Marina', anoPublicacao: 2000 });
    const beta = await livro(g.id, { titulo: 'Beta', autor: 'MARINA', anoPublicacao: 2010 });
    const outraObra = await livro(g.id, { titulo: 'Outra obra', autor: 'Fulano', anoPublicacao: 1990 });
    const nulaA = await livro(g.id, { titulo: 'Marina Nula A' });
    const nulaB = await livro(g.id, { titulo: 'Marina Nula B' });
    const repetida = await livro(g.id, { titulo: 'Marina Repetida', anoPublicacao: 2000 });
    await livro(outro.id, { titulo: 'Marina de outro gênero', anoPublicacao: 2015 });
    await emAplicacao(async ({ agente }) => {
      await entrar(agente);
      const consulta = { q: '  mArInA  ', generoId: String(g.id), sort: 'anoPublicacao', pageSize: '2' };
      const primeira = registrar(await agente.get('/api/livros').query(consulta));
      assert.equal(primeira.status, 200);
      assert.deepEqual(primeira.body.meta, { page: 1, pageSize: 2, total: 5 });
      assert.deepEqual(primeira.body.data.map((linha) => linha.id), [alfa.id, repetida.id]);
      const segunda = registrar(await agente.get('/api/livros').query({ ...consulta, page: '2' }));
      assert.deepEqual(segunda.body.data.map((linha) => linha.id), [beta.id, nulaA.id]);
      const terceira = registrar(await agente.get('/api/livros').query({ ...consulta, page: '3' }));
      assert.deepEqual(terceira.body.data.map((linha) => linha.id), [nulaB.id]);
      const inversa = registrar(await agente.get('/api/livros').query({ ...consulta, direction: 'desc', pageSize: '50' }));
      assert.deepEqual(inversa.body.data.map((linha) => linha.id), [beta.id, repetida.id, alfa.id, nulaB.id, nulaA.id]);
      const porTitulo = registrar(await agente.get('/api/livros').query({ generoId: g.id }));
      assert.equal(porTitulo.body.meta.pageSize, 12);
      assert.deepEqual(porTitulo.body.data.map((linha) => linha.id), [alfa.id, beta.id, nulaA.id, nulaB.id, repetida.id, outraObra.id]);
      const literal = await livro(g.id, { titulo: '100%_ Histórias' });
      for (const q of ['%', '_']) {
        const resposta = registrar(await agente.get('/api/livros').query({ q, generoId: g.id }));
        assert.deepEqual(resposta.body.data.map((linha) => linha.id), [literal.id]);
      }
      const injecao = registrar(await agente.get('/api/livros').query({ q: "x' OR 1=1 --", generoId: g.id }));
      assert.equal(injecao.body.meta.total, 0);
      for (const invalida of [{ sort: 'id' }, { sort: 'titulo; SELECT 1' }, { direction: 'ASC' }, { pageSize: '51' }, { q: ['a', 'b'] }, { generoId: '0' }, { extra: 'a' }]) {
        assert.equal(registrar(await agente.get('/api/livros').query(invalida)).status, 422);
      }
    });
  });

  it('ciclos planejados e concluídos bloqueiam páginas e exclusão, preservando todo o histórico', async () => {
    const g = await genero();
    const obra = await livro(g.id);
    const leitor = await usuario('LEITOR');
    const ciclo = await criar('CicloLeitura', { nome: 'Planejado', livroId: obra.id, dataInicio: '2026-01-01', dataFim: '2026-01-31' });
    await criar('CicloLeitura', { nome: 'Concluído', livroId: obra.id, dataInicio: '2025-01-01', dataFim: '2025-01-31', situacao: 'CONCLUIDO' });
    const encontro = await criar('Encontro', { cicloId: ciclo.id, titulo: 'Conversa', inicioEm: '2026-01-20T15:00:00Z', local: 'Biblioteca' });
    const participacao = await criar('ParticipacaoLeitura', { usuarioId: leitor.id, cicloId: ciclo.id, paginaAtual: 20 });
    const inscricao = await criar('InscricaoEncontro', { usuarioId: leitor.id, encontroId: encontro.id });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const recusada = await patch(agente, csrf, obra.id, { totalPaginas: 200, titulo: 'Não gravar parcialmente' });
      assert.equal(recusada.status, 409);
      assert.equal(recusada.body.error.code, 'RESOURCE_IN_USE');
      assert.equal((await excluir(agente, csrf, obra.id)).status, 409);
      await obra.reload();
      assert.equal(obra.totalPaginas, 100);
      assert.equal(obra.titulo, 'Obra da fixture');
      const semMudancaDePaginas = await patch(agente, csrf, obra.id, { totalPaginas: 100, descricao: 'Descrição revista' });
      assert.equal(semMudancaDePaginas.status, 200);
      assert.equal((await participacao.reload()).paginaAtual, 20);
      assert.equal((await inscricao.reload()).encontroId, encontro.id);
      assert.equal((await encontro.reload()).cicloId, ciclo.id);
    });
  });

  it('aguarda criação concorrente de ciclo com o lock compartilhado e recusa alterar páginas depois', async (contexto) => {
    const g = await genero();
    const obra = await livro(g.id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const transaction = await conexao.transaction();
      let notificar;
      const solicitada = new Promise((resolver) => { notificar = resolver; });
      let prazo;
      try {
        await bloquearLivro(conexao, obra.id, transaction);
        await criar('CicloLeitura', { nome: 'Ciclo concorrente', livroId: obra.id, dataInicio: '2026-01-01', dataFim: '2026-01-31' }, transaction);
        const original = conexao.models.Livro.findByPk;
        contexto.mock.method(conexao.models.Livro, 'findByPk', async function (...argumentos) {
          if (argumentos[0] === obra.id && argumentos[1]?.lock) notificar();
          return original.apply(this, argumentos);
        });
        let finalizada = false;
        const alteracao = patch(agente, csrf, obra.id, { totalPaginas: 200 }).then((resposta) => { finalizada = true; return resposta; });
        await Promise.race([solicitada, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('A edição não solicitou o lock.')), 3000); })]);
        clearTimeout(prazo);
        await new Promise((resolver) => setImmediate(resolver));
        assert.equal(finalizada, false);
        await transaction.commit();
        assert.equal((await alteracao).status, 409);
        assert.equal((await obra.reload()).totalPaginas, 100);
      } finally {
        clearTimeout(prazo);
        if (!transaction.finished) { validarDestinoTeste(conexao); await transaction.rollback(); }
      }
    });
  });

  it('criação coordenada aguarda edição e valida o total atualizado antes de vincular o ciclo', async (contexto) => {
    const g = await genero();
    const obra = await livro(g.id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      let notificar;
      let liberar;
      const verificada = new Promise((resolver) => { notificar = resolver; });
      const liberada = new Promise((resolver) => { liberar = resolver; });
      const original = conexao.models.CicloLeitura.findOne;
      contexto.mock.method(conexao.models.CicloLeitura, 'findOne', async function (opcoes) {
        const resultado = await original.call(this, opcoes);
        if (opcoes.where.livroId === obra.id) { notificar(); await liberada; }
        return resultado;
      });
      const alteracao = patch(agente, csrf, obra.id, { totalPaginas: 300 });
      let prazo;
      try {
        await Promise.race([verificada, new Promise((_, rejeitar) => { prazo = setTimeout(() => rejeitar(new Error('A edição não verificou dependências.')), 3000); })]);
        clearTimeout(prazo);
        let paginasLidas;
        const criacao = conexao.transaction(async (transaction) => {
          const bloqueado = await bloquearLivro(conexao, obra.id, transaction);
          paginasLidas = bloqueado.totalPaginas;
          return criar('CicloLeitura', { nome: 'Depois da edição', livroId: obra.id, dataInicio: '2026-02-01', dataFim: '2026-02-28' }, transaction);
        });
        await new Promise((resolver) => setImmediate(resolver));
        assert.equal(paginasLidas, undefined);
        liberar();
        const [resposta] = await Promise.all([alteracao, criacao]);
        assert.equal(resposta.status, 200);
        assert.equal(paginasLidas, 300);
      } finally { clearTimeout(prazo); liberar(); }
    });
  });

  it('o app público monta gêneros e livros nos caminhos solicitados', async () => {
    const g = await genero();
    const conta = await usuario();
    const anteriores = Object.fromEntries(['SESSION_SECRET', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGIN'].map((chave) => [chave, process.env[chave]]));
    process.env.SESSION_SECRET = configuracao.segredo;
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
    try {
      const app = require('../../app');
      const agente = supertest.agent(app);
      const { csrf } = await entrar(agente, conta);
      const generos = registrar(await agente.get('/api/generos').query({ pageSize: 50 }));
      assert.equal(generos.status, 200);
      assert.ok(generos.body.data.some((linha) => linha.id === g.id));
      const criada = await post(agente, csrf, { titulo: 'Livro público', autor: 'Autora', generoId: g.id, totalPaginas: 10 });
      assert.equal(criada.status, 201);
      const id = criada.body.data.id;
      assert.equal(registrar(await agente.get('/api/livros')).status, 200);
      assert.equal(registrar(await agente.get(`/api/livros/${id}`)).status, 200);
      assert.equal((await patch(agente, csrf, id, { autor: 'Autora revisada' })).status, 200);
      assert.equal((await excluir(agente, csrf, id)).status, 204);
    } finally {
      await require('../../autenticacao/servico').encerrarAutenticacao();
      await require('../../database/conexao').encerrarConexao();
      for (const [chave, valor] of Object.entries(anteriores)) {
        if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor;
      }
    }
  });
});
