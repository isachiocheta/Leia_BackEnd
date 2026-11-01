'use strict';

const { rejeitarCamposDesconhecidos } = require('./requisicao');
const { ErroAplicacao } = require('../utilitarios/erro-aplicacao');
const rejeitarCampos = rejeitarCamposDesconhecidos([]);

function validarCorpoVazio(requisicao, resposta, proximo) {
  if (requisicao.body === undefined) {
    if (Number(requisicao.get('Content-Length')) > 0 || requisicao.get('Transfer-Encoding')) return proximo(new ErroAplicacao('BAD_REQUEST'));
    return proximo();
  }
  return rejeitarCampos(requisicao, resposta, proximo);
}

module.exports = { validarCorpoVazio };
