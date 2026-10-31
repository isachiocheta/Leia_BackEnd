'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const bcrypt = require('bcrypt');
const { UniqueConstraintError } = require('sequelize');
const { cadastrarLeitor, listarLeitores, alterarSituacaoLeitor } = require('../servicos/usuarios');
const { senhaValida } = require('../utilitarios/senha');

function modelSimulado(situacao = 'PENDENTE', sessionVersion = 0) {
  const chamadas = { buscas: [], alteracoes: [], transacoes: 0 };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const usuario = {
    id: 7, nome: 'Leitora', email: 'leitora@escola.example', perfil: 'LEITOR', situacao, sessionVersion,
    senhaHash: 'dado-que-nunca-deve-sair',
    async update(dados, opcoes) { chamadas.alteracoes.push({ dados, opcoes }); Object.assign(this, dados); },
  };
  const Usuario = {
    sequelize: { async transaction(executar) { chamadas.transacoes += 1; return executar(transaction); } },
    async findOne(opcoes) { chamadas.buscas.push(opcoes); return usuario; },
  };
  return { Usuario, usuario, chamadas, transaction };
}

test('cadastro define privilégios no serviço e retorna somente identidade pública', async (t) => {
  const hash = t.mock.method(bcrypt, 'hash', async () => 'hash-assincrono-da-fixture');
  let atributos;
  const entrada = {
    nome: 'Leitora', email: 'leitora@escola.example', senha: ' senha sem trim ',
    perfil: 'ADMIN_CLUBE', situacao: 'ATIVO', sessionVersion: 12,
  };
  const resultado = await cadastrarLeitor(entrada, {
    async create(dados) { atributos = dados; return { id: 7, ...dados }; },
  });
  assert.deepEqual(hash.mock.calls[0].arguments, [entrada.senha, 12]);
  assert.equal(atributos.perfil, 'LEITOR');
  assert.equal(atributos.situacao, 'PENDENTE');
  assert.equal(atributos.sessionVersion, 0);
  assert.equal(atributos.senhaHash, 'hash-assincrono-da-fixture');
  assert.deepEqual(resultado, { id: 7, nome: entrada.nome, email: entrada.email, perfil: 'LEITOR', situacao: 'PENDENTE' });
});

test('colisão de unicidade no cadastro é traduzida para 409 sem atualizar conta existente', async (t) => {
  t.mock.method(bcrypt, 'hash', async () => 'hash-fixture');
  await assert.rejects(cadastrarLeitor({ senha: 'senha-fixture-valida' }, {
    async create() { throw new UniqueConstraintError({ errors: [] }); },
  }), (erro) => erro.status === 409 && erro.codigo === 'DUPLICATE_RESOURCE');
});

test('a política compartilhada conta Unicode e bytes, preservando espaços', () => {
  for (const senha of ['a'.repeat(10), 'a'.repeat(72), 'é'.repeat(36), '🙂'.repeat(10), ' '.repeat(10)]) {
    assert.equal(senhaValida(senha), true);
  }
  for (const senha of [undefined, null, 123, 'a'.repeat(9), 'a'.repeat(73), 'é'.repeat(37), '🙂'.repeat(9)]) {
    assert.equal(senhaValida(senha), false);
  }
});

test('transições permitidas bloqueiam a linha e alteram situação e versão na mesma transação', async () => {
  for (const [origem, destino] of [
    ['PENDENTE', 'ATIVO'], ['PENDENTE', 'INATIVO'], ['ATIVO', 'INATIVO'], ['INATIVO', 'ATIVO'],
  ]) {
    const { Usuario, chamadas, transaction } = modelSimulado(origem, 0);
    const resultado = await alterarSituacaoLeitor(7, destino, Usuario);
    assert.equal(chamadas.transacoes, 1);
    assert.deepEqual(chamadas.buscas[0].where, { id: 7, perfil: 'LEITOR' });
    assert.equal(chamadas.buscas[0].lock, transaction.LOCK.UPDATE);
    assert.equal(chamadas.buscas[0].transaction, transaction);
    assert.ok(!chamadas.buscas[0].attributes.includes('senhaHash'));
    assert.deepEqual(chamadas.alteracoes, [{
      dados: { situacao: destino, sessionVersion: 1 },
      opcoes: { fields: ['situacao', 'sessionVersion'], transaction },
    }]);
    assert.equal(resultado.situacao, destino);
    assert.equal(resultado.perfil, 'LEITOR');
    assert.equal(resultado.senhaHash, undefined);
    assert.equal(resultado.sessionVersion, undefined);
  }
});

test('repetir situação é idempotente; não retorna uma conta aprovada à fila pendente', async () => {
  for (const situacao of ['PENDENTE', 'ATIVO', 'INATIVO']) {
    const { Usuario, chamadas } = modelSimulado(situacao, 9);
    await alterarSituacaoLeitor(7, situacao, Usuario);
    assert.equal(chamadas.alteracoes.length, 0);
  }
  for (const situacao of ['ATIVO', 'INATIVO']) {
    const { Usuario, chamadas } = modelSimulado(situacao, 9);
    await assert.rejects(alterarSituacaoLeitor(7, 'PENDENTE', Usuario), (erro) => erro.status === 409);
    assert.equal(chamadas.alteracoes.length, 0);
  }
});

test('alvo fora do conjunto LEITOR retorna 404; situação inválida não inicia transação', async () => {
  const { Usuario, chamadas } = modelSimulado();
  Usuario.findOne = async () => null;
  await assert.rejects(alterarSituacaoLeitor(7, 'ATIVO', Usuario), (erro) => erro.status === 404);
  const total = chamadas.transacoes;
  await assert.rejects(alterarSituacaoLeitor(7, 'INVALIDA', Usuario), (erro) => erro.status === 422);
  assert.equal(chamadas.transacoes, total);
});

test('listagem fixa perfil LEITOR e pagina com ordenação de mapa interno e desempate', async () => {
  let consulta;
  const resultado = await listarLeitores({ situacao: 'PENDENTE', page: '2', sort: 'nome', direction: 'desc' }, {
    async findAndCountAll(opcoes) {
      consulta = opcoes;
      return { count: 13, rows: [{ id: 7, nome: 'Leitora', perfil: 'LEITOR', situacao: 'PENDENTE', senhaHash: 'nao-sair' }] };
    },
  });
  assert.deepEqual(consulta.where, { perfil: 'LEITOR', situacao: 'PENDENTE' });
  assert.equal(consulta.limit, 12);
  assert.equal(consulta.offset, 12);
  assert.deepEqual(consulta.order, [['nome', 'DESC'], ['id', 'DESC']]);
  assert.ok(!consulta.attributes.includes('senhaHash'));
  assert.deepEqual(resultado.meta, { page: 2, pageSize: 12, total: 13 });
  assert.equal(resultado.data[0].senhaHash, undefined);
  await assert.rejects(listarLeitores({ perfil: 'ADMIN_CLUBE' }, {}), (erro) => erro.status === 422);
});
