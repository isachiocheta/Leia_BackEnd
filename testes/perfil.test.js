'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const bcrypt = require('bcrypt');
const { alterarNome, alterarSenha } = require('../servicos/perfil');
const { encerrarSessaoAposTrocaSenha } = require('../autenticacao/encerramento-sessao');

const identidade = { id: 7, sessionVersion: 0 };
const dados = { senhaAtual: '  senha atual da fixture  ', novaSenha: '  nova senha da fixture  ' };

function modelSimulado(alteracoes = {}) {
  const chamadas = { consultas: [], gravacoes: [], transacoes: 0, commit: false };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const original = {
    id: 7, nome: 'Leitora', email: 'leitora@escola.example', perfil: 'LEITOR',
    situacao: 'ATIVO', sessionVersion: 0, senhaHash: 'hash-original',
  };
  const atual = alteracoes === null ? null : {
    ...original, ...alteracoes,
    async update(valores, opcoes) { chamadas.gravacoes.push({ valores, opcoes }); Object.assign(this, valores); },
  };
  const Usuario = {
    scope(nome) { assert.equal(nome, 'credenciais'); return this; },
    async findByPk(id, opcoes) {
      chamadas.consultas.push({ id, opcoes });
      return opcoes.transaction ? atual : original;
    },
    sequelize: {
      async transaction(executar) {
        chamadas.transacoes += 1;
        const resultado = await executar(transaction);
        chamadas.commit = true;
        return resultado;
      },
    },
  };
  return { Usuario, original, atual, chamadas, transaction };
}

test('senha incorreta é 422 sem hash novo, transação ou gravação', async (contexto) => {
  const comparar = contexto.mock.method(bcrypt, 'compare', async () => false);
  const hash = contexto.mock.method(bcrypt, 'hash', async () => { throw new Error('Não deveria gerar hash.'); });
  const { Usuario, chamadas } = modelSimulado();
  await assert.rejects(alterarSenha(identidade, dados, Usuario), (erro) => {
    assert.equal(erro.status, 422);
    assert.equal(erro.fields[0].field, 'senhaAtual');
    assert.ok(!JSON.stringify(erro).includes(dados.senhaAtual));
    return true;
  });
  assert.deepEqual(comparar.mock.calls[0].arguments, [dados.senhaAtual, 'hash-original']);
  assert.equal(hash.mock.callCount(), 0);
  assert.equal(chamadas.transacoes, 0);
  assert.equal(chamadas.gravacoes.length, 0);
});

test('hash assíncrono fora do bloqueio e releitura FOR UPDATE precedem gravação atômica e commit', async (contexto) => {
  const { Usuario, chamadas, transaction } = modelSimulado();
  contexto.mock.method(bcrypt, 'compare', async () => true);
  const hash = contexto.mock.method(bcrypt, 'hash', async () => {
    assert.equal(chamadas.transacoes, 0);
    return 'novo-hash-fixture';
  });
  const resultado = await alterarSenha(identidade, dados, Usuario);
  assert.deepEqual(hash.mock.calls[0].arguments, [dados.novaSenha, 12]);
  assert.deepEqual(chamadas.consultas.map((consulta) => consulta.id), [identidade.id, identidade.id]);
  assert.equal(chamadas.consultas[0].opcoes.transaction, undefined);
  assert.equal(chamadas.consultas[1].opcoes.transaction, transaction);
  assert.equal(chamadas.consultas[1].opcoes.lock, transaction.LOCK.UPDATE);
  assert.deepEqual(chamadas.gravacoes, [{
    valores: { senhaHash: 'novo-hash-fixture', sessionVersion: 1 },
    opcoes: { fields: ['senhaHash', 'sessionVersion'], transaction },
  }]);
  assert.equal(chamadas.commit, true);
  assert.deepEqual(resultado, { reauthenticate: true });
});

