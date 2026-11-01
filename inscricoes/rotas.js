'use strict';

const express = require('express');
const { query } = require('express-validator');
const { protegerRota } = require('../autenticacao/rotas');
const { validarCorpoVazio } = require('../validacao/corpo-vazio');
const { validarIdPositivo, validarRequisicao, rejeitarCamposDesconhecidos, selecionarCamposPermitidos } = require('../validacao/requisicao');
const { responderDetalhe, responderLista, responderSemConteudo } = require('../utilitarios/respostas');
const servico = require('../servicos/inscricoes');

function criarRotasInscricoesEncontro({ obterConexao, agora = Date.now }) {
  const roteador = express.Router();
  const semConsulta = rejeitarCamposDesconhecidos([], { local: 'query' });
  const validarMutacao = [validarIdPositivo(), semConsulta, validarCorpoVazio, validarRequisicao];
  roteador.post('/:id/inscricoes', ...protegerRota('LEITOR'), ...validarMutacao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    responderDetalhe(resposta, await servico.inscreverNoEncontro(id, requisicao.user, obterConexao(), { agora }), 201);
  });
  roteador.delete('/:id/minha-inscricao', ...protegerRota('LEITOR'), ...validarMutacao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    await servico.cancelarMinhaInscricao(id, requisicao.user, obterConexao(), { agora });
    responderSemConteudo(resposta);
  });
  roteador.get('/:id/inscritos', ...protegerRota('ADMIN_CLUBE'), validarIdPositivo(), rejeitarCamposDesconhecidos(['page', 'pageSize'], { local: 'query' }), validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      const resultado = await servico.listarInscritos(id, requisicao.query, obterConexao());
      responderLista(resposta, resultado.data, resultado.meta);
    });
  return roteador;
}

function criarRotasMinhasInscricoes({ obterConexao, agora = Date.now }) {
  const roteador = express.Router();
  roteador.get('/', ...protegerRota('ADMIN_CLUBE', 'LEITOR'), rejeitarCamposDesconhecidos(['page', 'pageSize', 'futuros'], { local: 'query' }),
    query('futuros').optional().isString().bail().isIn(['true', 'false']), validarRequisicao,
    async (requisicao, resposta) => {
      const resultado = await servico.listarMinhasInscricoes(requisicao.user.id, requisicao.query, obterConexao(), { agora });
      responderLista(resposta, resultado.data, resultado.meta);
    });
  return roteador;
}

module.exports = { criarRotasInscricoesEncontro, criarRotasMinhasInscricoes };
