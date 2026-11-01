'use strict';

const express = require('express');
const { body, query } = require('express-validator');
const { exigirAutenticacao, exigirPerfil } = require('../autenticacao/rotas');
const { protegerCsrf } = require('../autenticacao/csrf');
const { instanteIsoComOffset } = require('../utilitarios/instantes');
const { responderDetalhe, responderLista, responderSemConteudo } = require('../utilitarios/respostas');
const { validarIdPositivo, validarRequisicao, rejeitarCamposDesconhecidos, rejeitarPatchVazio, selecionarCamposPermitidos } = require('../validacao/requisicao');
const servico = require('../servicos/encontros');
const { criarRotasInscricoesEncontro } = require('../inscricoes/rotas');

function regrasEncontro(parcial = false) {
  const regras = [
    validarIdPositivo('cicloId', 'body'), body('titulo').isString().bail().trim().isLength({ min: 1, max: 120 }),
    body('inicioEm').custom(instanteIsoComOffset), body('local').isString().bail().trim().isLength({ min: 1, max: 180 }),
  ];
  if (parcial) regras.forEach((regra) => regra.optional());
  return [...regras, body('descricao').optional().custom((valor) => valor === null || (typeof valor === 'string' && Array.from(valor).length <= 2000))];
}

function criarRotasEncontros({ obterConexao, agora = Date.now }) {
  const roteador = express.Router();
  roteador.use(exigirAutenticacao, exigirPerfil('ADMIN_CLUBE', 'LEITOR'));
  roteador.use(criarRotasInscricoesEncontro({ obterConexao, agora }));
  const escrita = [exigirPerfil('ADMIN_CLUBE'), protegerCsrf];
  roteador.get('/', rejeitarCamposDesconhecidos(['q', 'cicloId', 'situacao', 'sort', 'direction', 'page', 'pageSize'], { local: 'query' }),
    query('q').optional().isString().bail().trim().isLength({ min: 1, max: 120 }),
    validarIdPositivo('cicloId', 'query').optional(), query('situacao').optional().isString().bail().isIn(servico.SITUACOES),
    query('sort').optional().isString().bail().isIn(['titulo', 'inicioEm']), validarRequisicao,
    async (requisicao, resposta) => {
      const filtros = selecionarCamposPermitidos(requisicao, ['q', 'cicloId', 'situacao'], { local: 'query' });
      const { q, cicloId, situacao, ...paginacao } = requisicao.query;
      const resultado = await servico.listarEncontros({ ...paginacao, ...filtros }, obterConexao());
      responderLista(resposta, resultado.data, resultado.meta);
    });
  roteador.get('/:id', validarIdPositivo(), validarRequisicao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    responderDetalhe(resposta, await servico.consultarEncontro(id, obterConexao()));
  });
  roteador.post('/', ...escrita, rejeitarCamposDesconhecidos(servico.CAMPOS_CRIACAO), ...regrasEncontro(), validarRequisicao,
    async (requisicao, resposta) => responderDetalhe(resposta, await servico.criarEncontro(selecionarCamposPermitidos(requisicao, servico.CAMPOS_CRIACAO), obterConexao(), { agora }), 201));
  roteador.patch('/:id', ...escrita, validarIdPositivo(), rejeitarCamposDesconhecidos(servico.CAMPOS_EDICAO), rejeitarPatchVazio(servico.CAMPOS_EDICAO),
    ...regrasEncontro(true), body('situacao').optional().isString().bail().isIn(servico.SITUACOES), validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      responderDetalhe(resposta, await servico.editarEncontro(id, selecionarCamposPermitidos(requisicao, servico.CAMPOS_EDICAO), obterConexao(), { agora }));
    });
  roteador.delete('/:id', ...escrita, validarIdPositivo(), validarRequisicao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    await servico.excluirEncontro(id, obterConexao());
    responderSemConteudo(resposta);
  });
  return roteador;
}

module.exports = { criarRotasEncontros };
