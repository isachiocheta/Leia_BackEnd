'use strict';

const express = require('express');
const { body, query } = require('express-validator');
const { exigirAutenticacao, exigirPerfil } = require('../autenticacao/rotas');
const { protegerCsrf } = require('../autenticacao/csrf');
const { responderDetalhe, responderLista, responderSemConteudo } = require('../utilitarios/respostas');
const { validarIdPositivo, validarDataCivil, validarRequisicao, rejeitarCamposDesconhecidos, rejeitarPatchVazio, selecionarCamposPermitidos } = require('../validacao/requisicao');
const servico = require('../servicos/ciclos');

function regrasCiclo(parcial = false) {
  const nome = body('nome').isString().bail().trim().isLength({ min: 1, max: 120 });
  const livroId = validarIdPositivo('livroId', 'body');
  if (parcial) { nome.optional(); livroId.optional(); }
  return [nome, livroId,
    validarDataCivil('dataInicio', { opcional: parcial }), validarDataCivil('dataFim', { opcional: parcial }),
    body('orientacoes').optional().custom((valor) => valor === null || (typeof valor === 'string' && Array.from(valor).length <= 2000)),
  ];
}

function criarRotasCiclos({ obterConexao, agora = Date.now }) {
  const roteador = express.Router();
  roteador.use(exigirAutenticacao, exigirPerfil('ADMIN_CLUBE', 'LEITOR'));
  const escrita = [exigirPerfil('ADMIN_CLUBE'), protegerCsrf];
  roteador.get('/',
    rejeitarCamposDesconhecidos(['q', 'situacao', 'sort', 'direction', 'page', 'pageSize'], { local: 'query' }),
    query('q').optional().isString().bail().trim().isLength({ min: 1, max: 120 }),
    query('situacao').optional().isString().bail().isIn(servico.SITUACOES),
    query('sort').optional().isString().bail().isIn(['nome', 'dataInicio']), validarRequisicao,
    async (requisicao, resposta) => {
      const filtros = selecionarCamposPermitidos(requisicao, ['q', 'situacao'], { local: 'query' });
      const { q, situacao, ...paginacao } = requisicao.query;
      const resultado = await servico.listarCiclos({ ...paginacao, ...filtros }, obterConexao());
      responderLista(resposta, resultado.data, resultado.meta);
    });
  roteador.get('/:id', validarIdPositivo(), validarRequisicao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    responderDetalhe(resposta, await servico.consultarCiclo(id, obterConexao()));
  });
  roteador.post('/', ...escrita, rejeitarCamposDesconhecidos(servico.CAMPOS_CRIACAO), ...regrasCiclo(), validarRequisicao,
    async (requisicao, resposta) => {
      responderDetalhe(resposta, await servico.criarCiclo(selecionarCamposPermitidos(requisicao, servico.CAMPOS_CRIACAO), obterConexao()), 201);
    });
  roteador.patch('/:id', ...escrita, validarIdPositivo(), rejeitarCamposDesconhecidos(servico.CAMPOS_EDICAO), rejeitarPatchVazio(servico.CAMPOS_EDICAO),
    ...regrasCiclo(true), body('situacao').optional().isString().bail().isIn(servico.SITUACOES), validarRequisicao,
    async (requisicao, resposta) => {
      const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
      const dados = selecionarCamposPermitidos(requisicao, servico.CAMPOS_EDICAO);
      responderDetalhe(resposta, await servico.editarCiclo(id, dados, obterConexao(), { agora }));
    });
  roteador.delete('/:id', ...escrita, validarIdPositivo(), validarRequisicao, async (requisicao, resposta) => {
    const { id } = selecionarCamposPermitidos(requisicao, ['id'], { local: 'params' });
    await servico.excluirCiclo(id, obterConexao());
    responderSemConteudo(resposta);
  });
  return roteador;
}

module.exports = { criarRotasCiclos };
