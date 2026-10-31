'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lerOpcoesListagem } = require('../utilitarios/listagem');

const mapa = Object.freeze({ id: 'id', nome: 'nome', criadoEm: 'criado_em' });

function validarErro(executar, field, codigo = 'VALIDATION_ERROR') {
  assert.throws(executar, (erro) => {
    assert.equal(erro.codigo, codigo);
    if (codigo === 'VALIDATION_ERROR') {
      assert.equal(erro.status, 422);
      assert.deepEqual(erro.fields, [{ field, message: 'Valor inválido.' }]);
    } else {
      assert.equal(erro.status, 500);
    }
    return true;
  });
}

test('listagem usa página 1, doze registros e ordem ascendente por id', () => {
  assert.deepEqual(lerOpcoesListagem({}, mapa), {
    page: 1, pageSize: 12, limit: 12, offset: 0, order: [['id', 'ASC']],
  });
});

test('página e tamanho respeitam valores positivos e o limite de cinquenta', () => {
  assert.deepEqual(lerOpcoesListagem({ page: '3', pageSize: '50' }, mapa), {
    page: 3, pageSize: 50, limit: 50, offset: 100, order: [['id', 'ASC']],
  });
  assert.equal(lerOpcoesListagem({ pageSize: '1' }, mapa).limit, 1);
  validarErro(() => lerOpcoesListagem({ pageSize: '51' }, mapa), 'pageSize');
});

test('rejeita páginas e tamanhos vazios, nulos, não canônicos ou compostos', () => {
  for (const campo of ['page', 'pageSize']) {
    for (const valor of ['', null, '0', '-1', '01', '1.0', '1e3', ' 1', '1 ', '+1', 'Infinity', '1; DROP TABLE usuarios', [], ['1'], {}, 1]) {
      validarErro(() => lerOpcoesListagem({ [campo]: valor }, mapa), campo);
    }
  }
});

test('evita perda de precisão e overflow no cálculo do deslocamento', () => {
  const maiorSeguro = String(Number.MAX_SAFE_INTEGER);
  const permitido = lerOpcoesListagem({ page: maiorSeguro, pageSize: '1' }, mapa);
  assert.equal(permitido.offset, Number.MAX_SAFE_INTEGER - 1);
  validarErro(() => lerOpcoesListagem({ page: maiorSeguro, pageSize: '2' }, mapa), 'page');
  validarErro(() => lerOpcoesListagem({ page: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) }, mapa), 'page');
});

test('ordenação usa exclusivamente o mapa e acrescenta desempate por id', () => {
  assert.deepEqual(lerOpcoesListagem({ sort: 'criadoEm', direction: 'desc' }, mapa).order, [
    ['criado_em', 'DESC'], ['id', 'DESC'],
  ]);
  assert.deepEqual(lerOpcoesListagem({}, mapa, { padrao: 'nome' }).order, [
    ['nome', 'ASC'], ['id', 'ASC'],
  ]);
  assert.deepEqual(lerOpcoesListagem({ sort: 'id', direction: 'desc' }, mapa).order, [['id', 'DESC']]);
  assert.deepEqual(lerOpcoesListagem({ sort: 'codigo' }, { id: 'id', codigo: 'id' }).order, [['id', 'ASC']]);
});

test('bloqueia direção ou coluna não permitida sem expor o conteúdo enviado', () => {
  const ataque = 'senha_reservada; SELECT senha_hash FROM usuarios';
  for (const sort of ['', null, [], {}, 'criado_em', '__proto__', 'prototype', 'constructor', ataque]) {
    validarErro(() => lerOpcoesListagem({ sort }, mapa), 'sort');
  }
  for (const direction of ['', null, [], {}, 'ASC', 'DESC', 'desc NULLS FIRST', ataque]) {
    validarErro(() => lerOpcoesListagem({ direction }, mapa), 'direction');
  }
  assert.throws(() => lerOpcoesListagem({ sort: ataque }, mapa), (erro) => {
    assert.ok(!JSON.stringify({ message: erro.message, fields: erro.fields }).includes(ataque));
    assert.ok(!JSON.stringify(erro.fields).includes('senha_reservada'));
    return true;
  });
});

test('rejeita parâmetros extras e objetos com protótipos ou getters em vez de dados', () => {
  for (const query of [null, [], 'page=1', { perfil: 'ADMIN_CLUBE' }, JSON.parse('{"__proto__":"senha_reservada"}'), Object.create({ page: '2' })]) {
    validarErro(() => lerOpcoesListagem(query, mapa), 'query');
  }
  let acessou = false;
  const consulta = Object.defineProperty({}, 'sort', { get() { acessou = true; return 'nome'; } });
  validarErro(() => lerOpcoesListagem(consulta, mapa), 'query');
  assert.equal(acessou, false);
  const consultaSemPrototipo = Object.assign(Object.create(null), { page: '2' });
  assert.equal(lerOpcoesListagem(consultaSemPrototipo, mapa).offset, 12);
});

test('parâmetros ausentes não são obtidos do Object.prototype', () => {
  const anterior = Object.getOwnPropertyDescriptor(Object.prototype, 'page');
  try {
    Object.defineProperty(Object.prototype, 'page', { value: '9', configurable: true });
    assert.equal(lerOpcoesListagem({}, mapa).page, 1);
  } finally {
    if (anterior) Object.defineProperty(Object.prototype, 'page', anterior);
    else delete Object.prototype.page;
  }
});

test('mapa interno inválido é erro de programação, sem permitir SQL, herança ou objetos', () => {
  for (const mapaInvalido of [
    undefined, null, [], { nome: 'nome' }, { id: 'id; DROP TABLE usuarios' },
    { id: ['id'] }, { id: { literal: 'id' } }, { id: 'id', constructor: 'nome' },
    Object.create({ id: 'id' }),
  ]) {
    validarErro(() => lerOpcoesListagem({}, mapaInvalido), undefined, 'INTERNAL_ERROR');
  }
  validarErro(() => lerOpcoesListagem({}, mapa, { padrao: 'inexistente' }), undefined, 'INTERNAL_ERROR');
  let acessou = false;
  const mapaComGetter = Object.defineProperty({}, 'id', { get() { acessou = true; return 'id'; } });
  validarErro(() => lerOpcoesListagem({}, mapaComGetter), undefined, 'INTERNAL_ERROR');
  assert.equal(acessou, false);
  const mapaSemPrototipo = Object.assign(Object.create(null), { id: 'id', titulo: 'titulo' });
  assert.deepEqual(lerOpcoesListagem({ sort: 'titulo' }, mapaSemPrototipo).order, [['titulo', 'ASC'], ['id', 'ASC']]);
});
