'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Sequelize = require('sequelize');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');
const { exigirRecurso, comContextoPersistencia, traduzirErroPersistencia } = require('../utilitarios/persistencia');
const { rotaNaoEncontrada, tratarErros } = require('../intermediarios/erros');

const segredo = 'senha_reservada_que_nao_pode_aparecer';
const sqlReservado = `SELECT senha_hash FROM usuarios WHERE senha = '${segredo}'`;

function responderErro(erro) {
  const resposta = {
    headersSent: false,
    status(valor) { this.statusCode = valor; return this; },
    json(corpo) { this.corpo = corpo; return this; },
  };
  tratarErros(erro, {}, resposta, () => { throw new Error('Delegação inesperada.'); });
  return resposta;
}

function erroSql(codigo) {
  return Object.assign(new Error(segredo), { code: codigo, sql: sqlReservado });
}

function semDadosInternos(resposta) {
  const texto = JSON.stringify(resposta.corpo);
  assert.ok(!texto.includes(segredo));
  assert.ok(!texto.includes(sqlReservado));
  assert.doesNotMatch(texto, /"(?:sql|stack|value|password|senhaHash|parent|original)"\s*:/);
  assert.deepEqual(Object.keys(resposta.corpo), ['error']);
  assert.equal(typeof resposta.corpo.error.code, 'string');
  assert.equal(typeof resposta.corpo.error.message, 'string');
}

test('catálogo cobre os status solicitados com código e mensagem estáticos', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  for (const [status, codigo] of [
    [400, 'BAD_REQUEST'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'], [409, 'CONFLICT'], [413, 'PAYLOAD_TOO_LARGE'],
    [422, 'VALIDATION_ERROR'], [429, 'TOO_MANY_REQUESTS'], [500, 'INTERNAL_ERROR'],
    [503, 'SERVICE_UNAVAILABLE'],
  ]) {
    const erro = Object.assign(new Error(`${sqlReservado} stack: ${segredo}`), {
      status, code: segredo, sql: sqlReservado, fields: { senha: segredo },
    });
    const resposta = responderErro(erro);
    assert.equal(resposta.statusCode, status);
    assert.equal(resposta.corpo.error.code, codigo);
    assert.equal(resposta.corpo.error.message, new ErroAplicacao(codigo).message);
    assert.deepEqual(Object.keys(resposta.corpo.error), ['code', 'message']);
    semDadosInternos(resposta);
  }
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments, ['Erro interno ao processar requisição.']);
});

test('aceita statusCode seguro e reduz status/código desconhecido a erro interno', (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(responderErro(Object.assign(new Error(segredo), { statusCode: 401 })).statusCode, 401);
  for (const erro of [new Error(segredo), null, segredo, { status: 204 }, { status: 999 }, { status: '403' }]) {
    const resposta = responderErro(erro);
    assert.equal(resposta.statusCode, 500);
    assert.equal(resposta.corpo.error.code, 'INTERNAL_ERROR');
    semDadosInternos(resposta);
  }
  assert.equal(new ErroAplicacao(segredo).codigo, 'INTERNAL_ERROR');
  assert.equal(new ErroAplicacao('__proto__').codigo, 'INTERNAL_ERROR');
});

test('JSON malformado e corpo excessivo recebem códigos específicos sem ecoar o corpo', () => {
  for (const [tipo, status, codigo] of [
    ['entity.parse.failed', 400, 'INVALID_JSON'], ['entity.too.large', 413, 'PAYLOAD_TOO_LARGE'],
  ]) {
    const resposta = responderErro(Object.assign(new Error(segredo), { type: tipo, body: sqlReservado }));
    assert.equal(resposta.statusCode, status);
    assert.equal(resposta.corpo.error.code, codigo);
    semDadosInternos(resposta);
  }
});

test('charset, encoding, corpo abortado ou tamanho inconsistente são erros de cliente seguros', () => {
  for (const [tipo, status] of [
    ['charset.unsupported', 415], ['encoding.unsupported', 415],
    ['request.aborted', 400], ['request.size.invalid', 400],
  ]) {
    const resposta = responderErro(Object.assign(new Error(sqlReservado), {
      type: tipo, status, charset: segredo, encoding: segredo,
      body: { senha: segredo }, value: segredo,
    }));
    assert.equal(resposta.statusCode, 400);
    assert.deepEqual(resposta.corpo, {
      error: { code: 'BAD_REQUEST', message: 'Requisição inválida.' },
    });
    semDadosInternos(resposta);
  }
});

