'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const bcrypt = require('bcrypt');
const { UniqueConstraintError } = require('sequelize');
const { carregarAdministrador } = require('../configuracao/administrador');
const { bootstrapAdministrativo } = require('../database/bootstrap-administrativo');
const banco = require('../database/conexao');

function ambiente(alteracoes = {}) {
  return {
    ADMIN_NOME: '  Administradora da escola  ',
    ADMIN_EMAIL: '  ADMIN@ESCOLA.EXEMPLO  ',
    ADMIN_SENHA: '  senha de teste sem transformação  ',
    ...alteracoes,
  };
}

function conexaoSimulada(existente = null) {
  const chamadas = { consultas: [], buscas: [], criacoes: [], transacoes: 0 };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const conexao = {
    models: {
      Usuario: {
        async findOne(opcoes) { chamadas.buscas.push(opcoes); return existente; },
        async create(atributos, opcoes) { chamadas.criacoes.push({ atributos, opcoes }); },
      },
    },
    async query(sql, opcoes) { chamadas.consultas.push({ sql, opcoes }); },
    async transaction(executar) { chamadas.transacoes += 1; return executar(transaction); },
  };
  return { conexao, chamadas, transaction };
}

test('normaliza a identidade administrativa e preserva a senha exatamente como recebida', () => {
  const variaveis = ambiente();
  const configuracao = carregarAdministrador(variaveis);
  assert.equal(configuracao.nome, 'Administradora da escola');
  assert.equal(configuracao.email, 'admin@escola.exemplo');
  assert.equal(configuracao.senha, variaveis.ADMIN_SENHA);
  assert.notEqual(configuracao.senha, variaveis.ADMIN_SENHA.trim());
});

test('exige nome, email e senha sem valores padrão', () => {
  for (const variavel of ['ADMIN_NOME', 'ADMIN_EMAIL', 'ADMIN_SENHA']) {
    for (const valor of [undefined, null, '']) {
      assert.throws(() => carregarAdministrador(ambiente({ [variavel]: valor })), new RegExp(variavel));
    }
  }
});

test('rejeita nome vazio ou longo e email inválido', () => {
  for (const nome of [' \t\n ', 'a'.repeat(101), 42]) {
    assert.throws(() => carregarAdministrador(ambiente({ ADMIN_NOME: nome })), /ADMIN_NOME/);
  }
  for (const email of [' \t ', 'sem-arroba', `${'a'.repeat(245)}@escola.exemplo`, 42]) {
    assert.throws(() => carregarAdministrador(ambiente({ ADMIN_EMAIL: email })), /ADMIN_EMAIL/);
  }
  assert.equal(carregarAdministrador(ambiente({ ADMIN_NOME: 'n'.repeat(100) })).nome.length, 100);
});

test('conta mínimo de dez caracteres Unicode e máximo de 72 bytes UTF-8', () => {
  for (const senha of ['a'.repeat(10), 'a'.repeat(72), 'é'.repeat(36), '🙂'.repeat(18), ' '.repeat(10)]) {
    assert.equal(carregarAdministrador(ambiente({ ADMIN_SENHA: senha })).senha, senha);
  }
  for (const senha of ['a'.repeat(9), 'a'.repeat(73), 'é'.repeat(37), '🙂'.repeat(19), '🙂'.repeat(9)]) {
    assert.throws(() => carregarAdministrador(ambiente({ ADMIN_SENHA: senha })), /ADMIN_SENHA/);
  }
});

test('erros de configuração não expõem dados de identidade ou senha', () => {
  const segredo = 'segredo_reservado_que_ultrapassa_o_limite_'.repeat(3);
  assert.throws(() => carregarAdministrador(ambiente({ ADMIN_SENHA: segredo })), (erro) => {
    assert.equal(erro.codigo, 'CONFIGURACAO_ADMINISTRADOR_INVALIDA');
    assert.doesNotMatch(erro.message, /segredo_reservado|admin@|Administradora/);
    return true;
  });
});

test('credenciais inválidas são recusadas antes de obter a conexão', async (t) => {
  const obter = t.mock.method(banco, 'obterConexao', () => {
    throw new Error('A configuração inválida tentou acessar o banco.');
  });
  await assert.rejects(bootstrapAdministrativo(ambiente({ ADMIN_SENHA: undefined })), /ADMIN_SENHA/);
  assert.equal(obter.mock.callCount(), 0);
});

