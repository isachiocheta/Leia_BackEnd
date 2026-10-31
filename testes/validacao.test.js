'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { body, query, oneOf, checkExact } = require('express-validator');
const { MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const {
  validarIdPositivo, validarDataCivil, validarRequisicao,
  rejeitarCamposDesconhecidos, rejeitarPatchVazio, selecionarCamposPermitidos,
} = require('../validacao/requisicao');

function executar(intermediario, requisicao) {
  let erro;
  let chamadas = 0;
  intermediario(requisicao, {}, (recebido) => { erro = recebido; chamadas += 1; });
  assert.equal(chamadas, 1);
  return erro;
}

test('IDs positivos canônicos são convertidos somente após validação', async () => {
  for (const valor of ['1', '42', '2147483647']) {
    const requisicao = { params: { id: valor } };
    await validarIdPositivo().run(requisicao);
    assert.equal(executar(validarRequisicao, requisicao), undefined);
    assert.deepEqual(selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' }), { id: Number(valor) });
  }
});

test('IDs inválidos rejeitam zero, prefixos, frações, expoentes, overflow e SQL', async () => {
  for (const valor of [undefined, null, 1, '', '0', '-1', '01', '+1', ' 1', '1 ', '1.5', '1e3', '2147483648', '999999999999999999999', '1 OR 1=1']) {
    const requisicao = { params: { id: valor } };
    await validarIdPositivo().run(requisicao);
    const erro = executar(validarRequisicao, requisicao);
    assert.equal(erro.status, 422);
    assert.deepEqual(erro.fields, [{ field: 'id', message: MENSAGENS_CAMPOS.INVALID_ID }]);
    assert.deepEqual(selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' }), {});
    assert.equal(requisicao.params.id, valor);
  }
});

test('IDs no corpo aceitam inteiros JSON sem coerção de booleanos ou objetos', async () => {
  for (const id of [1, 7, 2147483647, '7']) {
    const requisicao = { body: { id } };
    await validarIdPositivo('id', 'body').run(requisicao);
    assert.equal(executar(validarRequisicao, requisicao), undefined);
    assert.deepEqual(selecionarCamposPermitidos(requisicao, ['id']), { id: Number(id) });
  }
  for (const id of [0, -1, 0.5, 2147483648, Number.MAX_SAFE_INTEGER, Infinity, NaN, true, false, {}, [], null]) {
    const requisicao = { body: { id } };
    await validarIdPositivo('id', 'body').run(requisicao);
    assert.equal(executar(validarRequisicao, requisicao).status, 422);
    assert.deepEqual(selecionarCamposPermitidos(requisicao, ['id']), {});
    assert.equal(requisicao.body.id, id);
  }
});

test('datas civis reais preservam texto e validam anos bissextos sem UTC', async () => {
  const fusoAnterior = process.env.TZ;
  try {
    for (const fuso of ['UTC', 'America/Sao_Paulo', 'Pacific/Kiritimati']) {
      process.env.TZ = fuso;
      for (const data of ['0001-01-01', '2000-02-29', '2024-02-29', '2018-11-04', '2026-10-31', '9999-12-31']) {
        const requisicao = { body: { data } };
        await validarDataCivil('data').run(requisicao);
        assert.equal(executar(validarRequisicao, requisicao), undefined);
        assert.deepEqual(selecionarCamposPermitidos(requisicao, ['data']), { data });
      }
    }
  } finally {
    if (fusoAnterior === undefined) delete process.env.TZ;
    else process.env.TZ = fusoAnterior;
  }
});

test('datas civis rejeitam dias inexistentes e formatos que tragam hora ou fuso', async () => {
  for (const data of [undefined, null, '', 20261031, '0000-01-01', '1900-02-29', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-1-01', '31/10/2026', '2026-10-31T00:00:00Z', ' 2026-10-31']) {
    const requisicao = { body: { data } };
    await validarDataCivil('data').run(requisicao);
    assert.deepEqual(executar(validarRequisicao, requisicao).fields, [
      { field: 'data', message: MENSAGENS_CAMPOS.INVALID_DATE },
    ]);
  }
});

test('data opcional permite ausência, mas não trata null ou vazio como data válida', async () => {
  const ausente = { body: {} };
  await validarDataCivil('data', { opcional: true }).run(ausente);
  assert.equal(executar(validarRequisicao, ausente), undefined);
  assert.deepEqual(selecionarCamposPermitidos(ausente, ['data']), {});
  for (const data of [null, '']) {
    const requisicao = { body: { data } };
    await validarDataCivil('data', { opcional: true }).run(requisicao);
    assert.equal(executar(validarRequisicao, requisicao).status, 422);
  }
});

test('campos desconhecidos são recusados sem ecoar valores ou nomes arbitrários', () => {
  const verificar = rejeitarCamposDesconhecidos(['nome']);
  assert.equal(executar(verificar, { body: { nome: 'Leitora' } }), undefined);
  assert.equal(executar(verificar, { body: {} }), undefined);
  for (const campo of ['perfil', 'sessionVersion', 'senhaHash', 'SELECT senha_reservada FROM usuarios']) {
    const erro = executar(verificar, { body: { nome: 'Leitora', [campo]: 'senha_reservada' } });
    assert.equal(erro.status, 422);
    assert.deepEqual(erro.fields, [{ field: 'body', message: MENSAGENS_CAMPOS.UNKNOWN_FIELDS }]);
    assert.doesNotMatch(JSON.stringify(erro), /senha_reservada|SELECT/);
  }
});

test('entrada JSON precisa ser objeto simples, rejeitando arrays, escalares e protótipos externos', () => {
  for (const entrada of [undefined, null, [], '', 42, false, new Date(), Object.create({ perfil: 'ADMIN_CLUBE' })]) {
    const erro = executar(rejeitarCamposDesconhecidos(['nome']), { body: entrada });
    assert.equal(erro.status, 400);
    assert.equal(erro.codigo, 'BAD_REQUEST');
  }
  const entrada = Object.assign(Object.create(null), { nome: 'Leitora' });
  assert.equal(executar(rejeitarCamposDesconhecidos(['nome']), { body: entrada }), undefined);
});

test('PATCH vazio não é preenchido por campos não permitidos', () => {
  const verificar = rejeitarPatchVazio(['nome', 'descricao']);
  for (const entrada of [{}, { perfil: 'ADMIN_CLUBE' }]) {
    const erro = executar(verificar, { method: 'PATCH', body: entrada });
    assert.equal(erro.status, 422);
    assert.deepEqual(erro.fields, [{ field: 'body', message: MENSAGENS_CAMPOS.EMPTY_PATCH }]);
  }
  for (const descricao of [0, false, null, '']) {
    assert.equal(executar(verificar, { method: 'PATCH', body: { descricao } }), undefined);
  }
  assert.equal(executar(verificar, { method: 'GET' }), undefined);
});

test('seleção exige campo validado e permitido, sem alterar entrada ou senha', async () => {
  const senha = '  senha fornecida sem transformação  ';
  const requisicao = { body: { nome: 'Leitora', perfil: 'ADMIN_CLUBE', senha, extra: 'ignorado' } };
  await body('nome').isString().run(requisicao);
  await body('perfil').isIn(['ADMIN_CLUBE']).run(requisicao);

  const selecionados = selecionarCamposPermitidos(requisicao, ['nome', 'senha']);
  assert.deepEqual(selecionados, { nome: 'Leitora' });
  assert.notEqual(selecionados, requisicao.body);
  assert.equal(requisicao.body.perfil, 'ADMIN_CLUBE');
  assert.equal(requisicao.body.senha, senha);

  await body('senha').isString().run(requisicao);
  assert.deepEqual(selecionarCamposPermitidos(requisicao, ['senha']), { senha });
});

test('campos inválidos não entram na seleção mesmo quando permitidos', async () => {
  const requisicao = { body: { nome: 'Leitora', paginaAtual: -1 } };
  await body('nome').isString().run(requisicao);
  await body('paginaAtual').isInt({ min: 0 }).run(requisicao);
  assert.deepEqual(selecionarCamposPermitidos(requisicao, ['nome', 'paginaAtual']), { nome: 'Leitora' });
});

test('seleção e rejeição de extras respeitam a localização da entrada', async () => {
  const requisicao = { body: { nome: 'Leitora' }, query: { page: '2' } };
  await body('nome').isString().run(requisicao);
  await query('page').isInt({ min: 1 }).toInt().run(requisicao);
  assert.equal(executar(rejeitarCamposDesconhecidos(['page'], { local: 'query' }), requisicao), undefined);
  assert.deepEqual(selecionarCamposPermitidos(requisicao, ['page'], { local: 'query' }), { page: 2 });
  assert.deepEqual(selecionarCamposPermitidos(requisicao, ['page']), {});
});

test('prototype pollution e configurações inseguras não contornam a seleção', async () => {
  for (const campo of ['__proto__', 'constructor', 'prototype']) {
    const requisicao = { body: JSON.parse(`{"nome":"Leitora","${campo}":{"poluido":true}}`) };
    assert.equal(executar(rejeitarCamposDesconhecidos(['nome']), requisicao).status, 422);
    assert.throws(() => rejeitarCamposDesconhecidos([campo]), TypeError);
    await body('nome').isString().run(requisicao);
    assert.deepEqual(selecionarCamposPermitidos(requisicao, ['nome']), { nome: 'Leitora' });
  }
  assert.equal({}.poluido, undefined);
  assert.throws(() => selecionarCamposPermitidos({}, ['nome'], { local: 'cookies' }), TypeError);
});

test('mensagens dinâmicas de validação nunca expõem senha, credenciais ou SQL', async () => {
  const segredo = 'postgresql://usuario:senha_reservada@host/banco SELECT senha';
  const requisicao = { body: { senha: segredo } };
  await body('senha').custom(() => false).withMessage((valor) => `Detalhe interno: ${valor}`).run(requisicao);
  const erro = executar(validarRequisicao, requisicao);
  assert.deepEqual(erro.fields, [{ field: 'senha', message: MENSAGENS_CAMPOS.INVALID_VALUE }]);
  assert.doesNotMatch(JSON.stringify(erro), /senha_reservada|postgresql|SELECT|Detalhe interno/);
  assert.equal(Object.hasOwn(erro.fields[0], 'value'), false);
});

test('erros compostos e campos desconhecidos do express-validator não expõem valores', async () => {
  const requisicao = { body: { segredo: 'senha_reservada' } };
  await oneOf([body('a').equals('ok'), body('b').equals('ok')], {
    message: 'SQL interno com senha_reservada',
  }).run(requisicao);
  const erro = executar(validarRequisicao, requisicao);
  assert.deepEqual(erro.fields, [{ field: 'body', message: MENSAGENS_CAMPOS.INVALID_VALUE }]);
  assert.doesNotMatch(JSON.stringify(erro), /SQL|senha_reservada/);

  const extras = { body: { segredo: 'senha_reservada' } };
  await checkExact([], { locations: ['body'] }).run(extras);
  assert.deepEqual(executar(validarRequisicao, extras).fields, [
    { field: 'body', message: MENSAGENS_CAMPOS.UNKNOWN_FIELDS },
  ]);
});