test('fields contém somente caminhos e mensagens permitidos, sem valores recebidos', () => {
  const erro = new ErroAplicacao('VALIDATION_ERROR', {
    fields: [
      { field: 'senhaHash', message: sqlReservado, value: segredo, sql: sqlReservado },
      { field: 'livros[0].nome', message: MENSAGENS_CAMPOS.REQUIRED, value: segredo },
      { field: '__proto__.senha', message: MENSAGENS_CAMPOS.REQUIRED },
      { field: sqlReservado, message: MENSAGENS_CAMPOS.INVALID_VALUE },
      { field: 'senha_hash', message: sqlReservado, value: segredo },
    ],
  });
  const resposta = responderErro(erro);
  assert.deepEqual(resposta.corpo.error.fields, [
    { field: 'senha', message: MENSAGENS_CAMPOS.INVALID_VALUE },
    { field: 'livros[0].nome', message: MENSAGENS_CAMPOS.REQUIRED },
    { field: 'body', message: MENSAGENS_CAMPOS.REQUIRED },
    { field: 'body', message: MENSAGENS_CAMPOS.INVALID_VALUE },
  ]);
  semDadosInternos(resposta);
  const muitos = new ErroAplicacao('VALIDATION_ERROR', {
    fields: Array.from({ length: 100 }, (_, indice) => ({ field: `campo${indice}`, message: MENSAGENS_CAMPOS.INVALID_VALUE })),
  });
  assert.equal(muitos.fields.length, 50);
  assert.equal(new ErroAplicacao('VALIDATION_ERROR', { fields: [] }).fields, undefined);
});

test('reconstrói o catálogo quando um ErroAplicacao foi alterado depois da criação', () => {
  const erro = new ErroAplicacao('VALIDATION_ERROR');
  erro.message = sqlReservado;
  erro.status = 200;
  erro.fields = [{ field: 'senha', message: segredo, value: segredo }];
  const resposta = responderErro(erro);
  assert.equal(resposta.statusCode, 422);
  assert.equal(resposta.corpo.error.message, 'Dados inválidos.');
  semDadosInternos(resposta);
});

test('formato Sequelize corrompido falha fechado com erro interno seguro', (t) => {
  t.mock.method(console, 'error', () => {});
  const erro = new Sequelize.ValidationError(sqlReservado, []);
  erro.errors = sqlReservado;
  let resposta;
  assert.doesNotThrow(() => { resposta = responderErro(erro); });
  assert.equal(resposta.statusCode, 500);
  assert.deepEqual(resposta.corpo, {
    error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor.' },
  });
  semDadosInternos(resposta);
});

test('getters defeituosos no erro não escapam ao handler central nem expõem seus valores', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const propriedade of ['fields', 'codigo', 'type', 'status']) {
    const erro = propriedade === 'status' ? new Error(sqlReservado) : new ErroAplicacao('VALIDATION_ERROR');
    Object.defineProperty(erro, propriedade, {
      get() { throw new Error(`${sqlReservado} value=${segredo}`); },
    });
    let resposta;
    assert.doesNotThrow(() => { resposta = responderErro(erro); });
    assert.equal(resposta.statusCode, 500);
    assert.deepEqual(resposta.corpo, {
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor.' },
    });
    semDadosInternos(resposta);
  }
});

test('rota inexistente usa o mesmo erro de recurso ausente', () => {
  let erro;
  rotaNaoEncontrada({}, {}, (recebido) => { erro = recebido; });
  assert.ok(erro instanceof ErroAplicacao);
  assert.equal(responderErro(erro).statusCode, 404);
});

test('com headers já enviados delega o erro original sem tentar responder', () => {
  const erro = new Error(segredo);
  let delegado;
  tratarErros(erro, {}, {
    headersSent: true,
    status() { assert.fail('Não pode alterar status depois dos headers.'); },
    json() { assert.fail('Não pode escrever outra resposta.'); },
  }, (recebido) => { delegado = recebido; });
  assert.equal(delegado, erro);
});

test('exigirRecurso e EmptyResultError expressam alvo ausente, sem confundir listas vazias', () => {
  for (const valor of [null, undefined]) {
    assert.throws(() => exigirRecurso(valor), (erro) => erro.status === 404 && erro.codigo === 'NOT_FOUND');
  }
  const lista = [];
  assert.equal(exigirRecurso(lista), lista);
  const registro = { id: 1 };
  assert.equal(exigirRecurso(registro), registro);
  const resposta = responderErro(new Sequelize.EmptyResultError(sqlReservado));
  assert.equal(resposta.statusCode, 404);
  semDadosInternos(resposta);
});