test('cria ADMIN_CLUBE ativo com hash assíncrono, versão zero e sem retornar segredos', async (t) => {
  const hash = t.mock.method(bcrypt, 'hash', async () => '$2b$12$hash.criptografico.simulado');
  const { conexao, chamadas, transaction } = conexaoSimulada();
  const variaveis = ambiente();
  const resultado = await bootstrapAdministrativo(variaveis, conexao);

  assert.deepEqual(resultado, { criado: true });
  assert.equal(hash.mock.callCount(), 1);
  assert.deepEqual(hash.mock.calls[0].arguments, [variaveis.ADMIN_SENHA, 12]);
  assert.equal(chamadas.transacoes, 1);
  assert.equal(chamadas.criacoes.length, 1);
  assert.deepEqual(chamadas.criacoes[0], {
    atributos: {
      nome: 'Administradora da escola', email: 'admin@escola.exemplo',
      senhaHash: '$2b$12$hash.criptografico.simulado', perfil: 'ADMIN_CLUBE', situacao: 'ATIVO', sessionVersion: 0,
    },
    opcoes: { transaction },
  });
  assert.match(chamadas.consultas[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(chamadas.consultas[0].opcoes.bind, ['leia+:bootstrap-administrativo', 'admin@escola.exemplo']);
  assert.equal(chamadas.buscas[0].lock, 'UPDATE');
  assert.deepEqual(chamadas.buscas[0].attributes, ['id', 'nome', 'perfil', 'situacao']);
});

test('reexecução mantém senha e versão sem atualizar a conta', async (t) => {
  const hash = t.mock.method(bcrypt, 'hash', async () => { throw new Error('A reexecução tentou gerar outra senha.'); });
  const existente = {
    id: 1, nome: 'Administradora da escola', perfil: 'ADMIN_CLUBE', situacao: 'ATIVO',
    senhaHash: 'hash-anterior', sessionVersion: 7,
  };
  const original = { ...existente };
  const { conexao, chamadas } = conexaoSimulada(existente);
  const resultado = await bootstrapAdministrativo(ambiente({ ADMIN_SENHA: 'outra senha de teste válida' }), conexao);

  assert.deepEqual(resultado, { criado: false });
  assert.deepEqual(existente, original);
  assert.equal(chamadas.criacoes.length, 0);
  assert.equal(hash.mock.callCount(), 0);
});

test('recusa leitor, administrador não ativo e conflito de nome sem promoção ou redefinição', async (t) => {
  const hash = t.mock.method(bcrypt, 'hash', async () => { throw new Error('Um conflito tentou gerar uma senha.'); });
  for (const alteracoes of [
    { perfil: 'LEITOR' }, { situacao: 'PENDENTE' }, { situacao: 'INATIVO' }, { nome: 'Outra identidade' },
  ]) {
    const existente = { nome: 'Administradora da escola', perfil: 'ADMIN_CLUBE', situacao: 'ATIVO', ...alteracoes };
    const original = { ...existente };
    const { conexao, chamadas } = conexaoSimulada(existente);
    await assert.rejects(bootstrapAdministrativo(ambiente(), conexao), (erro) => {
      assert.equal(erro.codigo, 'CONFLITO_ADMINISTRADOR');
      assert.doesNotMatch(erro.message, /admin@|Outra identidade|senha/);
      return true;
    });
    assert.deepEqual(existente, original);
    assert.equal(chamadas.criacoes.length, 0);
  }
  assert.equal(hash.mock.callCount(), 0);
});

test('colisão de email com escritor externo é recusada, sem tentar promover a conta', async (t) => {
  t.mock.method(bcrypt, 'hash', async () => '$2b$12$hash.criptografico.simulado');
  const { conexao, chamadas } = conexaoSimulada();
  t.mock.method(conexao.models.Usuario, 'create', async () => { throw new UniqueConstraintError({ errors: [] }); });

  await assert.rejects(bootstrapAdministrativo(ambiente(), conexao), (erro) => erro.codigo === 'CONFLITO_ADMINISTRADOR');
  assert.equal(chamadas.buscas.length, 1);
  assert.equal(chamadas.transacoes, 1);
});
