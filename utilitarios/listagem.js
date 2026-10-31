'use strict';

const { ErroAplicacao } = require('./erro-aplicacao');

const camposConsulta = new Set(['page', 'pageSize', 'sort', 'direction']);
const nomesReservados = new Set(['__proto__', 'prototype', 'constructor']);
const identificador = /^[A-Za-z_][A-Za-z0-9_]*$/;

function falhaDeConsulta(field) {
  throw new ErroAplicacao('VALIDATION_ERROR', {
    fields: [{ field, message: 'Valor inválido.' }],
  });
}

function objetoSimples(valor) {
  return valor !== null && typeof valor === 'object' &&
    (Object.getPrototypeOf(valor) === Object.prototype || Object.getPrototypeOf(valor) === null);
}

function validarMapa(mapa, padrao) {
  if (!objetoSimples(mapa) || !Object.hasOwn(mapa, 'id')) {
    throw new ErroAplicacao('INTERNAL_ERROR');
  }

  for (const chave of Reflect.ownKeys(mapa)) {
    const propriedade = Object.getOwnPropertyDescriptor(mapa, chave);
    if (
      typeof chave !== 'string' || !identificador.test(chave) || nomesReservados.has(chave) ||
      !Object.hasOwn(propriedade, 'value') || typeof propriedade.value !== 'string' ||
      !identificador.test(propriedade.value)
    ) {
      throw new ErroAplicacao('INTERNAL_ERROR');
    }
  }

  if (typeof padrao !== 'string' || nomesReservados.has(padrao) || !Object.hasOwn(mapa, padrao)) {
    throw new ErroAplicacao('INTERNAL_ERROR');
  }
}

function lerInteiro(valor, padrao, campo) {
  if (valor === undefined) return padrao;
  if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) falhaDeConsulta(campo);
  const inteiro = Number(valor);
  if (!Number.isSafeInteger(inteiro)) falhaDeConsulta(campo);
  return inteiro;
}

function lerOpcoesListagem(query = {}, mapaOrdenacao, { padrao = 'id' } = {}) {
  validarMapa(mapaOrdenacao, padrao);
  if (!objetoSimples(query)) falhaDeConsulta('query');

  // Este helper é seguro isoladamente: filtros adicionais devem ser validados
  // pelo chamador e separados destes quatro parâmetros de listagem.
  for (const chave of Reflect.ownKeys(query)) {
    if (typeof chave !== 'string' || !camposConsulta.has(chave)) falhaDeConsulta('query');
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(query, chave), 'value')) falhaDeConsulta('query');
  }

  const valorProprio = (campo) => Object.getOwnPropertyDescriptor(query, campo)?.value;
  const page = lerInteiro(valorProprio('page'), 1, 'page');
  const pageSize = lerInteiro(valorProprio('pageSize'), 12, 'pageSize');
  if (pageSize > 50) falhaDeConsulta('pageSize');
  const deslocamento = (BigInt(page) - 1n) * BigInt(pageSize);
  if (deslocamento > BigInt(Number.MAX_SAFE_INTEGER)) falhaDeConsulta('page');

  const sortInformado = valorProprio('sort');
  const sort = sortInformado === undefined ? padrao : sortInformado;
  if (typeof sort !== 'string' || nomesReservados.has(sort) || !Object.hasOwn(mapaOrdenacao, sort)) {
    falhaDeConsulta('sort');
  }
  const directionInformada = valorProprio('direction');
  const direction = directionInformada === undefined ? 'asc' : directionInformada;
  if (direction !== 'asc' && direction !== 'desc') falhaDeConsulta('direction');

  // Somente identificadores do mapa interno chegam ao order do Sequelize.
  // Nenhum valor do cliente é interpolado em SQL ou tratado como nome de coluna.
  const sentido = direction === 'desc' ? 'DESC' : 'ASC';
  const coluna = mapaOrdenacao[sort];
  const order = [[coluna, sentido]];
  if (coluna !== mapaOrdenacao.id) order.push([mapaOrdenacao.id, sentido]);

  return { page, pageSize, limit: pageSize, offset: Number(deslocamento), order };
}

module.exports = { lerOpcoesListagem };
