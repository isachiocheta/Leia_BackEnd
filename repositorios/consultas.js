'use strict';

const { QueryTypes } = require('sequelize');
const { carregarConsulta } = require('../database/consultas/carregar');

function validarId(valor) {
  if (!Number.isInteger(valor) || valor < 1 || valor > 2147483647) throw new TypeError('Informe um identificador inteiro positivo.');
}

function paginar({ limit = 12, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError('Paginação de repositório inválida.');
  }
  return { limite: limit, deslocamento: offset };
}

function executarConsulta(nome, conexao, bind, { transaction } = {}) {
  return conexao.query(carregarConsulta(nome), { type: QueryTypes.SELECT, bind, transaction });
}

module.exports = { executarConsulta, validarId, paginar };
