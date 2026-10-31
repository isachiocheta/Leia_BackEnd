'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const bcrypt = require('bcrypt');
const { criarPassaporte } = require('../autenticacao/passaporte');

const usuarioAtivo = {
  id: 1, nome: 'Leitora', email: 'leitora@escola.exemplo', perfil: 'LEITOR',
  situacao: 'ATIVO', sessionVersion: 0, senhaHash: 'hash-privado',
};

function criarCenario({ usuario = usuarioAtivo, compararSenha = async () => true, erroBanco } = {}) {
  const chamadas = { scopes: [], buscas: [], atuais: [], comparacoes: [] };
  const Usuario = {
    scope(escopo) { chamadas.scopes.push(escopo); return this; },
    async findOne(opcoes) {
      chamadas.buscas.push(opcoes);
      if (erroBanco) throw erroBanco;
      return usuario;
    },
    async findByPk(id, opcoes) {
      chamadas.atuais.push({ id, opcoes });
      if (erroBanco) throw erroBanco;
      return usuario;
    },
  };
  const passaporte = criarPassaporte({
    obterUsuario: () => Usuario,
    async compararSenha(senha, hash) {
      chamadas.comparacoes.push({ senha, hash });
      return compararSenha(senha, hash);
    },
  });
  return { passaporte, chamadas };
}

function autenticar(passaporte, body = { email: usuarioAtivo.email, senha: '  senha preservada  ' }, query = {}) {
  return new Promise((resolve, reject) => {
    passaporte.authenticate('local', { session: false }, (erro, usuario) => {
      if (erro) reject(erro);
      else resolve(usuario);
    })({ body, query }, {}, reject);
  });
}

function serializar(passaporte, usuario) {
  return new Promise((resolve, reject) => passaporte.serializeUser(usuario, (erro, sessao) => {
    if (erro) reject(erro);
    else resolve(sessao);
  }));
}

function desserializar(passaporte, sessao) {
  return new Promise((resolve, reject) => passaporte.deserializeUser(sessao, (erro, usuario) => {
    if (erro) reject(erro);
    else resolve(usuario);
  }));
}

test('Passport Local normaliza somente o email, consulta credenciais e não retorna hash', async () => {
  const { passaporte, chamadas } = criarCenario();
  const senha = '  senha preservada  ';
  const usuario = await autenticar(passaporte, { email: '  LEITORA@ESCOLA.EXEMPLO  ', senha });
  assert.deepEqual(chamadas.scopes, ['credenciais']);
  assert.deepEqual(chamadas.buscas, [{ where: { email: usuarioAtivo.email } }]);
  assert.deepEqual(chamadas.comparacoes, [{ senha, hash: usuarioAtivo.senhaHash }]);
  const { senhaHash, ...esperado } = usuarioAtivo;
  assert.deepEqual(usuario, esperado);
  assert.equal(Object.hasOwn(usuario, 'senhaHash'), false);
});

test('senha incorreta, conta inexistente e contas indisponíveis têm a mesma recusa', async () => {
  const cenarios = [
    { compararSenha: async () => false },
    { usuario: null },
    { usuario: { ...usuarioAtivo, situacao: 'PENDENTE' } },
    { usuario: { ...usuarioAtivo, situacao: 'INATIVO' } },
    { usuario: { ...usuarioAtivo, perfil: 'SUPERADMIN' } },
    { usuario: { ...usuarioAtivo, sessionVersion: undefined } },
  ];
  for (const cenario of cenarios) {
    const { passaporte, chamadas } = criarCenario(cenario);
    assert.equal(await autenticar(passaporte), false);
    assert.equal(chamadas.comparacoes.length, 1);
    if (cenario.usuario === null) assert.match(chamadas.comparacoes[0].hash, /^\$2b\$12\$/);
  }
});

test('credenciais fora do corpo e tipos ou tamanhos inválidos não consultam o banco', async () => {
  const casos = [
    {}, { email: '', senha: 'senha' }, { email: 123, senha: 'senha' },
    { email: usuarioAtivo.email, senha: { reservada: 'senha' } },
    { email: usuarioAtivo.email, senha: 'a'.repeat(73) },
    { email: usuarioAtivo.email, senha: 'é'.repeat(37) },
  ];
  for (const body of casos) {
    const { passaporte, chamadas } = criarCenario();
    assert.equal(await autenticar(passaporte, body), false);
    assert.equal(chamadas.buscas.length, 0);
  }
  const { passaporte, chamadas } = criarCenario();
  assert.equal(await autenticar(passaporte, {}, { email: usuarioAtivo.email, senha: 'senha na URL' }), false);
  assert.equal(chamadas.buscas.length, 0);
});