test('releitura recusa mudanças concorrentes de hash, versão e situação, sem sobrescrever', async (contexto) => {
  contexto.mock.method(bcrypt, 'compare', async () => true);
  contexto.mock.method(bcrypt, 'hash', async () => 'novo-hash-fixture');
  for (const [mudanca, status] of [
    [{ senhaHash: 'hash-de-outro-escritor' }, 409], [{ sessionVersion: 1 }, 409],
    [{ situacao: 'INATIVO' }, 401], [{ situacao: 'PENDENTE' }, 401], [null, 401],
  ]) {
    const { Usuario, chamadas } = modelSimulado(mudanca);
    await assert.rejects(alterarSenha(identidade, dados, Usuario), (erro) => erro.status === status);
    assert.equal(chamadas.transacoes, 1);
    assert.equal(chamadas.commit, false);
    assert.equal(chamadas.gravacoes.length, 0);
  }
});

test('sessão ultrapassada é recusada antes de comparar ou gerar hash', async (contexto) => {
  const comparar = contexto.mock.method(bcrypt, 'compare', async () => true);
  const hash = contexto.mock.method(bcrypt, 'hash', async () => 'novo-hash-fixture');
  const { Usuario, original, chamadas } = modelSimulado();
  original.sessionVersion = 1;
  await assert.rejects(alterarSenha(identidade, dados, Usuario), (erro) => erro.status === 401);
  assert.equal(comparar.mock.callCount(), 0);
  assert.equal(hash.mock.callCount(), 0);
  assert.equal(chamadas.transacoes, 0);
});

test('valida limites antes de acessar banco ou bcrypt, sem transformar senhas', async () => {
  for (const entrada of [
    { ...dados, senhaAtual: 'é'.repeat(37) }, { ...dados, senhaAtual: null },
    { ...dados, novaSenha: 'é'.repeat(37) }, { ...dados, novaSenha: '🙂'.repeat(9) },
  ]) await assert.rejects(alterarSenha(identidade, entrada, {}), (erro) => erro.status === 422);
});

test('nome usa identidade da sessão, atualiza só nome e não revela hash ou versão', async () => {
  const { Usuario, chamadas, transaction } = modelSimulado();
  const resultado = await alterarNome(identidade, 'Nome atualizado', Usuario);
  assert.equal(chamadas.consultas[0].id, identidade.id);
  assert.ok(!chamadas.consultas[0].opcoes.attributes.includes('senhaHash'));
  assert.deepEqual(chamadas.gravacoes, [{
    valores: { nome: 'Nome atualizado' }, opcoes: { fields: ['nome'], transaction },
  }]);
  assert.deepEqual(resultado, {
    id: identidade.id, nome: 'Nome atualizado', email: 'leitora@escola.example', perfil: 'LEITOR', situacao: 'ATIVO',
  });
});

test('falha física após commit limpa cookie e contexto local, sem desfazer ou propagar erro', async (contexto) => {
  const avisos = [];
  contexto.mock.method(console, 'warn', (...argumentos) => avisos.push(argumentos.join(' ')));
  for (const sincrona of [false, true]) {
    const segredo = 'senha-reservada SELECT postgresql://usuario:credencial@host/banco';
    const requisicao = {
      sessionID: 'sid-antigo', user: { id: 7 },
      session: { cookie: { secure: true }, destroy(concluir) {
        if (sincrona) throw new Error(segredo);
        concluir(new Error(segredo));
      } },
    };
    let cookie;
    await encerrarSessaoAposTrocaSenha(requisicao, { clearCookie(nome, opcoes) { cookie = { nome, opcoes }; } });
    assert.equal(requisicao.sessionID, undefined);
    assert.equal(requisicao.session, undefined);
    assert.equal(requisicao.user, undefined);
    assert.deepEqual(cookie, {
      nome: 'leia.sid', opcoes: { path: '/', httpOnly: true, sameSite: 'lax', secure: true },
    });
    assert.ok(avisos.every((aviso) => !aviso.includes(segredo)));
  }
  assert.equal(avisos.length, 2);
});
