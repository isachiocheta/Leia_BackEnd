'use strict';

const express = require('express');
const { body } = require('express-validator');
const { protegerRota } = require('../autenticacao/rotas');
const { validarCorpoVazio } = require('../validacao/corpo-vazio');
const { responderDetalhe, responderLista } = require('../utilitarios/respostas');
const { validarIdPositivo, validarRequisicao, rejeitarCamposDesconhecidos, rejeitarPatchVazio, selecionarCamposPermitidos } = require('../validacao/requisicao');
const servico = require('../servicos/participacoes');

function criarRotasParticipacoesCiclo({ obterConexao, agora = Date.now }) {
  const roteador = express.Router();
  const semConsulta = rejeitarCamposDesconhecidos([], { local: 'query' });
  roteador.post('/:id/participacoes', ...protegerRota('LEITOR'), validarIdPositivo(), semConsulta, validarCorpoVazio, validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      responderDetalhe(resposta, await servico.aderirAoCiclo(id, requisicao.user, obterConexao(), { agora }), 201);
    });
  roteador.get('/:id/minha-participacao', ...protegerRota('ADMIN_CLUBE', 'LEITOR'), validarIdPositivo(), semConsulta, validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      responderDetalhe(resposta, await servico.consultarMinhaParticipacao(id, requisicao.user.id, obterConexao()));
    });
  roteador.patch('/:id/meu-progresso', ...protegerRota('LEITOR'), validarIdPositivo(), semConsulta,
    rejeitarCamposDesconhecidos(['paginaAtual']), rejeitarPatchVazio(['paginaAtual']),
    body('paginaAtual').custom((valor) => Number.isInteger(valor) && valor >= 0 && valor <= 2147483647), validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      const { paginaAtual } = selecionarCamposPermitidos(requisicao, ['paginaAtual']);
      responderDetalhe(resposta, await servico.atualizarProgresso(id, requisicao.user, paginaAtual, obterConexao(), { agora }));
    });
  roteador.get('/:id/participantes', ...protegerRota('ADMIN_CLUBE'), validarIdPositivo(),
    rejeitarCamposDesconhecidos(['page', 'pageSize'], { local: 'query' }), validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      const resultado = await servico.listarParticipantes(id, requisicao.query, obterConexao());
      responderLista(resposta, resultado.data, resultado.meta);
    });
  return roteador;
}

function criarRotasMinhasParticipacoes({ obterConexao }) {
  const roteador = express.Router();
  roteador.get('/', ...protegerRota('ADMIN_CLUBE', 'LEITOR'), rejeitarCamposDesconhecidos(['page', 'pageSize'], { local: 'query' }),
    async (requisicao, resposta) => {
      const resultado = await servico.listarMinhasParticipacoes(requisicao.user.id, requisicao.query, obterConexao());
      responderLista(resposta, resultado.data, resultado.meta);
    });
  return roteador;
}

module.exports = { criarRotasParticipacoesCiclo, criarRotasMinhasParticipacoes };