test('a comparação bcrypt real preserva espaços e Unicode da senha', async () => {
  const senha = '  senha com acentuação  ';
  const senhaHash = await bcrypt.hash(senha, 4);
  const passaporte = criarPassaporte({
    obterUsuario: () => ({ scope() { return this; }, async findOne() { return { ...usuarioAtivo, senhaHash }; } }),
  });
  assert.equal((await autenticar(passaporte, { email: usuarioAtivo.email, senha })).id, 1);
  assert.equal(await autenticar(passaporte, { email: usuarioAtivo.email, senha: senha.trim() }), false);
});

test('serializa somente id e sessionVersion, incluindo zero como versão válida', async () => {
  const { passaporte } = criarCenario();
  assert.deepEqual(await serializar(passaporte, usuarioAtivo), { id: 1, sessionVersion: 0 });
  assert.deepEqual(await serializar(passaporte, { ...usuarioAtivo, sessionVersion: 4 }), { id: 1, sessionVersion: 4 });
  for (const alteracao of [{ id: 0 }, { id: '1' }, { sessionVersion: -1 }, { sessionVersion: undefined }]) {
    await assert.rejects(serializar(passaporte, { ...usuarioAtivo, ...alteracao }), { codigo: 'UNAUTHORIZED' });
  }
});

test('desserializa com estado e perfil atuais, sem consultar o hash', async () => {
  const { passaporte, chamadas } = criarCenario({ usuario: { ...usuarioAtivo, perfil: 'ADMIN_CLUBE', nome: 'Nome atual' } });
  const usuario = await desserializar(passaporte, { id: 1, sessionVersion: 0 });
  assert.equal(usuario.perfil, 'ADMIN_CLUBE');
  assert.equal(usuario.nome, 'Nome atual');
  assert.equal(Object.hasOwn(usuario, 'senhaHash'), false);
  assert.deepEqual(chamadas.atuais, [{
    id: 1, opcoes: { attributes: ['id', 'nome', 'email', 'perfil', 'situacao', 'sessionVersion'] },
  }]);
  assert.deepEqual(chamadas.scopes, []);
});

test('sessões legadas, versão ausente ou inválida são invalidadas antes da consulta', async () => {
  const { passaporte, chamadas } = criarCenario();
  for (const sessao of [1, {}, { id: 1 }, { id: 1, sessionVersion: null }, { id: 1, sessionVersion: -1 },
    { id: 1, sessionVersion: '0' }, { id: 0, sessionVersion: 0 },
    Object.create({ id: 1, sessionVersion: 0 })]) {
    assert.equal(await desserializar(passaporte, sessao), false);
  }
  assert.equal(chamadas.atuais.length, 0);
});

test('versão divergente, conta removida ou inativa invalidam a sessão', async () => {
  for (const usuario of [null, { ...usuarioAtivo, sessionVersion: 1 },
    { ...usuarioAtivo, situacao: 'PENDENTE' }, { ...usuarioAtivo, situacao: 'INATIVO' },
    { ...usuarioAtivo, perfil: 'INVALIDO' }, { ...usuarioAtivo, sessionVersion: undefined }]) {
    const { passaporte } = criarCenario({ usuario });
    assert.equal(await desserializar(passaporte, { id: 1, sessionVersion: 0 }), false);
  }
});

test('falhas operacionais de autenticação e desserialização retornam somente erro seguro', async () => {
  const { passaporte } = criarCenario({ erroBanco: new Error('SQL SELECT senha_hash; postgresql://credencial:segredo@host/banco') });
  for (const operacao of [() => autenticar(passaporte), () => desserializar(passaporte, { id: 1, sessionVersion: 0 })]) {
    await assert.rejects(operacao, (erro) => {
      assert.equal(erro.codigo, 'SERVICE_UNAVAILABLE');
      assert.equal(erro.status, 503);
      assert.doesNotMatch(erro.message, /SQL|senha|postgresql|credencial|segredo/);
      return true;
    });
  }
});