test('Sequelize UniqueConstraintError é duplicidade 409 sem campos ou valores conflitantes', () => {
  const erro = new Sequelize.UniqueConstraintError({
    message: sqlReservado, fields: { email: segredo }, parent: erroSql('23505'),
    errors: [new Sequelize.ValidationErrorItem(sqlReservado, 'unique violation', 'email', segredo)],
  });
  const resposta = responderErro(erro);
  assert.equal(resposta.statusCode, 409);
  assert.equal(resposta.corpo.error.code, 'DUPLICATE_RESOURCE');
  assert.equal(resposta.corpo.error.fields, undefined);
  semDadosInternos(resposta);
});

test('Sequelize ValidationError recebe campos seguros sem mensagens ou valores do ORM', () => {
  const erro = new Sequelize.ValidationError(sqlReservado, [
    new Sequelize.ValidationErrorItem(sqlReservado, 'notNull Violation', 'senhaHash', segredo, null, 'is_null'),
    new Sequelize.ValidationErrorItem(sqlReservado, 'Validation error', 'nome', segredo),
  ]);
  const resposta = responderErro(erro);
  assert.equal(resposta.statusCode, 422);
  assert.deepEqual(resposta.corpo.error.fields, [
    { field: 'senha', message: MENSAGENS_CAMPOS.REQUIRED },
    { field: 'nome', message: MENSAGENS_CAMPOS.INVALID_VALUE },
  ]);
  semDadosInternos(resposta);
});

test('FK distingue referência inválida e dependência pelo contexto interno, nunca pelo SQL', async () => {
  const criarErro = (reltype) => new Sequelize.ForeignKeyConstraintError({
    parent: erroSql('23503'), message: sqlReservado, reltype, fields: { senha: segredo }, value: segredo,
  });
  for (const operacao of ['criar', 'atualizar']) {
    await assert.rejects(comContextoPersistencia(operacao, async () => { throw criarErro(); }), (erro) => {
      const resposta = responderErro(erro);
      assert.equal(resposta.statusCode, 422);
      assert.equal(resposta.corpo.error.code, 'INVALID_REFERENCE');
      semDadosInternos(resposta);
      return true;
    });
  }
  await assert.rejects(comContextoPersistencia('excluir', async () => { throw criarErro(); }), (erro) => {
    const resposta = responderErro(erro);
    assert.equal(resposta.statusCode, 409);
    assert.equal(resposta.corpo.error.code, 'RESOURCE_IN_USE');
    semDadosInternos(resposta);
    return true;
  });
  assert.equal(responderErro(criarErro('child')).statusCode, 422);
  assert.equal(responderErro(criarErro('parent')).statusCode, 409);
  assert.equal(await comContextoPersistencia('buscar', async () => 7), 7);
});

test('conexões e timeouts conhecidos retornam indisponibilidade sem credenciais', () => {
  for (const Classe of [
    Sequelize.ConnectionError, Sequelize.ConnectionRefusedError,
    Sequelize.AccessDeniedError, Sequelize.ConnectionAcquireTimeoutError, Sequelize.TimeoutError,
  ]) {
    const resposta = responderErro(new Classe(erroSql('08001')));
    assert.equal(resposta.statusCode, 503);
    assert.equal(resposta.corpo.error.code, 'SERVICE_UNAVAILABLE');
    semDadosInternos(resposta);
  }
});

test('classifica SQLSTATEs de entrada/concorrência/disponibilidade sem parsear mensagens', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [codigos, status] of [
    [['23502', '23514', '22001', '22003', '22007', '22008', '22P02'], 422],
    [['40001', '40P01'], 409],
    [['08001', '53300', '57014', '57P01', '57P02', '57P03'], 503],
    [['42P01', undefined], 500],
  ]) {
    for (const codigo of codigos) {
      const resposta = responderErro(new Sequelize.DatabaseError(erroSql(codigo)));
      assert.equal(resposta.statusCode, status);
      semDadosInternos(resposta);
    }
  }
});

test('erros de versão/exclusão são conflitos, mas um nome Sequelize forjado não é confiado', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const erro of [
    new Sequelize.OptimisticLockError({ message: sqlReservado, values: { senha: segredo } }),
    new Sequelize.ExclusionConstraintError({ message: sqlReservado, fields: { senha: segredo }, parent: erroSql('23P01') }),
  ]) {
    assert.equal(responderErro(erro).statusCode, 409);
  }
  const forjado = Object.assign(new Error(sqlReservado), { name: 'SequelizeUniqueConstraintError' });
  assert.equal(responderErro(forjado).statusCode, 500);
  assert.equal(traduzirErroPersistencia(forjado), forjado);
});
