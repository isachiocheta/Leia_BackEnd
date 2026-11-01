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
const { criarRotasCiclos } = require('../../ciclos/rotas');
const { configurarHttp } = require('../../intermediarios/http');
const { rotaNaoEncontrada, tratarErros } = require('../../intermediarios/erros');
const { reservarCiclosAtivos } = require('../apoio/coordenacao-ciclos');
const { dataEmSaoPaulo } = require('../../utilitarios/datas-civis');

const destino = validarBancoTeste(process.env);
const configuracao = carregarConfiguracaoSessao({ NODE_ENV: 'test', SESSION_SECRET: 'Segredo exclusivo das fixtures de ciclos HTTP Leia+', SESSION_COOKIE_SECURE: 'false' });
const senha = 'Senha das fixtures dos ciclos';
const prefixo = `ciclos-http-${process.pid}-${Date.now()}`;

describe('Ciclos HTTP com PostgreSQL e sessões reais', { timeout: 60_000 }, () => {
  let conexao;
  let hash;
  let liberarCiclos;
  let sequencia = 0;
  const ids = Object.fromEntries(['Usuario', 'Genero', 'Livro', 'CicloLeitura', 'Encontro', 'ParticipacaoLeitura', 'InscricaoEncontro'].map((modelo) => [modelo, new Set()]));
  const sids = new Set();
  before(async () => {
    liberarCiclos = await reservarCiclosAtivos();
    conexao = criarConexao();
    validarDestinoTeste(conexao);
    await conexao.authenticate();
    hash = await bcrypt.hash(senha, 4);
  });
  after(async () => {
    try {
      if (conexao) {
        try {
          validarDestinoTeste(conexao);
          await conexao.query('DELETE FROM sessoes WHERE sid = ANY($1::varchar[])', { bind: [[...sids]] });
          for (const modelo of ['InscricaoEncontro', 'ParticipacaoLeitura', 'Encontro', 'CicloLeitura', 'Livro', 'Genero', 'Usuario']) {
            validarDestinoTeste(conexao);
            if (ids[modelo].size) await conexao.models[modelo].destroy({ where: { id: [...ids[modelo]] } });
          }
        } finally { await conexao.close(); }
      }
    } finally { if (liberarCiclos) await liberarCiclos(); }
  });
  async function criar(modelo, dados) {
    const registro = await conexao.models[modelo].create(dados);
    ids[modelo].add(registro.id);
    return registro;
  }
  async function livro() {
    sequencia += 1;
    const genero = await criar('Genero', { nome: `${prefixo}-${sequencia}` });
    return criar('Livro', { titulo: 'Obra do ciclo', autor: 'Autora', generoId: genero.id, totalPaginas: 100 });
  }
  function usuario(perfil = 'ADMIN_CLUBE') {
    sequencia += 1;
    return criar('Usuario', { nome: 'Pessoa dos ciclos', email: `${prefixo}-${sequencia}@escola.example`, senhaHash: hash, perfil, situacao: 'ATIVO', sessionVersion: 0 });
  }
  function registrar(resposta) {
    for (const cookie of resposta.headers['set-cookie'] || []) {
      const valor = decodeURIComponent(cookie.split(';')[0].slice('leia.sid='.length));
      if (cookie.startsWith('leia.sid=') && valor.startsWith('s:')) sids.add(valor.slice(2, valor.lastIndexOf('.')));
    }
    assert.doesNotMatch(JSON.stringify(resposta.body), /senhaHash|senha_hash|"sql"|"stack"/);
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
    assert.equal(registrar(await agente.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: pessoa.email, senha })).status, 200);
    return { conta: pessoa, csrf: await token(agente) };
  }
  async function post(agente, csrf, dados) {
    const resposta = registrar(await agente.post('/api/ciclos').set('X-CSRF-Token', csrf).send(dados));
    if (resposta.status === 201) ids.CicloLeitura.add(resposta.body.data.id);
    return resposta;
  }
  async function patch(agente, csrf, id, dados) {
    return registrar(await agente.patch(`/api/ciclos/${id}`).set('X-CSRF-Token', csrf).send(dados));
  }
  async function excluir(agente, csrf, id) { return registrar(await agente.delete(`/api/ciclos/${id}`).set('X-CSRF-Token', csrf)); }
  function dados(livroId, extras = {}) { return { nome: 'Ciclo de leitura', livroId, dataInicio: '2026-11-01', dataFim: '2026-11-03', ...extras }; }
  async function ciclo(livroId, extras = {}) { return criar('CicloLeitura', dados(livroId, extras)); }
  function encontro(cicloId, extras = {}) { return criar('Encontro', { cicloId, titulo: 'Conversa', local: 'Biblioteca', inicioEm: '2026-11-01T15:00:00Z', ...extras }); }
  async function emAplicacao(executar, { agora = () => Date.parse('2026-11-01T15:00:00Z') } = {}) {
    const pool = new Pool({ connectionString: destino.url, max: 3 });
    const autenticacao = criarAutenticacao({ configuracao, pool, obterUsuario: () => conexao.models.Usuario });
    const app = express();
    configurarHttp(app, { origemPermitida: 'http://localhost:5173' });
    app.use('/api/auth', autenticacao.roteador);
    app.use('/api/ciclos', autenticacao.identificar, criarRotasCiclos({ obterConexao: () => conexao, agora }));
    app.use(rotaNaoEncontrada);
    app.use(tratarErros);
    try { await executar({ app, agente: supertest.agent(app) }); }
    finally { await autenticacao.encerrar(); await pool.end(); }
  }

  it('CRUD físico começa PLANEJADO, conserva DATEONLY e campos ausentes, sem situação automática', async () => {
    const primeira = await livro();
    const segunda = await livro();
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const criada = await post(agente, csrf, dados(primeira.id, { dataInicio: '2024-02-29', dataFim: '2024-03-01', orientacoes: 'Leia com calma.' }));
      assert.equal(criada.status, 201);
      const id = criada.body.data.id;
      assert.equal(criada.body.data.situacao, 'PLANEJADO');
      assert.equal(criada.body.data.dataInicio, '2024-02-29');
      assert.equal(criada.body.data.livro.id, primeira.id);
      assert.equal(registrar(await agente.get(`/api/ciclos/${id}`)).status, 200);
      const editada = await patch(agente, csrf, id, { nome: 'Nome revisto', livroId: segunda.id });
      assert.equal(editada.status, 200);
      assert.equal(editada.body.data.dataFim, '2024-03-01');
      assert.equal(editada.body.data.orientacoes, 'Leia com calma.');
      assert.equal(editada.body.data.situacao, 'PLANEJADO');
      assert.equal(editada.body.data.livroId, segunda.id);
      assert.equal((await patch(agente, csrf, id, { orientacoes: null })).body.data.orientacoes, null);
      const removida = await excluir(agente, csrf, id);
      assert.equal(removida.status, 204);
      assert.equal(removida.text, '');
      assert.equal(removida.headers['content-type'], undefined);
      assert.equal(await conexao.models.CicloLeitura.findByPk(id), null);
      assert.equal(registrar(await agente.get(`/api/ciclos/${id}`)).status, 404);
    });
  });

  it('ambos os perfis ativos consultam; administrador precisa de CSRF para escrever', async () => {
    const obra = await livro();
    const existente = await ciclo(obra.id);
    await emAplicacao(async ({ app, agente }) => {
      assert.equal(registrar(await agente.get('/api/ciclos')).status, 401);
      assert.equal(registrar(await agente.get(`/api/ciclos/${existente.id}`)).status, 401);
      const leitor = await usuario('LEITOR');
      const { csrf } = await entrar(agente, leitor);
      assert.equal(registrar(await agente.get('/api/ciclos')).status, 200);
      assert.equal(registrar(await agente.get(`/api/ciclos/${existente.id}`)).status, 200);
      assert.equal((await post(agente, csrf, dados(obra.id))).status, 403);
      assert.equal((await patch(agente, csrf, existente.id, { nome: 'Outro' })).status, 403);
      assert.equal((await excluir(agente, csrf, existente.id)).status, 403);
      const administrador = supertest.agent(app);
      await entrar(administrador);
      assert.equal(registrar(await administrador.post('/api/ciclos').send(dados(obra.id))).status, 403);
      assert.equal(registrar(await administrador.patch(`/api/ciclos/${existente.id}`).send({ nome: 'Outro' })).status, 403);
      assert.equal(registrar(await administrador.delete(`/api/ciclos/${existente.id}`)).status, 403);
      await leitor.update({ situacao: 'INATIVO', sessionVersion: 1 });
      assert.equal(registrar(await agente.get('/api/ciclos')).status, 401);
    });
  });

  it('valida referências, datas reais e intervalo mesclado de PATCH, rejeitando extras e status na criação', async () => {
    const obra = await livro();
    const existente = await ciclo(obra.id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      for (const alteracao of [
        { nome: '  ' }, { nome: 'n'.repeat(121) }, { livroId: 2147483647 }, { livroId: null },
        { dataInicio: '2025-02-29' }, { dataFim: '2026-04-31' }, { dataInicio: '2026-11-04' },
        { dataInicio: '2026-11-01T00:00:00Z' }, { orientacoes: 'x'.repeat(2001) },
        { situacao: 'PLANEJADO' }, { id: 1 },
      ]) assert.equal((await post(agente, csrf, dados(obra.id, alteracao))).status, 422);
      for (const campo of ['nome', 'livroId', 'dataInicio', 'dataFim']) {
        const incompleta = dados(obra.id); delete incompleta[campo];
        assert.equal((await post(agente, csrf, incompleta)).status, 422);
      }
      for (const alteracao of [{}, { dataFim: '2026-10-31' }, { dataInicio: null }, { situacao: 'INVALIDA' }, { livroId: 2147483647 }]) {
        assert.equal((await patch(agente, csrf, existente.id, alteracao)).status, 422);
      }
      assert.equal((await patch(agente, csrf, 2147483647, { nome: 'Ausente' })).status, 404);
      assert.equal((await excluir(agente, csrf, 2147483647)).status, 404);
      assert.equal(registrar(await agente.get('/api/ciclos/0')).status, 422);
      assert.equal((await existente.reload()).dataFim, '2026-11-03');
    });
  });

  it('transições são manuais e sequenciais; concluir não modifica encontros agendados', async () => {
    const obra = await livro();
    const existente = await ciclo(obra.id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'CONCLUIDO' })).status, 409);
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'EM_ANDAMENTO' })).status, 200);
      const agendado = await encontro(existente.id);
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'CONCLUIDO' })).status, 409);
      assert.equal((await agendado.reload()).situacao, 'AGENDADO');
      await agendado.update({ situacao: 'REALIZADO' });
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'CONCLUIDO' })).status, 200);
      assert.equal((await agendado.reload()).situacao, 'REALIZADO');
      for (const situacao of ['PLANEJADO', 'EM_ANDAMENTO']) assert.equal((await patch(agente, csrf, existente.id, { situacao })).status, 409);
      assert.equal((await patch(agente, csrf, existente.id, { situacao: 'CONCLUIDO', nome: 'Concluído manualmente' })).status, 200);
    });
  });

  it('iniciar considera início e fim integrais pelo dia de São Paulo, sem meia-noite UTC', async () => {
    const obra = await livro();
    let agora = Date.parse('2026-11-01T02:59:59.999Z');
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const ultimoInstante = await ciclo(obra.id, { dataInicio: '2026-10-31', dataFim: '2026-10-31' });
      assert.equal((await patch(agente, csrf, ultimoInstante.id, { situacao: 'EM_ANDAMENTO' })).status, 200);
      assert.equal((await patch(agente, csrf, ultimoInstante.id, { situacao: 'CONCLUIDO' })).status, 200);
      const fora = await ciclo(obra.id, { dataInicio: '2026-10-31', dataFim: '2026-10-31' });
      agora = Date.parse('2026-11-01T03:00:00Z');
      assert.equal((await patch(agente, csrf, fora.id, { situacao: 'EM_ANDAMENTO' })).status, 409);
      agora = Date.parse('2026-10-31T02:59:59.999Z');
      assert.equal((await patch(agente, csrf, fora.id, { situacao: 'EM_ANDAMENTO' })).status, 409);
      agora = Date.parse('2026-10-31T03:00:00Z');
      assert.equal((await patch(agente, csrf, fora.id, { situacao: 'EM_ANDAMENTO' })).status, 200);
      assert.equal((await patch(agente, csrf, fora.id, { situacao: 'CONCLUIDO' })).status, 200);
    }, { agora: () => agora });
  });

  it('duas ativações simultâneas passam a pré-consulta e o índice parcial aceita somente uma', async (contexto) => {
    const primeiro = await ciclo((await livro()).id);
    const segundo = await ciclo((await livro()).id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const original = conexao.models.CicloLeitura.findOne;
      let liberar;
      let consultas = 0;
      const barreira = new Promise((resolver) => { liberar = resolver; });
      contexto.mock.method(conexao.models.CicloLeitura, 'findOne', async function (opcoes) {
        const resultado = await original.call(this, opcoes);
        if (opcoes.where?.situacao === 'EM_ANDAMENTO') {
          assert.equal(resultado, null);
          consultas += 1;
          if (consultas === 2) liberar();
          await barreira;
        }
        return resultado;
      });
      const respostas = await Promise.all([primeiro, segundo].map((registro) => patch(agente, csrf, registro.id, { situacao: 'EM_ANDAMENTO' })));
      assert.equal(consultas, 2);
      assert.deepEqual(respostas.map((resposta) => resposta.status).sort(), [200, 409]);
      const vencedor = respostas.find((resposta) => resposta.status === 200).body.data.id;
      const ativos = await conexao.models.CicloLeitura.findAll({ where: { situacao: 'EM_ANDAMENTO' }, attributes: ['id'] });
      assert.deepEqual(ativos.map((registro) => registro.id), [vencedor]);
      assert.equal((await patch(agente, csrf, vencedor, { situacao: 'CONCLUIDO' })).status, 200);
    });
  });

  it('participações e encontros, mesmo cancelados, impedem troca de livro e exclusão física', async () => {
    const obra = await livro();
    const novaObra = await livro();
    const leitor = await usuario('LEITOR');
    const participando = await ciclo(obra.id);
    const comEncontro = await ciclo(obra.id);
    const participacao = await criar('ParticipacaoLeitura', { usuarioId: leitor.id, cicloId: participando.id, paginaAtual: 20 });
    const cancelado = await encontro(comEncontro.id, { situacao: 'CANCELADO' });
    const inscricao = await criar('InscricaoEncontro', { usuarioId: leitor.id, encontroId: cancelado.id });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      for (const registro of [participando, comEncontro]) {
        assert.equal((await patch(agente, csrf, registro.id, { livroId: novaObra.id, nome: 'Não gravar' })).status, 409);
        assert.equal((await excluir(agente, csrf, registro.id)).status, 409);
        assert.equal((await registro.reload()).livroId, obra.id);
        assert.equal(registro.nome, 'Ciclo de leitura');
      }
      assert.equal((await patch(agente, csrf, participando.id, { livroId: obra.id, orientacoes: 'Revisadas' })).status, 200);
      assert.equal((await participacao.reload()).paginaAtual, 20);
      assert.equal((await inscricao.reload()).encontroId, cancelado.id);
      assert.equal((await cancelado.reload()).situacao, 'CANCELADO');
    });
  });

  it('edição do período considera todos os encontros pelo dia local e preserva o dia final completo', async () => {
    const existente = await ciclo((await livro()).id, { dataInicio: '2026-10-31' });
    const inicio = await encontro(existente.id, { inicioEm: '2026-11-01T03:00:00.000Z', situacao: 'REALIZADO' });
    const final = await encontro(existente.id, { inicioEm: '2026-11-03T02:59:59.999Z', situacao: 'CANCELADO' });
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const ajustada = await patch(agente, csrf, existente.id, { dataInicio: '2026-11-01', dataFim: '2026-11-02' });
      assert.equal(ajustada.status, 200);
      assert.equal(ajustada.body.data.dataFim, '2026-11-02');
      assert.equal((await patch(agente, csrf, existente.id, { dataInicio: '2026-11-02', nome: 'Não gravar' })).status, 409);
      assert.equal((await patch(agente, csrf, existente.id, { dataFim: '2026-11-01' })).status, 409);
      assert.equal((await patch(agente, csrf, existente.id, { dataFim: '2026-11-03' })).status, 200);
      const agendado = await encontro(existente.id, { inicioEm: '2026-11-04T02:59:59.999Z' });
      assert.equal((await patch(agente, csrf, existente.id, { dataFim: '2026-11-02' })).status, 409);
      assert.equal((await existente.reload()).nome, 'Ciclo de leitura');
      for (const [registro, situacao] of [[inicio, 'REALIZADO'], [final, 'CANCELADO'], [agendado, 'AGENDADO']]) assert.equal((await registro.reload()).situacao, situacao);
    });
  });

  it('trocas simultâneas entre dois livros seguem a mesma ordem crescente de locks', async (contexto) => {
    const primeira = await livro();
    const segunda = await livro();
    const a = await ciclo(primeira.id);
    const b = await ciclo(segunda.id);
    await emAplicacao(async ({ agente }) => {
      const { csrf } = await entrar(agente);
      const original = conexao.models.Livro.findByPk;
      const ordens = new Map();
      contexto.mock.method(conexao.models.Livro, 'findByPk', async function (id, opcoes) {
        if (opcoes.lock) {
          const ordem = ordens.get(opcoes.transaction.id) || [];
          ordem.push(id); ordens.set(opcoes.transaction.id, ordem);
        }
        return original.call(this, id, opcoes);
      });
      const respostas = await Promise.all([patch(agente, csrf, a.id, { livroId: segunda.id }), patch(agente, csrf, b.id, { livroId: primeira.id })]);
      assert.ok(respostas.every((resposta) => resposta.status === 200));
      assert.equal(ordens.size, 2);
      for (const ordem of ordens.values()) assert.deepEqual(ordem, [primeira.id, segunda.id].sort((x, y) => x - y));
      assert.equal((await a.reload()).livroId, segunda.id);
      assert.equal((await b.reload()).livroId, primeira.id);
    });
  });

  it('combina busca por nome, situação, paginação e ordenação estável', async () => {
    const obra = await livro();
    const termo = `${prefixo}-busca`;
    const a = await ciclo(obra.id, { nome: `${termo} B`, dataInicio: '2026-11-02' });
    const b = await ciclo(obra.id, { nome: `${termo} A`, dataInicio: '2026-11-01' });
    const c = await ciclo(obra.id, { nome: `${termo} A`, dataInicio: '2026-11-01' });
    await ciclo(obra.id, { nome: `${termo} C`, situacao: 'CONCLUIDO' });
    await emAplicacao(async ({ agente }) => {
      await entrar(agente);
      const consulta = { q: `  ${termo.toUpperCase()}  `, situacao: 'PLANEJADO', sort: 'nome', pageSize: 2 };
      const primeira = registrar(await agente.get('/api/ciclos').query(consulta));
      assert.equal(primeira.status, 200);
      assert.deepEqual(primeira.body.meta, { page: 1, pageSize: 2, total: 3 });
      assert.deepEqual(primeira.body.data.map((registro) => registro.id), [b.id, c.id]);
      const segunda = registrar(await agente.get('/api/ciclos').query({ ...consulta, page: 2 }));
      assert.deepEqual(segunda.body.data.map((registro) => registro.id), [a.id]);
      const datas = registrar(await agente.get('/api/ciclos').query({ q: termo, situacao: 'PLANEJADO', sort: 'dataInicio', direction: 'desc' }));
      assert.deepEqual(datas.body.data.map((registro) => registro.id), [a.id, c.id, b.id]);
      for (const consultaInvalida of [{ situacao: 'INVALIDA' }, { sort: 'id' }, { direction: 'ASC' }, { pageSize: 51 }, { extra: 1 }]) assert.equal(registrar(await agente.get('/api/ciclos').query(consultaInvalida)).status, 422);
    });
  });

  it('o app público monta coleção, detalhe, criação, edição e exclusão de ciclos', async () => {
    const obra = await livro();
    const pessoa = await usuario();
    const anteriores = Object.fromEntries(['SESSION_SECRET', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGIN'].map((chave) => [chave, process.env[chave]]));
    process.env.SESSION_SECRET = configuracao.segredo;
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
    try {
      const agente = supertest.agent(require('../../app'));
      const { csrf } = await entrar(agente, pessoa);
      const hoje = dataEmSaoPaulo();
      const criada = await post(agente, csrf, dados(obra.id, { dataInicio: hoje, dataFim: hoje }));
      assert.equal(criada.status, 201);
      const id = criada.body.data.id;
      assert.equal(registrar(await agente.get('/api/ciclos')).status, 200);
      assert.equal(registrar(await agente.get(`/api/ciclos/${id}`)).status, 200);
      assert.equal((await patch(agente, csrf, id, { nome: 'Nome público' })).status, 200);
      assert.equal((await excluir(agente, csrf, id)).status, 204);
    } finally {
      await require('../../autenticacao/servico').encerrarAutenticacao();
      await require('../../database/conexao').encerrarConexao();
      for (const [chave, valor] of Object.entries(anteriores)) { if (valor === undefined) delete process.env[chave]; else process.env[chave] = valor; }
    }
  });
});
