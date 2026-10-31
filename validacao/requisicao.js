'use strict';

const { body, param, query, matchedData, validationResult } = require('express-validator');
const { ErroAplicacao, MENSAGENS_CAMPOS } = require('../utilitarios/erro-aplicacao');

const seletores = Object.freeze({ body, params: param, query });
const camposProibidos = new Set(['__proto__', 'prototype', 'constructor']);

function seletor(local) {
  if (!Object.hasOwn(seletores, local)) throw new TypeError('Local de validação inválido.');
  return seletores[local];
}

function camposPermitidos(campos) {
  if (!Array.isArray(campos) || campos.some((campo) => (
    typeof campo !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(campo) || camposProibidos.has(campo)
  ))) {
    throw new TypeError('Informe uma lista interna de campos permitidos.');
  }
  return new Set(campos);
}

function objetoDeEntrada(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    && [Object.prototype, null].includes(Object.getPrototypeOf(valor));
}

function campoSeguro(campo) {
  return typeof campo === 'string' && campo.length <= 120
    && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*|\[\d+\])*$/.test(campo)
    ? campo : 'body';
}

function erroDeCampo(campo, codigo) {
  return new ErroAplicacao('VALIDATION_ERROR', {
    fields: [{ field: campo, message: MENSAGENS_CAMPOS[codigo] }],
  });
}

function validarIdPositivo(campo = 'id', local = 'params') {
  return seletor(local)(campo).custom((valor) => {
    if (local === 'body' && typeof valor === 'number') {
      return Number.isInteger(valor) && valor > 0 && valor <= 2147483647;
    }
    return typeof valor === 'string' && /^[1-9]\d*$/.test(valor)
      && Number.isSafeInteger(Number(valor)) && Number(valor) <= 2147483647;
  }).withMessage('INVALID_ID').bail().toInt();
}

function dataCivilReal(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [ano, mes, dia] = valor.split('-').map(Number);
  if (ano < 1 || mes < 1 || mes > 12 || dia < 1) return false;
  const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0);
  const diasPorMes = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dia <= diasPorMes[mes - 1];
}

function validarDataCivil(campo, { opcional = false, local = 'body' } = {}) {
  const regra = seletor(local)(campo);
  if (opcional) regra.optional();
  // A data civil é validada e preservada como texto; não há conversão Date/UTC.
  return regra.custom(dataCivilReal).withMessage('INVALID_DATE');
}

function validarRequisicao(requisicao, resposta, proximo) {
  const resultado = validationResult(requisicao);
  if (resultado.isEmpty()) return proximo();

  const fields = resultado.array({ onlyFirstError: true }).slice(0, 50).map((erro) => {
    if (erro.type !== 'field') {
      return {
        field: 'body',
        message: erro.type === 'unknown_fields' ? MENSAGENS_CAMPOS.UNKNOWN_FIELDS : MENSAGENS_CAMPOS.INVALID_VALUE,
      };
    }
    // Mensagens dinâmicas e values do express-validator não são dados públicos.
    const codigo = typeof erro.msg === 'string' && Object.hasOwn(MENSAGENS_CAMPOS, erro.msg)
      ? erro.msg : 'INVALID_VALUE';
    return { field: campoSeguro(erro.path), message: MENSAGENS_CAMPOS[codigo] };
  });

  return proximo(new ErroAplicacao('VALIDATION_ERROR', { fields }));
}

function rejeitarCamposDesconhecidos(campos, { local = 'body' } = {}) {
  seletor(local);
  const permitidos = camposPermitidos(campos);
  return (requisicao, resposta, proximo) => {
    const entrada = requisicao[local];
    if (!objetoDeEntrada(entrada)) return proximo(new ErroAplicacao('BAD_REQUEST'));
    if (Object.keys(entrada).some((campo) => !permitidos.has(campo) || camposProibidos.has(campo))) {
      // Não ecoa nomes arbitrários, pois também podem carregar dados sensíveis.
      return proximo(erroDeCampo(local, 'UNKNOWN_FIELDS'));
    }
    return proximo();
  };
}

function rejeitarPatchVazio(campos) {
  const permitidos = camposPermitidos(campos);
  return (requisicao, resposta, proximo) => {
    if (requisicao.method !== 'PATCH') return proximo();
    if (!objetoDeEntrada(requisicao.body)) return proximo(new ErroAplicacao('BAD_REQUEST'));
    if (![...permitidos].some((campo) => Object.hasOwn(requisicao.body, campo))) {
      return proximo(erroDeCampo('body', 'EMPTY_PATCH'));
    }
    return proximo();
  };
}

function selecionarCamposPermitidos(requisicao, campos, { local = 'body' } = {}) {
  seletor(local);
  const permitidos = camposPermitidos(campos);
  const validados = matchedData(requisicao, { locations: [local], onlyValidData: true });
  const selecionados = {};
  for (const campo of permitidos) {
    if (Object.hasOwn(validados, campo)) selecionados[campo] = validados[campo];
  }
  return selecionados;
}

module.exports = {
  validarIdPositivo,
  validarDataCivil,
  validarRequisicao,
  rejeitarCamposDesconhecidos,
  rejeitarPatchVazio,
  selecionarCamposPermitidos,
};
