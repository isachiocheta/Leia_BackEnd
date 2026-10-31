'use strict';

const express = require('express');
const { body, query } = require('express-validator');
const { protegerRota } = require('../autenticacao/rotas');
const { listarLeitores, alterarSituacaoLeitor, SITUACOES } = require('../servicos/usuarios');
const { responderDetalhe, responderLista } = require('../utilitarios/respostas');
const {
  validarIdPositivo, validarRequisicao, rejeitarCamposDesconhecidos,
  rejeitarPatchVazio, selecionarCamposPermitidos,
} = require('../validacao/requisicao');

function criarRotasUsuarios({ obterUsuario }) {
  const roteador = express.Router();
  roteador.use(...protegerRota('ADMIN_CLUBE'));
  roteador.get('/',
    rejeitarCamposDesconhecidos(['page', 'pageSize', 'sort', 'direction', 'situacao'], { local: 'query' }),
    query('situacao').optional().isString().bail().isIn(SITUACOES),
    validarRequisicao,
    async (requisicao, resposta) => {
      const resultado = await listarLeitores(requisicao.query, obterUsuario());
      responderLista(resposta, resultado.data, resultado.meta);
    });
  roteador.patch('/:id/situacao',
    rejeitarCamposDesconhecidos(['situacao']),
    rejeitarPatchVazio(['situacao']),
    validarIdPositivo(),
    body('situacao').isString().bail().isIn(SITUACOES),
    validarRequisicao,
    async (requisicao, resposta) => {
      const { situacao } = selecionarCamposPermitidos(requisicao, ['situacao']);
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      responderDetalhe(resposta, await alterarSituacaoLeitor(id, situacao, obterUsuario()));
    });
  return roteador;
}

module.exports = { criarRotasUsuarios };
